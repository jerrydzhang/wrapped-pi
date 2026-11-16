// Subagent contracts for persistent RPC workers, over the fake ExtensionAPI,
// the real WorkerRpc transport, and a fake Pi CLI (fake-worker-cli.mjs)
// standing in for the relaunched `pi --mode rpc` child. The fixture speaks the
// wire contract spawnSubagent relies on (get_state/get_commands readiness, an
// inbox command, steering prompts that queue while busy, stdin-EOF shutdown,
// SIGTERM with detached-descendant cleanup), so workers are exercised as real
// long-lived processes: stable id/pid, remembered conversation across turns,
// queued messages while busy, declined UI requests, reload persistence, and
// stop/quit/new cleanup. No real Pi, no network, no credentials: the subagent
// configuration lives in disposable agent directories.
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import bashBackground from "../bash-background.ts";
import { WorkerRpc } from "../lib/worker-rpc.ts";
import {
	MESSAGE_BYTES, REPORT_BYTES, TRANSCRIPT_BYTES,
	WORKER_INBOX_COMMAND, WORKER_MESSAGE_ENTRY,
} from "../lib/worker-state.ts";
import { fakePi, testCtx, jobs, groupAlive, waitFor } from "./fake-pi.ts";

const FAKE_CLI = new URL("./fake-worker-cli.mjs", import.meta.url).pathname;
// spawnSubagent appends its own file to the child's -e list, wrapper list or
// not: the child's inbox and parent-message tool are not optional.
const THIS_EXTENSION = fileURLToPath(new URL("../bash-background.ts", import.meta.url));
const MODEL = "test/mini";
const TRUNCATION = "\n[truncated; full transcript in event log]";

// Every test's configuration lives in a disposable agent directory pointed at
// by PI_CODING_AGENT_DIR - exactly how the extension resolves the agent dir -
// so the suite never touches the real ~/.pi/agent or its auth.
const agentDirs = [];

// Workers are real detached processes holding real pipes: stop them all
// before the registry is dropped, or the fixtures (and their descendants)
// outlive the test process. Runs after every test - including failed ones -
// and before each fresh() so leftovers from any path are cleaned too. The
// registry is cleared only after the kills settle: the rpc handles are the
// only way to reach the processes.
async function cleanupRegistry() {
	const reg = globalThis[Symbol.for("bash-background.jobs")];
	if (reg === undefined) return;
	const live = [...reg.jobs.values()].filter((job) => job.state === "running" || job.state === "stopping");
	// Orderly first: stdin EOF makes the fake Pi run its own descendant
	// cleanup and exit.
	for (const job of live) {
		if (job.kind === "subagent" && job.rpc && !job.rpc.exited) {
			try { job.rpc.closeInput(); } catch { /* already gone */ }
		}
	}
	const allGone = () => live.every((job) => !groupAlive(job.pid));
	try { await waitFor(allGone, 4000); } catch { /* escalate below */ }
	for (const job of live) {
		if (groupAlive(job.pid)) { try { process.kill(-job.pid, "SIGTERM"); } catch { /* raced the exit */ } }
	}
	try { await waitFor(allGone, 8000); } catch { /* last resort below */ }
	for (const job of live) {
		if (groupAlive(job.pid)) { try { process.kill(-job.pid, "SIGKILL"); } catch { /* raced the exit */ } }
	}
	await waitFor(allGone, 2000).catch(() => {});
	reg.jobs.clear();
	reg.nextId = 1;
	if (reg.poller !== undefined) clearInterval(reg.poller);
	reg.poller = undefined;
}

afterEach(cleanupRegistry);

after(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.WRAPPED_PI_SUBAGENT_MODEL;
	delete process.env.FAKE_PI_FACTS;
	delete process.env.FAKE_PI_DIE_AT_BOOT;
	delete process.env.FAKE_PI_NO_INBOX;
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

async function fresh(options = {}) {
	await cleanupRegistry();
	delete process.env.WRAPPED_PI_CHILD;
	const dir = options.agentDir ?? mkdtempSync(join(tmpdir(), "sa-agent-"));
	agentDirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
	if (options.config !== undefined) writeConfig(options.config);
	else if (options.model !== null) writeConfig(JSON.stringify({ model: options.model ?? MODEL }));
	// Explicit values pass through; absent or null both mean no wrapper list -
	// the ambient environment (which holds a real store path in a wrapped
	// session) must never leak into test children.
	if (options.extensionsEnv !== undefined && options.extensionsEnv !== null) process.env.WRAPPED_PI_EXTENSIONS = options.extensionsEnv;
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

function withFacts(fn) {
	return async () => {
		const facts = factsFile();
		process.env.FAKE_PI_FACTS = facts.path;
		try {
			await fn(facts);
		} finally {
			// A prompt acknowledgement can beat the fixture's final facts write.
			// Stop writers before deleting their directory (otherwise ENOTEMPTY).
			await cleanupRegistry();
			delete process.env.FAKE_PI_FACTS;
			rmSync(facts.dir, { recursive: true, force: true });
		}
	};
}

// Launches one persistent worker and returns its start reply plus its
// registry job.
async function launchWorker(app, task, cwd = "/tmp") {
	const out = await app.subagent().execute("launch", { task }, undefined, undefined, testCtx(cwd));
	const job = jobs().at(-1);
	assert.ok(job, "the launch registered a job");
	return { out, job };
}

function message(app, id, text) {
	return app.tools.get("message").execute("message", { id, message: text });
}

// The reply/question body between the header line and the transcript pointer.
function noticeText(sent) {
	const content = sent.message.content;
	const pointer = "\nFull transcript: ";
	return content.slice(content.indexOf("\n") + 1, content.lastIndexOf(pointer));
}

test("registers subagent beside message, wait, stop, and the /bg command", async () => {
	const app = await fresh();
	const subagent = app.subagent();
	assert.equal(subagent.name, "subagent");
	assert.equal(subagent.label, "Launch a subagent");
	assert.ok(subagent.parameters.properties.task, "task param");
	assert.match(subagent.description, /never this conversation/);
	assert.match(subagent.description, /no subagent tool of its own/);
	assert.match(subagent.description, /stable sa-N id/);
	assert.match(subagent.description, /including \/reload/);
	assert.equal(app.wait().name, "wait");
	assert.equal(app.stop().name, "stop");
	assert.match(app.tools.get("message").description, /by its sa-N id/, "the parent messages existing workers");
	assert.match(app.tools.get("message").description, /not proof the worker has read it/);
	assert.ok(app.commands.get("bg"), "the /bg command is registered");
	assert.equal(app.commands.get(WORKER_INBOX_COMMAND), undefined, "the parent has no inbox command");
});

test("a child session registers no subagent tool, keeping bash/wait/stop/message and its inbox", async () => {
	const app = await fresh();
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
		assert.ok(child.tools.get("message"), "children keep the parent-message tool");
		assert.ok(child.commands.get(WORKER_INBOX_COMMAND), "children register the RPC inbox");
	} finally {
		delete process.env.WRAPPED_PI_CHILD;
	}
});

test("without a configured model the tool refuses before spawning", async () => {
	const app = await fresh({ model: null });
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
		const app = await fresh({ config: body });
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
	const app = await fresh();
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
	const app = await fresh();
	await assert.rejects(app.subagent().execute("c1", { task: "  " }, undefined, undefined, testCtx("/tmp")), /non-empty/);
	assert.equal(jobs().length, 0);
});

test("a missing working directory is a visible error", async () => {
	const app = await fresh();
	await assert.rejects(
		app.subagent().execute("c1", { task: "SAY:x" }, undefined, undefined, testCtx("/nonexistent-cwd-xyz")),
		/Working directory does not exist/,
	);
	assert.equal(jobs().length, 0);
});

test(
	"launches a persistent RPC child: the same executable, rpc flags, model, bundled set plus this extension, and a clean env",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh({ extensionsEnv: "/store/first.ts\n\n/store/second.ts\n" });
		const { job } = await launchWorker(app, "SAY:hi");
		assert.equal(job.kind, "subagent");
		assert.ok(job.rpc, "an RPC worker carries its transport");
		assert.equal(job.rpc.pid, job.pid);
		assert.equal(job.state, "running", "the job stays running while the process is alive");
		const start = readFacts(facts.path).find((record) => record.kind === "start");
		assert.ok(start, "child recorded its launch");
		assert.equal(start.execPath, process.execPath, "the child runs the same executable as the parent");
		assert.equal(start.argvFull[1], FAKE_CLI, "the parent's entry is what gets relaunched");
		assert.deepEqual(start.argv.slice(0, 4), ["--mode", "rpc", "--no-session", "--model"]);
		assert.equal(start.argv[4], MODEL);
		assert.deepEqual(start.extensions, ["/store/first.ts", "/store/second.ts", THIS_EXTENSION], "bundled set first, this extension always");
		assert.equal(start.cwd, "/tmp", "child runs in the session cwd");
		assert.notEqual(start.cwd, process.cwd(), "the invocation carries ctx.cwd, not the process cwd");
		assert.equal(start.childMarker, "1", "recursion marker set");
		assert.deepEqual(start.staleSessionEnv, [], "no parent PI_* session state leaks");
		assert.equal(start.extensionsEnv, "/store/first.ts\n\n/store/second.ts\n", "wrapper list inherited untouched");
		assert.deepEqual(
			readFacts(facts.path).filter((record) => record.kind === "rpc").map((record) => record.command),
			["get_commands", "prompt"],
			"readiness is get_commands verifying the inbox, then the task prompt",
		);
		assert.deepEqual(
			readFacts(facts.path).filter((record) => record.kind === "task").map((record) => record.task),
			["SAY:hi"],
			"the initial task went through one RPC prompt",
		);
		await waitFor(() => job.worker.phase === "idle");
	})),
);

test(
	"without the wrapper list the child still always loads this extension",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh({ extensionsEnv: null });
		await launchWorker(app, "SAY:hi");
		const start = readFacts(facts.path).find((record) => record.kind === "start");
		assert.deepEqual(start.extensions, [THIS_EXTENSION], "the inbox and message tool are not optional");
		assert.equal(start.extensionsEnv, null);
	})),
);

test(
	"the configuration is read afresh on every launch - edits apply without restarting Pi",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh();
		await launchWorker(app, "SAY:first");
		// Rewrite the file between launches: unknown keys tolerated, whitespace
		// trimmed - the next launch reads the new value, no restart involved.
		writeConfig('{"model":"  test/other  ","future":true}\n');
		await launchWorker(app, "SAY:second");
		await waitFor(() => jobs().length === 2);
		const starts = readFacts(facts.path).filter((record) => record.kind === "start");
		assert.equal(starts.length, 2);
		assert.equal(starts[0].model, MODEL, "first launch used the file as written");
		assert.equal(starts[1].model, "test/other", "second launch read the rewritten file");
		assert.equal(jobs()[0].model, MODEL);
		assert.equal(jobs()[1].model, "test/other", "the job record carries the re-read model");
	})),
);

test(
	"the configuration location follows PI_CODING_AGENT_DIR",
	withFakeCli(withFacts(async (facts) => {
		const dirs = ["a", "b", "c"].map((tag) => mkdtempSync(join(tmpdir(), `sa-agent-${tag}-`)));
		dirs.forEach((dir) => agentDirs.push(dir));
		writeFileSync(join(dirs[0], "wrapped-pi.json"), JSON.stringify({ model: "a/first" }));
		writeFileSync(join(dirs[1], "wrapped-pi.json"), JSON.stringify({ model: "b/second" }));
		const app = await fresh({ agentDir: dirs[0], model: null });
		await launchWorker(app, "SAY:one");
		// Same session, different agent directory: the next launch resolves
		// through the variable, never a cached or default location.
		process.env.PI_CODING_AGENT_DIR = dirs[1];
		await launchWorker(app, "SAY:two");
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
	})),
);

test(
	"the removed environment variable has no precedence - the file is the only source",
	withFakeCli(withFacts(async (facts) => {
		process.env.WRAPPED_PI_SUBAGENT_MODEL = "legacy/env-model";
		const app = await fresh({ model: "file/model" });
		await launchWorker(app, "SAY:hi");
		const start = readFacts(facts.path).find((record) => record.kind === "start");
		assert.equal(start.model, "file/model", "the file wins; the legacy variable is dead");
		assert.equal(jobs()[0].model, "file/model");
	})),
);

test(
	"the armed reply names the handle, task, model, and delivery contract",
	withFakeCli(async () => {
		const app = await fresh();
		const { out } = await launchWorker(app, "review the flake inputs");
		const text = out.content[0].text;
		assert.match(text, /^Subagent sa-1 started \(pid \d+\)\./);
		assert.match(text, /Task: review the flake inputs/);
		assert.match(text, /Model: test\/mini/);
		assert.match(text, /Replies and messages arrive automatically/);
		assert.match(text, /Use message with this id for follow-ups or answers/);
		assert.match(text, /Background-job waits are quiet and resume automatically; do not nudge/);
		assert.match(text, /A reply is not proof of task completion/);
		assert.match(text, /Call wait alone/);
		assert.match(text, /\/bg sa-1/, "the worker conversation is openable");
		assert.match(text, /Full event transcript: \S+/);
		assert.match(text, /diagnostics: \S+/);
	}),
);

test("an entry that dies at boot fails the launch before any job exists", async () => {
	const app = await fresh();
	const saved = process.argv[1];
	process.argv[1] = "/nonexistent/pi-entry-for-subagent-test";
	try {
		// node itself spawns (the executable exists); the missing entry script
		// makes the child exit 1 before readiness, which must surface as a
		// start failure, not a running job.
		await assert.rejects(
			app.subagent().execute("c1", { task: "SAY:hi" }, undefined, undefined, testCtx("/tmp")),
			/^Error: Cannot start sa-1: worker exited \(code=1 signal=null\)/,
		);
	} finally {
		process.argv[1] = saved;
	}
	assert.equal(jobs().length, 0, "no job for a failed start");
	assert.equal(app.sent.length, 0);
});

test(
	"a child that refuses startup (unusable model) fails readiness and cleans itself up",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh();
		process.env.FAKE_PI_DIE_AT_BOOT = "1";
		try {
			await assert.rejects(
				app.subagent().execute("c1", { task: "SAY:hi" }, undefined, undefined, testCtx("/tmp")),
				(it) => {
					assert.match(it.message, /^Cannot start sa-1: worker exited \(code=1 signal=null\)/);
					assert.match(it.message, /Diagnostics: \S+/, "the error points at the diagnostics file");
					return true;
				},
			);
			assert.equal(jobs().length, 0, "the failed worker is not kept in the registry");
			assert.equal(app.sent.length, 0, "no completion for a failed start");
			const start = readFacts(facts.path).find((record) => record.kind === "start");
			assert.ok(start);
			await waitFor(() => !groupAlive(start.pid), 5000);
		} finally {
			delete process.env.FAKE_PI_DIE_AT_BOOT;
		}
	})),
);

test(
	"a child without the worker inbox fails readiness and cleans itself up",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh();
		process.env.FAKE_PI_NO_INBOX = "1";
		try {
			await assert.rejects(
				app.subagent().execute("c1", { task: "SAY:hi" }, undefined, undefined, testCtx("/tmp")),
				/^Error: Cannot start sa-1: Child Pi did not register its worker inbox\./,
			);
			assert.equal(jobs().length, 0);
			assert.equal(app.sent.length, 0);
			const start = readFacts(facts.path).find((record) => record.kind === "start");
			assert.ok(start);
			await waitFor(() => !groupAlive(start.pid), 5000);
		} finally {
			delete process.env.FAKE_PI_NO_INBOX;
		}
	})),
);

test(
	"a child that exits during its first turn reports the ending with diagnostics",
	withFakeCli(async () => {
		const app = await fresh();
		const { out } = await launchWorker(app, "FAIL:boom-mid");
		assert.match(out.content[0].text, /^Subagent sa-1 started \(pid \d+\)\./, "the spawn and readiness succeeded");
		await waitFor(() => app.sent.length === 1);
		const { message, options } = app.sent[0];
		assert.equal(message.customType, "bash-background-result");
		assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
		assert.match(message.content, /^Worker sa-1 process ended \(exit code 1\); its conversation is no longer addressable\./);
		assert.match(message.content, /Diagnostics:\nchild failed: boom-mid/);
		assert.match(message.content, /Full transcript: \S+\nFull diagnostics: \S+$/);
		assert.equal(message.details.exitCode, 1);
		assert.equal(jobs()[0].state, "exited");
		await new Promise((r) => setTimeout(r, 800));
		assert.equal(app.sent.length, 1, "no duplicate ending");
	}),
);

test(
	"a late exit closes the conversation: ending delivered, further messages refused",
	withFakeCli(async () => {
		const app = await fresh();
		await launchWorker(app, "REMEMBER:seed");
		await waitFor(() => app.sent.length === 1);
		const out = await message(app, "sa-1", "FAIL:late-crash");
		assert.match(out.content[0].text, /Message submitted to sa-1\./);
		await waitFor(() => app.sent.length === 2);
		assert.match(app.sent[1].message.content, /^Worker sa-1 process ended \(exit code 1\)/);
		assert.match(app.sent[1].message.content, /child failed: late-crash/);
		assert.equal(app.sent[1].message.details.exitCode, 1);
		await assert.rejects(message(app, "sa-1", "RECALL"), /No addressable worker sa-1 in this session\./);
	}),
);

test(
	"an unwaited reply delivers exactly once as a steered subagent-reply",
	withFakeCli(async () => {
		const app = await fresh();
		const { job } = await launchWorker(app, "SAY:the final answer");
		await waitFor(() => app.sent.length === 1);
		const { message, options } = app.sent[0];
		assert.equal(message.customType, "subagent-reply");
		assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
		assert.equal(message.content, `Reply from worker sa-1 (turn 1; responding to parent):\nthe final answer\nFull transcript: ${job.logPath}`);
		assert.deepEqual(message.details, { id: "sa-1", turn: 1, kind: "reply", logPath: job.logPath, reason: "reply" });
		assert.equal(job.worker.phase, "idle", "idle after the reply");
		assert.equal(job.state, "running", "the process is still alive and addressable");
		await new Promise((r) => setTimeout(r, 800));
		assert.equal(app.sent.length, 1, "no duplicate delivery");
	}),
);

test(
	"child background waiting is quiet and visible across reload, then auto-delivers only the final reply",
	withFakeCli(async () => {
		const first = await fresh();
		await first.emit("session_start", { reason: "startup" }, { ui: first.ui(), hasUI: true });
		const { job } = await launchWorker(first, "WAIT-JOBS:1800:Tests running, not a final answer");
		const pid = job.pid;
		await waitFor(() => job.worker.settlement === "waiting-jobs");
		await first.wait().execute("quiet-wait", {});
		assert.equal(first.sent.length, 0, "wait does not manufacture mail for a waiting worker");
		await waitFor(() => first.status.at(-1)?.text?.includes("bg-1; resumes automatically"));
		assert.match(first.status.at(-1).text, /sa-1 waiting on background work: bg-1; resumes automatically/);
		await first.emit("session_shutdown", { reason: "reload" });
		const second = fakePi();
		bashBackground(second.handle);
		await second.emit("session_start", { reason: "reload" }, { ui: second.ui(), hasUI: true });
		assert.equal(jobs()[0].pid, pid);
		assert.match(second.status.at(-1).text, /bg-1; resumes automatically/);
		await waitFor(() => second.sent.length === 1);
		assert.equal(first.sent.length, 0);
		assert.equal(noticeText(second.sent[0]), "automatic final reply");
		assert.match(second.sent[0].message.content, /^Reply from worker sa-1 .*resumed by background result/);
		assert.equal(second.sent[0].message.details.reason, "reply");
		assert.equal(second.sent[0].message.details.trigger, "background");
		assert.equal(job.worker.settlement, "reply");
		await message(second, job.id, "SAY:reused without nudges");
		await waitFor(() => second.sent.length === 2);
		assert.equal(noticeText(second.sent[1]), "reused without nudges");
		assert.match(second.sent[1].message.content, /responding to parent/);
		assert.equal(second.sent[1].message.details.trigger, undefined);
	}),
);

test(
	"an unexplained wait reports no automatic continuation instead of a normal reply",
	withFakeCli(async () => {
		const app = await fresh();
		const { job } = await launchWorker(app, "YIELD");
		await waitFor(() => app.sent.length === 1);
		assert.match(app.sent[0].message.content, /^Status from worker sa-1/);
		assert.match(noticeText(app.sent[0]), /ended its turn without a reply.*will not resume automatically/);
		assert.equal(app.sent[0].message.details.kind, "status");
		assert.equal(app.sent[0].message.details.reason, "unexplained");
		assert.equal(job.worker.settlement, "unexplained");
		await message(app, job.id, "SAY:follow-up");
		await waitFor(() => app.sent.length === 2);
		assert.equal(noticeText(app.sent[1]), "follow-up");
	}),
);

test(
	"an interrupted worker reports interruption, stays addressable, and can reply on reuse",
	withFakeCli(async () => {
		const app = await fresh();
		const { job } = await launchWorker(app, "HANG");
		await job.rpc.request({ type: "abort" });
		await waitFor(() => app.sent.length === 1);
		assert.match(app.sent[0].message.content, /^Status from worker sa-1/);
		assert.match(noticeText(app.sent[0]), /interrupted.*No automatic continuation/);
		assert.equal(app.sent[0].message.details.reason, "interrupted");
		assert.equal(groupAlive(job.pid), true);
		await message(app, job.id, "SAY:post-interrupt");
		await waitFor(() => app.sent.length === 2);
		assert.equal(noticeText(app.sent[1]), "post-interrupt");
	}),
);

test(
	"a long answer keeps both ends - no bash 20-line tail semantics",
	withFakeCli(async () => {
		const app = await fresh();
		const lines = Array.from({ length: 60 }, (_, i) => `answer-line-${i}`).join("\n");
		await launchWorker(app, `SAY:${lines}`);
		await waitFor(() => app.sent.length === 1);
		const content = app.sent[0].message.content;
		assert.match(content, /answer-line-0/, "the start of the answer survives");
		assert.match(content, /answer-line-59/, "the end of the answer survives");
		assert.doesNotMatch(content, /last 20 lines/);
		assert.doesNotMatch(content, /\[truncated/, "a normal answer is never cut");
	}),
);

test(
	"a huge UTF-8 reply is cut on a character boundary and pointed at the transcript",
	withFakeCli(async () => {
		const app = await fresh();
		// Six-byte units put the 64 KiB cut deliberately inside a sequence.
		const payload = "ab🦄".repeat(20000);
		const { job } = await launchWorker(app, `SAY:${payload}`);
		await waitFor(() => app.sent.length === 1);
		const match = /^Reply from worker sa-1 \(turn 1; responding to parent\):\n([\s\S]*)\nFull transcript: \S+$/.exec(app.sent[0].message.content);
		assert.ok(match, "reply shape with header and transcript pointer");
		const body = match[1];
		assert.ok(body.endsWith(TRUNCATION), "the truncation pointer is present");
		const prefix = body.slice(0, body.length - TRUNCATION.length);
		assert.ok(Buffer.byteLength(prefix) <= REPORT_BYTES, "the report bound holds");
		// A torn UTF-8 sequence would throw here: the cut backed off to a boundary.
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(prefix, "utf8"));
		assert.ok(decoded.includes("ab🦄".repeat(100)), "the answer's start survives intact");
		assert.doesNotMatch(body, /\uFFFD/, "no replacement characters");
		assert.ok(Buffer.byteLength(job.worker.transcript) <= TRANSCRIPT_BYTES + 64, "the transcript bound holds");
		assert.equal(job.worker.partial, "", "the streaming partial is dropped once the message completes");
	}),
);

test(
	"follow-ups continue the same process and conversation: stable pid, id, and memory",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh();
		const { job } = await launchWorker(app, "REMEMBER:alpha");
		const pid = job.pid;
		const rpc = job.rpc;
		await waitFor(() => app.sent.length === 1);
		assert.match(app.sent[0].message.content, /remembered/);
		assert.equal(job.worker.phase, "idle");
		const out = await message(app, "sa-1", "RECALL");
		assert.match(out.content[0].text, /Message submitted to sa-1\. Replies arrive automatically\./);
		await waitFor(() => app.sent.length === 2);
		assert.equal(noticeText(app.sent[1]), "alpha", "the second turn remembers the first");
		assert.equal(app.sent[1].message.details.turn, 2);
		assert.equal(jobs()[0].id, "sa-1", "stable id");
		assert.equal(jobs()[0].pid, pid, "same process");
		assert.equal(jobs()[0].rpc, rpc, "same transport object");
		assert.equal(jobs()[0].worker.phase, "idle");
		const records = readFacts(facts.path);
		assert.equal(records.filter((record) => record.kind === "start").length, 1, "exactly one child process was ever spawned");
		assert.deepEqual(
			records.filter((record) => record.kind === "task" && record.pid === pid).map((record) => record.task),
			["REMEMBER:alpha", "RECALL"],
		);
	})),
);

test(
	"a worker question arrives as a message before the yield, and the parent's answer keeps the conversation",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh();
		const { job } = await launchWorker(app, "REMEMBER:alpha");
		const pid = job.pid;
		await waitFor(() => app.sent.length === 1);
		await message(app, "sa-1", "QUESTION:Which value holds?");
		await waitFor(() => app.sent.length === 2, 10000);
		assert.equal(app.sent[1].message.customType, "subagent-message");
		assert.equal(noticeText(app.sent[1]), "Which value holds?");
		assert.equal(job.worker.settlement, "waiting-input");
		assert.match(job.worker.activity, /waiting for input/);
		assert.deepEqual(app.sent[1].message.details, { id: "sa-1", turn: 2, kind: "message", logPath: job.logPath });
		// No idle wake on top: the question already reported this run.
		await new Promise((r) => setTimeout(r, 1100));
		assert.equal(app.sent.length, 2, "a question is not followed by a worker-yielded reply");
		await message(app, "sa-1", "RECALL");
		await waitFor(() => app.sent.length === 3);
		assert.equal(noticeText(app.sent[2]), "alpha", "the question did not end the conversation");
		assert.equal(app.sent[2].message.details.turn, 3);
		const records = readFacts(facts.path);
		assert.equal(records.filter((record) => record.kind === "start").length, 1);
		assert.deepEqual(
			records.filter((record) => record.kind === "task" && record.pid === pid).map((record) => record.task),
			["REMEMBER:alpha", "QUESTION:Which value holds?", "RECALL"],
		);
	})),
);

test(
	"a message to a busy worker queues at the turn boundary and runs in order, marked from parent",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh();
		const { job } = await launchWorker(app, "SLOW-SAY:1:first");
		const pid = job.pid;
		// The launch prompt was accepted (busy) before its response arrived, so
		// this submit is deterministically steered into the queue.
		const out = await message(app, "sa-1", "SAY:queued-second");
		assert.match(out.content[0].text, /Message submitted to sa-1\./);
		assert.match(out.details.id, /^sa-1$/);
		await waitFor(() => app.sent.length >= 2, 10000);
		assert.equal(noticeText(app.sent[0]), "first");
		assert.equal(app.sent[0].message.details.turn, 1);
		assert.equal(noticeText(app.sent[1]), "queued-second", "the queued message ran after the slow turn settled");
		assert.equal(app.sent[1].message.details.turn, 2);
		const records = readFacts(facts.path);
		const inbox = records.find((record) => record.kind === "inbox");
		assert.equal(inbox.from, "parent", "the parent is the sender the child sees");
		assert.equal(inbox.text, "SAY:queued-second");
		assert.equal(records.filter((record) => record.kind === "start").length, 1);
		assert.deepEqual(
			records.filter((record) => record.kind === "task" && record.pid === pid).map((record) => record.task),
			["SLOW-SAY:1:first", "SAY:queued-second"],
			"queue order preserved on one process",
		);
	})),
);

test("the child inbox accepts parent and human senders and refuses the rest", async () => {
	const app = await fresh();
	assert.equal(app.commands.get(WORKER_INBOX_COMMAND), undefined, "parents have no inbox command");
	process.env.WRAPPED_PI_CHILD = "1";
	try {
		const child = fakePi();
		bashBackground(child.handle);
		const inbox = child.commands.get(WORKER_INBOX_COMMAND);
		assert.ok(inbox, "children register the RPC-only inbox");
		const packet = (body) => Buffer.from(JSON.stringify(body)).toString("base64");
		await inbox.handler(packet({ from: "human", text: "hello human" }), { mode: "rpc" });
		await inbox.handler(packet({ from: "parent", text: "hello parent" }), { mode: "rpc" });
		assert.deepEqual(child.sent.map((s) => s.message.details.from), ["human", "parent"], "both senders are honored");
		assert.equal(child.sent[0].message.customType, "worker-inbox");
		assert.equal(child.sent[0].message.content, "Message from human:\nhello human");
		assert.deepEqual(child.sent[0].options, { deliverAs: "steer", triggerTurn: true });
		await assert.rejects(inbox.handler(packet({ from: "sibling", text: "hi" }), { mode: "rpc" }), /Invalid worker message sender\./);
		await assert.rejects(inbox.handler(packet({ from: "parent", text: "hi" }), { mode: "print" }), /The worker inbox is RPC-only\./);
		await assert.rejects(inbox.handler(packet({ from: "parent", text: "not yet" }), { mode: "rpc", isIdle: () => false }), /message was not submitted/);
		assert.equal(child.sent.length, 2, "a non-agent busy boundary refuses honestly rather than overlap compaction");
	} finally {
		delete process.env.WRAPPED_PI_CHILD;
	}
});

test("a child messages only its parent, and the message lands in its own session", async () => {
	const app = await fresh();
	process.env.WRAPPED_PI_CHILD = "1";
	try {
		const child = fakePi();
		bashBackground(child.handle);
		const messageTool = child.tools.get("message");
		assert.match(messageTool.description, /Use id: parent/);
		const out = await messageTool.execute("m1", { id: "parent", message: "blocked on review" });
		assert.match(out.content[0].text, /Message submitted to parent\. Replies arrive automatically\./);
		assert.deepEqual(child.entries.at(-1), { customType: WORKER_MESSAGE_ENTRY, data: { text: "blocked on review" } });
		await assert.rejects(messageTool.execute("m2", { id: "sa-1", message: "hello" }), /Workers can message only id: parent; sibling messaging is not supported\./);
		await assert.rejects(messageTool.execute("m3", { id: "parent", message: "x".repeat(MESSAGE_BYTES + 1) }), /Message exceeds 16384 bytes/);
		assert.equal(child.entries.length, 1, "the rejected messages armed nothing");
	} finally {
		delete process.env.WRAPPED_PI_CHILD;
	}
});

test(
	"a turn error fails the turn without killing the worker, which keeps the conversation",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh();
		const { job } = await launchWorker(app, "REMEMBER:alpha");
		const pid = job.pid;
		await waitFor(() => app.sent.length === 1);
		await message(app, "sa-1", "TURN-ERROR:provider-down");
		await waitFor(() => app.sent.length === 2);
		assert.equal(noticeText(app.sent[1]), "provider-down", "the error message is what the parent sees");
		assert.equal(app.sent[1].message.customType, "subagent-reply");
		assert.equal(job.worker.phase, "failed");
		assert.equal(job.worker.error, "provider-down");
		assert.equal(app.sent[1].message.details.reason, "error");
		assert.match(app.sent[1].message.content, /^Status from worker sa-1/);
		assert.equal(groupAlive(pid), true, "a failed turn is not a dead worker");
		await message(app, "sa-1", "RECALL");
		await waitFor(() => app.sent.length === 3);
		assert.equal(noticeText(app.sent[2]), "alpha", "the conversation continues after a failed turn");
		assert.equal(app.sent[2].message.details.turn, 3);
		assert.equal(job.worker.phase, "idle");
		const records = readFacts(facts.path);
		assert.equal(records.filter((record) => record.kind === "start").length, 1);
	})),
);

test(
	"reload keeps the process, object, and conversation: the new instance continues the same worker",
	withFakeCli(async () => {
		const first = await fresh();
		await first.emit("session_start", { reason: "startup" });
		const { job } = await launchWorker(first, "REMEMBER:alpha");
		const pid = job.pid;
		const rpc = job.rpc;
		const worker = job.worker;
		await waitFor(() => first.sent.length === 1);
		assert.match(first.sent[0].message.content, /remembered/);
		await first.emit("session_shutdown", { reason: "reload" });
		const second = fakePi();
		bashBackground(second.handle);
		await second.emit("session_start", { reason: "reload" });
		assert.equal(jobs().length, 1, "the worker survives the reload");
		assert.equal(jobs()[0].pid, pid, "same process");
		assert.equal(jobs()[0].rpc, rpc, "same transport object across the reload");
		assert.equal(WorkerRpc.get(pid), rpc, "reachable through the pid-keyed transport registry");
		assert.equal(jobs()[0].worker, worker, "the worker state object persists");
		assert.equal(jobs()[0].worker.phase, "idle");
		await message(second, "sa-1", "RECALL");
		await waitFor(() => second.sent.length === 1);
		assert.equal(noticeText(second.sent[0]), "alpha", "the new instance continues the same conversation");
		assert.equal(second.sent[0].message.details.turn, 2);
		assert.equal(first.sent.length, 1, "the stale instance never delivers again");
	}),
);

test(
	"a notice landing in the reload gap is delivered by the new instance, never the stale one",
	withFakeCli(async () => {
		const first = await fresh();
		await first.emit("session_start", { reason: "startup" });
		await launchWorker(first, "SLOW-SAY:1.5:gap-reply");
		await first.emit("session_shutdown", { reason: "reload" });
		// The gap: the reply lands while no instance holds a handle. The stale
		// instance cannot deliver; the shared worker state keeps the notice.
		await waitFor(() => jobs()[0].worker.notices.length > 0 && first.sent.length === 0, 10000);
		const second = fakePi();
		bashBackground(second.handle);
		await second.emit("session_start", { reason: "reload" });
		await waitFor(() => second.sent.length === 1, 10000);
		assert.match(second.sent[0].message.content, /gap-reply/);
		assert.equal(second.sent[0].message.details.turn, 1);
		assert.equal(first.sent.length, 0, "the stale instance never delivers");
	}),
);

test(
	"reload while busy keeps the same process, and the new instance can still stop it",
	withFakeCli(withFacts(async (facts) => {
		const first = await fresh();
		await first.emit("session_start", { reason: "startup" });
		const { job } = await launchWorker(first, "HANG");
		const pid = job.pid;
		const rpc = job.rpc;
		await message(first, "sa-1", "SAY:queued-never");
		await first.emit("session_shutdown", { reason: "reload" });
		const second = fakePi();
		bashBackground(second.handle);
		await second.emit("session_start", { reason: "reload" });
		assert.equal(jobs()[0].pid, pid);
		assert.equal(jobs()[0].rpc, rpc);
		assert.equal(jobs()[0].worker.phase, "working", "still busy across the reload");
		const stopped = await second.stop().execute("s1", { id: "sa-1" });
		assert.match(stopped.content[0].text, /sa-1 worker process ended/);
		await waitFor(() => !groupAlive(pid));
		assert.equal(second.sent.length, 0, "a stopped worker never delivers");
		const tasks = readFacts(facts.path).filter((record) => record.kind === "task").map((record) => record.task);
		assert.deepEqual(tasks, ["HANG"], "the queued message was discarded with the process");
	})),
);

test(
	"wait yields at once beside a busy worker, without timers or delivery",
	withFakeCli(async () => {
		const app = await fresh();
		const { job } = await launchWorker(app, "HANG");
		const out = await app.wait().execute("w1", {});
		assert.equal(out.terminate, true);
		assert.match(out.content[0].text, /Still running: sa-1/);
		assert.match(out.content[0].text, /each result arrives automatically/);
		assert.deepEqual(out.details, { delivered: [], running: ["sa-1"] });
		assert.equal(app.sent.length, 0, "nothing delivered for a running worker");
		assert.equal(job.state, "running");
		const stopped = await app.stop().execute("s1", { id: "sa-1" });
		assert.match(stopped.content[0].text, /sa-1 worker process ended/);
	}),
);

test(
	"wait arms pending worker notices synchronously and never stops an idle worker",
	withFakeCli(async () => {
		const app = await fresh();
		const { job } = await launchWorker(app, "QUESTION:What is the status?");
		await waitFor(() => app.sent.length === 1, 10000);
		assert.equal(app.sent[0].message.customType, "subagent-message", "a question turn delivers its message");
		assert.equal(job.worker.phase, "idle");
		// Reach the settled/undelivered boundary the registry-poking way, in the
		// same macrotask as the wait call: a notice that arrived but was not
		// delivered yet (a reload gap, a stale handle) must arm on wait.
		app.sent.length = 0;
		job.worker.notices.push({ kind: "reply", text: "late-synthetic-notice", turn: 9 });
		const out = await app.wait().execute("w1", {});
		assert.equal(out.terminate, true);
		assert.match(out.content[0].text, /delivered for: sa-1/);
		assert.match(out.content[0].text, /Workers awaiting input or follow-up: sa-1 \(input\)/);
		assert.doesNotMatch(out.content[0].text, /Still running: sa-1/);
		assert.deepEqual(out.details.running, [], "addressable input-waiting workers are not promised to resume automatically");
		assert.equal(app.sent.length, 1, "the wait armed the notice synchronously");
		assert.equal(app.sent[0].message.customType, "subagent-reply");
		assert.match(app.sent[0].message.content, /late-synthetic-notice/);
		assert.equal(groupAlive(job.pid), true, "an idle worker is not stopped by wait");
		assert.equal(job.worker.phase, "idle");
		const again = await app.wait().execute("w2", {});
		assert.equal(again.terminate, true);
		assert.equal(app.sent.length, 1, "consumed notices are never repeated");
	}),
);

test("stop refuses an unknown worker id; wait refuses legacy arguments", async () => {
	const app = await fresh();
	const stopped = await app.stop().execute("c2", { id: "sa-9" });
	assert.match(stopped.content[0].text, /No background job sa-9 in this session\./);
	assert.match(stopped.content[0].text, /Only jobs started here can be stopped\./);
	await assert.rejects(app.wait().execute("c1", { id: "sa-9" }), /wait takes no arguments/);
});

test(
	"a mixed wait arms both kinds' settled endings exactly once",
	withFakeCli(async () => {
		const app = await fresh();
		await app.bash().execute("c1", { command: "echo mixed-bash-out", background: true }, undefined, undefined, testCtx("/tmp"));
		await launchWorker(app, "FAIL:mixed-child");
		await waitFor(() => jobs().length === 2 && jobs().every((job) => job.state === "exited"));
		// Same sub-tick boundary, same macrotask: reset delivery and call wait
		// synchronously so no poller tick can interleave.
		for (const job of jobs()) job.notified = false;
		app.sent.length = 0;
		const out = await app.wait().execute("c3", {});
		assert.equal(out.terminate, true);
		assert.match(out.content[0].text, /delivered for: bg-1, sa-2/);
		await waitFor(() => app.sent.length === 2);
		assert.match(app.sent[0].message.content, /mixed-bash-out/);
		assert.match(app.sent[1].message.content, /sa-2 process ended \(exit code 1\)/);
		const again = await app.wait().execute("c4", {});
		assert.equal(app.sent.length, 2, "no repetition on the next yield");
	}),
);

test(
	"stop ends a busy worker, delivers nothing further, and closes the address",
	withFakeCli(async () => {
		const app = await fresh();
		const { job } = await launchWorker(app, "HANG");
		const pid = job.pid;
		const stopped = await app.stop().execute("s1", { id: "sa-1" });
		assert.match(stopped.content[0].text, /sa-1 worker process ended \(exit code 0\)/, "the fake Pi exits cleanly when shut down");
		assert.equal(job.state, "exited");
		assert.equal(jobs().length, 0, "explicit stop forgets the worker, not just its running process");
		assert.equal(WorkerRpc.get(pid), undefined);
		await waitFor(() => !groupAlive(pid));
		await new Promise((r) => setTimeout(r, 800));
		assert.equal(app.sent.length, 0, "a stopped worker sends no completion");
		await assert.rejects(message(app, "sa-1", "RECALL"), /No addressable worker sa-1 in this session\./);
	}),
);

test(
	"natural completion retains workers; explicit stop forgets only its target, including across reload",
	withFakeCli(async () => {
		const app = await fresh();
		const first = await launchWorker(app, "SAY:first");
		const second = await launchWorker(app, "SAY:second");
		await waitFor(() => app.sent.length === 2);
		assert.equal(jobs().length, 2, "natural completion leaves both workers available");
		assert.ok(jobs().every((job) => job.worker.phase === "idle"));
		const stopped = await app.stop().execute("s1", { id: first.job.id });
		assert.match(stopped.content[0].text, /worker removed from this session/);
		assert.deepEqual(jobs().map((job) => job.id), [second.job.id]);
		assert.equal(groupAlive(first.job.pid), false);
		await assert.rejects(message(app, first.job.id, "SAY:no"), /No addressable worker/);
		await app.emit("session_shutdown", { reason: "reload" });
		const reloaded = fakePi();
		bashBackground(reloaded.handle);
		await reloaded.emit("session_start", { reason: "reload" });
		assert.deepEqual(jobs().map((job) => job.id), [second.job.id], "reload cannot restore a stopped worker");
		await message(reloaded, second.job.id, "SAY:still-here");
		await waitFor(() => reloaded.sent.length === 1);
		assert.equal(noticeText(reloaded.sent[0]), "still-here");
		await reloaded.stop().execute("s2", { id: second.job.id });
		assert.equal(jobs().length, 0);
		await reloaded.commands.get("bg").handler("", testCtx("/tmp"));
		assert.deepEqual(reloaded.entries.at(-1).data.jobs, []);
		const again = await reloaded.stop().execute("s3", { id: first.job.id });
		assert.equal(again.details.found, false);
	}),
);

test(
	"a denied stop keeps the worker visible until termination succeeds",
	withFakeCli(async () => {
		const app = await fresh();
		const { job } = await launchWorker(app, "HANG");
		const kill = process.kill;
		const closeInput = job.rpc.closeInput;
		try {
			// Keep the fixture alive to exercise a real unresolved stop, without
			// requiring another user's process or actually changing permissions.
			job.rpc.closeInput = () => {};
			process.kill = function (pid, signal) {
				if (pid === -job.pid && signal !== 0) throw Object.assign(new Error("denied"), { code: "EPERM" });
				return kill.call(process, pid, signal);
			};
			const stopped = await app.stop().execute("s1", { id: job.id });
			assert.match(stopped.content[0].text, /could not be stopped/);
			assert.equal(job.stopFailed, "denied");
			assert.equal(jobs()[0], job, "a possibly live worker must never be silently forgotten");
			assert.equal(groupAlive(job.pid), true);
			await job.rpc.request({ type: "abort" });
			await waitFor(() => app.sent.length === 1);
			assert.equal(app.sent[0].message.details.reason, "interrupted", "a failed stop must not mute subsequent errors");
			await message(app, job.id, "SAY:still reporting");
			await waitFor(() => app.sent.length === 2);
			assert.equal(noticeText(app.sent[1]), "still reporting", "a retained worker can still report replies");
		} finally {
			process.kill = kill;
			job.rpc.closeInput = closeInput;
		}
		await app.stop().execute("s2", { id: job.id });
		assert.equal(jobs().length, 0, "a subsequent successful stop removes the worker");
	}),
);

test(
	"a worker retained after denied stop can still report a later process exit",
	withFakeCli(async () => {
		const app = await fresh();
		const { job } = await launchWorker(app, "HANG");
		const kill = process.kill;
		const closeInput = job.rpc.closeInput;
		try {
			job.rpc.closeInput = () => {};
			process.kill = function (pid, signal) {
				if (pid === -job.pid && signal !== 0) throw Object.assign(new Error("denied"), { code: "EPERM" });
				return kill.call(process, pid, signal);
			};
			await app.stop().execute("denied", { id: job.id });
		} finally {
			process.kill = kill;
			job.rpc.closeInput = closeInput;
		}
		kill.call(process, -job.pid, "SIGKILL");
		await waitFor(() => app.sent.length === 1);
		assert.match(app.sent[0].message.content, /^Worker sa-1 process ended/);
		assert.match(app.sent[0].message.content, /signal SIGKILL/);
	}),
);

test(
	"stop cleans up the worker's own detached descendants",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh();
		const { job } = await launchWorker(app, "BG-SLEEP-HANG:30");
		const descendant = await waitFor(() => readFacts(facts.path).find((record) => record.kind === "descendant"));
		assert.ok(descendant.pid, "worker spawned a detached descendant");
		const stopped = await app.stop().execute("s1", { id: "sa-1" });
		assert.match(stopped.content[0].text, /sa-1 worker process ended/);
		await waitFor(() => !groupAlive(descendant.pid), 10000);
		assert.equal(groupAlive(descendant.pid), false, "the worker's detached background job died with it");
		await waitFor(() => !groupAlive(job.pid));
	})),
);

test(
	"stop outwaits a child whose own escalation is still in flight (c-116 race)",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh();
		// The child's TERM-immune detached loop plus a 3s shutdown: longer than
		// the old 2s parent grace (which SIGKILLed the child mid-cleanup and
		// orphaned the detached group - reproduced live), well under the
		// subagent grace the fix adds.
		const { job } = await launchWorker(app, "BG-TRAP-SLOW-HANG:3000");
		const descendant = await waitFor(() => readFacts(facts.path).find((record) => record.kind === "descendant"));
		const stopped = await app.stop().execute("s1", { id: "sa-1" });
		assert.match(stopped.content[0].text, /sa-1 worker process ended \(exit code 0\)/, "the parent outwaited the child's cleanup instead of killing it");
		await waitFor(() => !groupAlive(descendant.pid), 10000);
		assert.equal(groupAlive(descendant.pid), false, "the child finished its own escalation before the parent gave up waiting");
		await waitFor(() => !groupAlive(job.pid));
	})),
);

test(
	"explicit stop also forgets an already-ended worker",
	withFakeCli(async () => {
		const app = await fresh();
		await launchWorker(app, "FAIL:already-gone");
		await waitFor(() => app.sent.length === 1);
		const stopped = await app.stop().execute("s1", { id: "sa-1" });
		assert.match(stopped.content[0].text, /sa-1 worker process ended \(exit code 1\); worker removed from this session\./);
		assert.equal(stopped.details.state, "exited");
		assert.equal(jobs().length, 0);
	}),
);

test(
	"quit stops idle and busy workers, clears the registry, and leaves no orphans",
	withFakeCli(async () => {
		const app = await fresh();
		await app.emit("session_start", { reason: "startup" });
		const idle = await launchWorker(app, "SAY:done-working");
		await waitFor(() => app.sent.length === 1);
		const busy = await launchWorker(app, "HANG");
		await app.emit("session_shutdown", { reason: "quit" });
		await waitFor(() => !groupAlive(idle.job.pid) && !groupAlive(busy.job.pid), 10000);
		assert.equal(jobs().length, 0, "the registry is cleared");
		assert.equal(app.sent.length, 1, "no completions for jobs stopped at quit");
	}),
);

test(
	"a replaced session never adopts a running worker",
	withFakeCli(async () => {
		const first = await fresh();
		await first.emit("session_start", { reason: "startup" });
		const { job } = await launchWorker(first, "HANG");
		const pid = job.pid;
		await first.emit("session_shutdown", { reason: "new" });
		const second = fakePi();
		bashBackground(second.handle);
		await second.emit("session_start", { reason: "resume" });
		assert.equal(second.sent.length, 0);
		const orphan = await second.wait().execute("c1", {});
		assert.equal(orphan.terminate, true);
		assert.deepEqual(orphan.details, { delivered: [], running: [] }, "the orphaned worker is neither adopted nor delivered");
		assert.equal(second.sent.length, 0, "an orphaned worker is not delivered");
		await waitFor(() => !groupAlive(pid), 10000);
	}),
);

test(
	"a child UI request is declined automatically and surfaced as a worker message",
	withFakeCli(withFacts(async (facts) => {
		const app = await fresh();
		const { job } = await launchWorker(app, "UI-ASK:May I edit the flake?");
		await waitFor(() => app.sent.length >= 2, 10000);
		assert.deepEqual(
			app.sent.map((s) => s.message.customType),
			["subagent-message", "subagent-reply"],
			"the declined request arrives as a message, then the turn's reply",
		);
		assert.match(app.sent[0].message.content, /Child UI request declined \(confirm\): May I edit the flake\?/);
		assert.match(app.sent[0].message.content, /Use message to ask the parent instead\./);
		assert.match(app.sent[1].message.content, /declined: May I edit the flake\?/, "the child saw the decline and finished its turn");
		const response = readFacts(facts.path).find((record) => record.kind === "ui-response");
		assert.equal(response.cancelled, true, "the decline reached the child as a cancellation");
		assert.equal(job.worker.fatal, undefined, "a declined UI request is not a transport failure");
		assert.equal(job.worker.phase, "idle");
	})),
);

test(
	"the footer shows working with elapsed time, then stays as sa-N idle instead of clearing",
	withFakeCli(async () => {
		const app = await fresh();
		const uiCtx = { ui: app.ui(), hasUI: true };
		await app.emit("session_start", { reason: "startup" }, uiCtx);
		await launchWorker(app, "SLOW-SAY:1.2:footer-check");
		const texts = () => app.status.filter((s) => s.key === "bash-bg").map((s) => s.text);
		await waitFor(() => texts().some((t) => /^sa-1 working \d+s$/.test(t ?? "")), 5000);
		await waitFor(() => app.sent.length === 1, 10000);
		await waitFor(() => texts().at(-1) === "sa-1 idle", 5000);
		await new Promise((r) => setTimeout(r, 700));
		assert.equal(texts().at(-1), "sa-1 idle", "an idle persistent worker keeps its footer line instead of clearing it");
	}),
);

test(
	"the /bg card lists worker tasks beside bash commands",
	withFakeCli(async () => {
		const app = await fresh();
		await app.emit("session_start", { reason: "startup" }, { ui: app.ui(), hasUI: true });
		await app.bash().execute("c1", { command: "sleep 30", background: true }, undefined, undefined, testCtx("/tmp"));
		await launchWorker(app, "HANG-review the flake");
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
