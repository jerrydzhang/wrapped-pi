// Subagent contracts over the fake ExtensionAPI, real child processes, and a
// fake Pi CLI (fake-pi-cli.mjs) standing in for the relaunched Pi. The fake
// honors the launch contract spawnSubagent relies on (--print --no-session
// --model ... -e ... -- task, stdout = final response only, stderr =
// diagnostics, graceful SIGTERM with detached-descendant cleanup), so the job
// machinery is exercised against real processes end to end.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bashBackground from "../bash-background.ts";
import { fakePi, testCtx, resetRegistry, jobs, groupAlive, waitFor } from "./fake-pi.ts";

const FAKE_CLI = new URL("./fake-pi-cli.mjs", import.meta.url).pathname;
const MODEL = "test/mini";

// Every test's configuration lives in a disposable agent directory pointed at
// by PI_CODING_AGENT_DIR - exactly how the extension resolves the agent dir -
// so the suite never touches the real ~/.pi/agent or its auth.
const agentDirs = [];

after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.WRAPPED_PI_SUBAGENT_MODEL;
	for (const dir of agentDirs) rmSync(dir, { recursive: true, force: true });
});

// Points spawnSubagent's relaunch at the fake CLI: production resolves the
// child from process.execPath + process.argv[1], tests substitute argv[1].
function withFakeCli(fn) {
	return async (t) => {
		const saved = process.argv[1];
		process.argv[1] = FAKE_CLI;
		try {
			await fn(t);
		} finally {
			process.argv[1] = saved;
		}
	};
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function configFile() {
	return join(process.env.PI_CODING_AGENT_DIR, "wrapped-pi.json");
}

function writeConfig(body) {
	writeFileSync(configFile(), body);
}

function fresh(options = {}) {
	resetRegistry();
	delete process.env.WRAPPED_PI_CHILD;
	const dir = options.agentDir ?? mkdtempSync(join(tmpdir(), "sa-agent-"));
	agentDirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
	if (options.config !== undefined) writeConfig(options.config);
	else if (options.model !== null) writeConfig(JSON.stringify({ model: options.model ?? MODEL }));
	if (options.extensionsEnv !== null) process.env.WRAPPED_PI_EXTENSIONS = options.extensionsEnv;
	else delete process.env.WRAPPED_PI_EXTENSIONS;
	const app = fakePi();
	bashBackground(app.handle);
	return app;
}

function factsFile() {
	const dir = mkdtempSync(join(tmpdir(), "sa-facts-"));
	return { dir, path: join(dir, "facts.jsonl") };
}

function readFacts(path) {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line));
	} catch {
		// The child has not booted yet - waitFor polls until it has.
		return [];
	}
}

async function withKeepalive(promise) {
	const keep = setInterval(() => {}, 100);
	try {
		return await promise;
	} finally {
		clearInterval(keep);
	}
}

test("registers subagent alongside the shared wait and stop", () => {
	const app = fresh();
	const subagent = app.subagent();
	assert.equal(subagent.name, "subagent");
	assert.equal(subagent.label, "Launch a subagent");
	assert.ok(subagent.parameters.properties.task, "task param");
	assert.match(subagent.description, /never this conversation/);
	assert.match(subagent.description, /no subagent tool of its own/);
	assert.equal(app.wait().name, "wait");
	assert.equal(app.stop().name, "stop");
});

test("a child session registers no subagent tool, keeping bash/wait/stop", () => {
	const app = fresh();
	assert.ok(app.subagent(), "parent registers subagent");
	process.env.WRAPPED_PI_CHILD = "1";
	try {
		const child = fakePi();
		bashBackground(child.handle);
		assert.equal(child.subagent(), undefined, "no subagent in children - recursion prevention");
		assert.equal(child.bash().name, "bash");
		assert.ok(child.bash().parameters.properties.background, "child keeps background bash");
		assert.equal(child.wait().name, "wait");
		assert.equal(child.stop().name, "stop");
	} finally {
		delete process.env.WRAPPED_PI_CHILD;
	}
});

test("without a configured model the tool refuses before spawning", async () => {
	const app = fresh({ model: null });
	await assert.rejects(
		app.subagent().execute("c1", { task: "SAY:x" }, undefined, undefined, testCtx("/tmp")),
		new RegExp(`No subagent model configured\\. Create ${escapeRegExp(configFile())} containing \\{"model": "provider/model-id"\\}`),
	);
	// The removed environment variable neither configures nor overrides: with
	// it set, a missing file is still a missing file.
	process.env.WRAPPED_PI_SUBAGENT_MODEL = "legacy/env-model";
	await assert.rejects(
		app.subagent().execute("c2", { task: "SAY:x" }, undefined, undefined, testCtx("/tmp")),
		/No subagent model configured\. Create .+wrapped-pi\.json/,
	);
	writeConfig('{"model":"   "}');
	await assert.rejects(
		app.subagent().execute("c3", { task: "SAY:x" }, undefined, undefined, testCtx("/tmp")),
		(it) => {
			assert.match(it.message, /"model" must be a non-empty string .*\(it is blank\)\./);
			assert.match(it.message, new RegExp(escapeRegExp(configFile())));
			return true;
		},
	);
	assert.equal(jobs().length, 0, "nothing armed on refusal");
	assert.equal(app.sent.length, 0);
});

test("a malformed configuration file refuses with the file and cause named", async () => {
	const cases = [
		['{"model":', /not valid JSON/],
		['"just a string"', /expected a JSON object/],
		['[{"model":"m"}]', /expected a JSON object/],
		["{}", /"model" must be a non-empty string.*\(missing or not a string\)\./],
		['{"model": 5}', /"model" must be a non-empty string.*\(missing or not a string\)\./],
	];
	for (const [i, [body, shape]] of cases.entries()) {
		const app = fresh({ config: body });
		await assert.rejects(
			app.subagent().execute(`c${i}`, { task: "SAY:x" }, undefined, undefined, testCtx("/tmp")),
			(it) => {
				assert.match(it.message, shape);
				assert.match(it.message, new RegExp(escapeRegExp(configFile())), "the error names the file");
				return true;
			},
		);
		assert.equal(jobs().length, 0, "nothing armed on refusal");
	}
});

test("an unreadable configuration file refuses with the file named", { skip: process.getuid?.() === 0 && "running as root: permissions not enforceable" }, async () => {
	const app = fresh();
	chmodSync(configFile(), 0o000);
	try {
		await assert.rejects(
			app.subagent().execute("c1", { task: "SAY:x" }, undefined, undefined, testCtx("/tmp")),
			(it) => {
				assert.match(it.message, /Cannot read the subagent configuration .+wrapped-pi\.json \(EACCES\)\./);
				return true;
			},
		);
		assert.equal(jobs().length, 0);
	} finally {
		chmodSync(configFile(), 0o600);
	}
});

test("an empty task is refused", async () => {
	const app = fresh();
	await assert.rejects(app.subagent().execute("c1", { task: "  " }, undefined, undefined, testCtx("/tmp")), /non-empty/);
	assert.equal(jobs().length, 0);
});

test("a missing working directory is a visible error", async () => {
	const app = fresh();
	await assert.rejects(
		withFakeCli(async () => app.subagent().execute("c1", { task: "SAY:x" }, undefined, undefined, testCtx("/nonexistent-cwd-xyz")))(),
		/Working directory does not exist/,
	);
	assert.equal(jobs().length, 0);
});

test(
	"launches the child with print-mode flags, the model, the bundled set, and a clean env",
	withFakeCli(async () => {
		const facts = factsFile();
		try {
			process.env.FAKE_PI_FACTS = facts.path;
			const app = fresh({ extensionsEnv: "/store/first.ts\n\n/store/second.ts\n" });
			await app.subagent().execute("c1", { task: "SAY:hi" }, undefined, undefined, testCtx("/tmp"));
			await waitFor(() => jobs()[0].state === "exited");
			const start = readFacts(facts.path).find((record) => record.kind === "start");
			assert.ok(start, "child recorded its launch");
			assert.deepEqual(start.argv.slice(0, 4), ["--print", "--no-session", "--model", MODEL]);
			assert.deepEqual(start.extensions, ["/store/first.ts", "/store/second.ts"], "blank lines dropped, order kept");
			const separator = start.argv.indexOf("--");
			assert.equal(start.argv[separator + 1], "SAY:hi", "task passed verbatim after --");
			assert.equal(start.cwd, "/tmp", "child runs in the session cwd");
			assert.notEqual(start.cwd, process.cwd(), "the five-argument invocation carries ctx.cwd, not the process cwd");
			assert.equal(start.childMarker, "1", "recursion marker set");
			assert.deepEqual(start.staleSessionEnv, [], "no parent PI_* session state leaks");
			assert.equal(start.extensionsEnv, "/store/first.ts\n\n/store/second.ts\n", "wrapper list inherited untouched");
		} finally {
			delete process.env.FAKE_PI_FACTS;
			rmSync(facts.dir, { recursive: true, force: true });
		}
	}),
);

test(
	"the configuration is read afresh on every launch - edits apply without restarting Pi",
	withFakeCli(async () => {
		const facts = factsFile();
		try {
			process.env.FAKE_PI_FACTS = facts.path;
			const app = fresh();
			await app.subagent().execute("c1", { task: "SAY:first" }, undefined, undefined, testCtx("/tmp"));
			await waitFor(() => jobs()[0].state === "exited");
			// Rewrite the file between launches: unknown keys tolerated, whitespace
			// trimmed - the next launch reads the new value, no restart involved.
			writeConfig('{"model":"  test/other  ","future":true}\n');
			await app.subagent().execute("c2", { task: "SAY:second" }, undefined, undefined, testCtx("/tmp"));
			await waitFor(() => jobs().length === 2 && jobs()[1].state === "exited");
			const starts = readFacts(facts.path).filter((record) => record.kind === "start");
			assert.equal(starts.length, 2);
			assert.equal(starts[0].model, MODEL, "first launch used the file as written");
			assert.equal(starts[1].model, "test/other", "second launch read the rewritten file");
			assert.equal(jobs()[1].model, "test/other", "the job record carries the re-read model");
		} finally {
			delete process.env.FAKE_PI_FACTS;
			rmSync(facts.dir, { recursive: true, force: true });
		}
	}),
);

test(
	"the configuration location follows PI_CODING_AGENT_DIR",
	withFakeCli(async () => {
		const facts = factsFile();
		const dirs = ["a", "b", "c"].map((tag) => mkdtempSync(join(tmpdir(), `sa-agent-${tag}-`)));
		dirs.forEach((dir) => agentDirs.push(dir));
		try {
			process.env.FAKE_PI_FACTS = facts.path;
			writeFileSync(join(dirs[0], "wrapped-pi.json"), JSON.stringify({ model: "a/first" }));
			writeFileSync(join(dirs[1], "wrapped-pi.json"), JSON.stringify({ model: "b/second" }));
			const app = fresh({ agentDir: dirs[0], model: null });
			await app.subagent().execute("c1", { task: "SAY:one" }, undefined, undefined, testCtx("/tmp"));
			await waitFor(() => jobs()[0].state === "exited");
			// Same session, different agent directory: the next launch resolves
			// through the variable, never a cached or default location.
			process.env.PI_CODING_AGENT_DIR = dirs[1];
			await app.subagent().execute("c2", { task: "SAY:two" }, undefined, undefined, testCtx("/tmp"));
			await waitFor(() => jobs()[1].state === "exited");
			// An empty agent directory refuses even though dirA still holds a file.
			process.env.PI_CODING_AGENT_DIR = dirs[2];
			await assert.rejects(
				app.subagent().execute("c3", { task: "SAY:x" }, undefined, undefined, testCtx("/tmp")),
				(it) => {
					assert.match(it.message, new RegExp(escapeRegExp(join(dirs[2], "wrapped-pi.json"))));
					return true;
				},
			);
			const starts = readFacts(facts.path).filter((record) => record.kind === "start");
			assert.deepEqual(starts.map((record) => record.model), ["a/first", "b/second"]);
		} finally {
			delete process.env.FAKE_PI_FACTS;
			rmSync(facts.dir, { recursive: true, force: true });
		}
	}),
);

test(
	"the removed environment variable has no precedence - the file is the only source",
	withFakeCli(async () => {
		const facts = factsFile();
		try {
			process.env.FAKE_PI_FACTS = facts.path;
			process.env.WRAPPED_PI_SUBAGENT_MODEL = "legacy/env-model";
			const app = fresh({ model: "file/model" });
			await app.subagent().execute("c1", { task: "SAY:hi" }, undefined, undefined, testCtx("/tmp"));
			await waitFor(() => jobs()[0].state === "exited");
			const start = readFacts(facts.path).find((record) => record.kind === "start");
			assert.equal(start.model, "file/model", "the file wins; the legacy variable is dead");
			assert.equal(jobs()[0].model, "file/model");
		} finally {
			delete process.env.FAKE_PI_FACTS;
			rmSync(facts.dir, { recursive: true, force: true });
		}
	}),
);

test(
	"without the wrapper list children load ordinary discovery only",
	withFakeCli(async () => {
		const facts = factsFile();
		try {
			process.env.FAKE_PI_FACTS = facts.path;
			const app = fresh({ extensionsEnv: null });
			await app.subagent().execute("c1", { task: "SAY:hi" }, undefined, undefined, testCtx("/tmp"));
			await waitFor(() => jobs()[0].state === "exited");
			const start = readFacts(facts.path).find((record) => record.kind === "start");
			assert.deepEqual(start.extensions, []);
			assert.equal(start.extensionsEnv, null);
		} finally {
			delete process.env.FAKE_PI_FACTS;
			rmSync(facts.dir, { recursive: true, force: true });
		}
	}),
);

test(
	"the armed reply names the handle, task, model, and delivery contract",
	withFakeCli(async () => {
		const app = fresh();
		const out = await app.subagent().execute("c1", { task: "say hi and report" }, undefined, undefined, testCtx("/tmp"));
		const text = out.content[0].text;
		assert.match(text, /^Subagent sa-1 started \(pid \d+\)\./);
		assert.match(text, /Task: say hi and report/);
		assert.match(text, /Model: test\/mini/);
		assert.match(text, /delivered here automatically/);
		assert.match(text, /in-turn by wait/);
		assert.equal(jobs().length, 1);
		assert.equal(jobs()[0].kind, "subagent");
		await app.stop().execute("c2", { id: "sa-1" });
	}),
);

test(
	"an unwaited subagent delivers exactly once: final response, never diagnostics or marker",
	withFakeCli(async () => {
		const app = fresh();
		await app.subagent().execute("c1", { task: "NOISY:the final answer|stderr noise" }, undefined, undefined, testCtx("/tmp"));
		await waitFor(() => app.sent.length === 1);
		const { message, options } = app.sent[0];
		assert.equal(message.customType, "bash-background-result");
		assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
		assert.match(message.content, /^Subagent sa-1 finished, ran [\d.]+s\./);
		assert.match(message.content, /Task: NOISY:the final answer\|stderr noise/);
		assert.match(message.content, /Result:\nthe final answer\n?$/,
		"the result section is exactly the child's stdout");
		assert.doesNotMatch(message.content, /Diagnostics:/, "diagnostics stay out of a successful result");
		assert.doesNotMatch(message.content, /__BASH_BG_EXIT__/, "the exit marker never reaches the model");
		assert.equal(message.details.exitCode, 0);
		assert.ok(message.details.errPath, "diagnostics path preserved in details");
		await new Promise((r) => setTimeout(r, 800));
		assert.equal(app.sent.length, 1, "no duplicate completion");
	}),
);

test(
	"a long result keeps the useful answer - no bash 20-line tail semantics",
	withFakeCli(async () => {
		const app = fresh();
		const lines = Array.from({ length: 60 }, (_, i) => `answer-line-${i}`).join("\n");
		await app.subagent().execute("c1", { task: `SAY:${lines}` }, undefined, undefined, testCtx("/tmp"));
		await waitFor(() => app.sent.length === 1);
		const content = app.sent[0].message.content;
		assert.match(content, /answer-line-0/, "the start of the answer survives");
		assert.match(content, /answer-line-59/, "the end of the answer survives");
		assert.doesNotMatch(content, /last 20 lines/, "no command-output line cap on results");
	}),
);

test(
	"wait returns the child's result in-turn and suppresses the follow-up",
	withFakeCli(async () => {
		const app = fresh();
		await app.subagent().execute("c1", { task: "SLOW-SAY:1:result-in-turn" }, undefined, undefined, testCtx("/tmp"));
		const out = await withKeepalive(app.wait().execute("c2", { id: "sa-1" }));
		assert.match(out.content[0].text, /^Subagent sa-1 finished, ran [\d.]+s\./);
		assert.match(out.content[0].text, /Result:\nresult-in-turn/);
		await new Promise((r) => setTimeout(r, 800));
		assert.equal(app.sent.length, 0, "the wait claimed the completion; no follow-up fires");
	}),
);

test(
	"wait timeout leaves the child running with a one-line status",
	withFakeCli(async () => {
		const app = fresh();
		await app.subagent().execute("c1", { task: "HANG" }, undefined, undefined, testCtx("/tmp"));
		const out = await app.wait().execute("c2", { id: "sa-1", timeout: 1 });
		const text = out.content[0].text;
		assert.equal(text.split("\n").length, 1, "exactly one line");
		assert.match(text, /^sa-1 still running, \d+s\. Log: \S+\.err$/);
		assert.ok(!text.includes("Result"), "no result tail");
		const job = jobs()[0];
		assert.equal(job.state, "running", "timeout leaves the child running");
		const stopped = await app.stop().execute("c3", { id: "sa-1" });
		assert.match(stopped.content[0].text, /sa-1 stopped/);
	}),
);

test(
	"aborting a wait leaves the child running and its delivery intact",
	withFakeCli(async () => {
		const app = fresh();
		await app.subagent().execute("c1", { task: "SLOW-SAY:1:abort-delivered" }, undefined, undefined, testCtx("/tmp"));
		const controller = new AbortController();
		const waitP = withKeepalive(app.wait().execute("c2", { id: "sa-1" }, controller.signal));
		await new Promise((r) => setTimeout(r, 150));
		controller.abort();
		const out = await waitP;
		assert.match(out.content[0].text, /^Wait aborted - sa-1 still running, untouched\. Log: \S+\.err$/);
		await waitFor(() => app.sent.length === 1);
		assert.match(app.sent[0].message.content, /abort-delivered/, "the aborted wait did not consume the completion");
	}),
);

test(
	"stop terminates a running child and no completion follows",
	withFakeCli(async () => {
		const app = fresh();
		const armed = await app.subagent().execute("c1", { task: "HANG" }, undefined, undefined, testCtx("/tmp"));
		const pid = Number(armed.content[0].text.match(/pid (\d+)/)[1]);
		const stopped = await app.stop().execute("c2", { id: "sa-1" });
		assert.match(stopped.content[0].text, /sa-1 stopped \(command group gone\)/);
		await waitFor(() => !groupAlive(pid));
		await new Promise((r) => setTimeout(r, 800));
		assert.equal(app.sent.length, 0, "a stopped subagent sends no completion");
	}),
);

test(
	"stop cleans up the child's own detached descendants",
	withFakeCli(async () => {
		const facts = factsFile();
		try {
			process.env.FAKE_PI_FACTS = facts.path;
			const app = fresh();
			const armed = await app.subagent().execute("c1", { task: "BG-SLEEP-HANG:30" }, undefined, undefined, testCtx("/tmp"));
			const pid = Number(armed.content[0].text.match(/pid (\d+)/)[1]);
			const descendant = await waitFor(() => readFacts(facts.path).find((record) => record.kind === "descendant"));
			assert.ok(descendant.pid, "child spawned a detached descendant");
			const stopped = await app.stop().execute("c2", { id: "sa-1" });
			assert.match(stopped.content[0].text, /sa-1 stopped/);
			await waitFor(() => !groupAlive(descendant.pid), 10000);
			assert.equal(groupAlive(descendant.pid), false, "the child's detached background job died with it");
			await waitFor(() => !groupAlive(pid));
		} finally {
			delete process.env.FAKE_PI_FACTS;
			rmSync(facts.dir, { recursive: true, force: true });
		}
	}),
);

test(
	"stop outwaits a child whose own escalation is still in flight (c-116 race)",
	withFakeCli(async () => {
		const facts = factsFile();
		try {
			process.env.FAKE_PI_FACTS = facts.path;
			const app = fresh();
		// The child's TERM-immune detached loop plus a 3s shutdown: longer than
		// the old 2s parent grace (which SIGKILLed the child mid-cleanup and
		// orphaned the detached group - reproduced live), well under the
		// subagent grace the fix adds.
			await app.subagent().execute("c1", { task: "BG-TRAP-SLOW-HANG:3000" }, undefined, undefined, testCtx("/tmp"));
			const descendant = await waitFor(() => readFacts(facts.path).find((record) => record.kind === "descendant"));
			const stopped = await app.stop().execute("c2", { id: "sa-1" });
			assert.match(stopped.content[0].text, /sa-1 stopped/);
			await waitFor(() => !groupAlive(descendant.pid), 10000);
			assert.equal(groupAlive(descendant.pid), false, "the child finished its own escalation before the parent killed it");
		} finally {
			delete process.env.FAKE_PI_FACTS;
			rmSync(facts.dir, { recursive: true, force: true });
		}
	}),
);

test(
	"a failed child reports outcome and diagnostics honestly",
	withFakeCli(async () => {
		const app = fresh();
		await app.subagent().execute("c1", { task: "FAIL:boom-oh" }, undefined, undefined, testCtx("/tmp"));
		await waitFor(() => app.sent.length === 1);
		const content = app.sent[0].message.content;
		assert.match(content, /^Subagent sa-1 failed: its Pi process exited with code 1, ran [\d.]+s\./);
		assert.match(content, /Diagnostics:\nchild failed: boom-oh/);
		assert.match(content, /Any partial response: \S+/);
		assert.equal(app.sent[0].message.details.exitCode, 1);
	}),
);

test(
	"reload keeps children running and the new instance recovers result and exit",
	withFakeCli(async () => {
		const first = fresh();
		await first.emit("session_start", { reason: "startup" });
		await first.subagent().execute("c1", { task: "SLOW-SAY:2.5:reload-result" }, undefined, undefined, testCtx("/tmp"));
		await first.emit("session_shutdown", { reason: "reload" });
		const second = fakePi();
		bashBackground(second.handle);
		await second.emit("session_start", { reason: "reload" });
		await waitFor(() => second.sent.length === 1, 15000);
		assert.match(second.sent[0].message.content, /^Subagent sa-1 finished, ran [\d.]+s\./);
		assert.match(second.sent[0].message.content, /reload-result/);
		assert.equal(second.sent[0].message.details.exitCode, 0, "exit code recovered from the child-side marker");
		assert.equal(first.sent.length, 0, "the stale instance never delivers");
	}),
);

test(
	"quit stops children and clears the registry",
	withFakeCli(async () => {
		const app = fresh();
		await app.emit("session_start", { reason: "startup" });
		const armed = await app.subagent().execute("c1", { task: "HANG" }, undefined, undefined, testCtx("/tmp"));
		const pid = Number(armed.content[0].text.match(/pid (\d+)/)[1]);
		await app.emit("session_shutdown", { reason: "quit" });
		await waitFor(() => !groupAlive(pid), 10000);
		assert.equal(jobs().length, 0);
	}),
);

test(
	"a replaced session never adopts a running subagent",
	withFakeCli(async () => {
		const first = fresh();
		await first.emit("session_start", { reason: "startup" });
		await first.subagent().execute("c1", { task: "HANG" }, undefined, undefined, testCtx("/tmp"));
		await first.emit("session_shutdown", { reason: "new" });
		const second = fakePi();
		bashBackground(second.handle);
		await second.emit("session_start", { reason: "resume" });
		assert.equal(second.sent.length, 0);
		const orphan = await second.wait().execute("c1", { id: "sa-1" });
		assert.match(orphan.content[0].text, /No background job sa-1 in this session\./);
	}),
);

test(
	"a mixed all-wait claims bash and subagent jobs together",
	withFakeCli(async () => {
		const app = fresh();
		await app.bash().execute("c1", { command: "sleep 1.4; echo mixed-bash-out", background: true }, undefined, undefined, testCtx("/tmp"));
		await app.subagent().execute("c2", { task: "SLOW-SAY:1.2:mixed-child-result" }, undefined, undefined, testCtx("/tmp"));
		const out = await withKeepalive(app.wait().execute("c3", { all: true }));
		const text = out.content[0].text;
		assert.match(text, /bg-1\nBackground command bg-1 exited with code 0, ran [\d.]+s\./);
		assert.match(text, /mixed-bash-out/);
		assert.match(text, /sa-2\nSubagent sa-2 finished, ran [\d.]+s\./);
		assert.match(text, /mixed-child-result/);
		await new Promise((r) => setTimeout(r, 800));
		assert.equal(app.sent.length, 0, "the all-wait claimed both completions");
	}),
);

test("wait and stop refuse an unknown subagent id with the shared shape", async () => {
	const app = fresh();
	const waited = await app.wait().execute("c1", { id: "sa-9" });
	assert.match(waited.content[0].text, /No background job sa-9 in this session\./);
	assert.match(waited.content[0].text, /Only jobs started here can be waited on\./);
	const stopped = await app.stop().execute("c2", { id: "sa-9" });
	assert.match(stopped.content[0].text, /No background job sa-9 in this session\./);
	assert.match(stopped.content[0].text, /Only jobs started here can be stopped\./);
});

test(
	"the footer tracks a running subagent and clears when it settles",
	withFakeCli(async () => {
		const app = fresh();
		const uiCtx = { ui: app.ui(), hasUI: true };
		await app.emit("session_start", { reason: "startup" }, uiCtx);
		await app.subagent().execute("c1", { task: "SLOW-SAY:2:footer-check" }, undefined, undefined, testCtx("/tmp"));
		const texts = () => app.status.filter((s) => s.key === "bash-bg").map((s) => s.text);
		await waitFor(() => texts().some((t) => /^sa-1 \d+s$/.test(t ?? "")), 5000);
		await waitFor(() => app.sent.length === 1, 10000);
		await waitFor(() => texts().at(-1) === undefined, 5000);
	}),
);

test(
	"the /bg card lists subagent tasks beside bash commands",
	withFakeCli(async () => {
		const app = fresh();
		await app.emit("session_start", { reason: "startup" }, { ui: app.ui(), hasUI: true });
		await app.bash().execute("c1", { command: "sleep 30", background: true }, undefined, undefined, testCtx("/tmp"));
		await app.subagent().execute("c2", { task: "HANG-review the flake" }, undefined, undefined, testCtx("/tmp"));
		await waitFor(() => app.status.some((s) => (s.text ?? "").includes("sa-2")), 5000);
		await app.bgCommand().handler("", { ui: app.ui() });
		const card = app.entries.at(-1);
		assert.equal(card.customType, "bash-bg-status");
		assert.deepEqual(
			card.data.jobs.map((j) => [j.id, j.command, j.timeoutMs]),
			[
				["bg-1", "sleep 30", undefined],
				["sa-2", "HANG-review the flake", undefined],
			],
		);
		await app.stop().execute("c3", { id: "bg-1" });
		await app.stop().execute("c4", { id: "sa-2" });
	}),
);
