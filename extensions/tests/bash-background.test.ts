// Contracts over the fake ExtensionAPI and real child processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bashBackground from "../bash-background.ts";
import { fakePi, testCtx, resetRegistry, jobs, groupAlive, waitFor } from "./fake-pi.ts";
import { setBuiltinExecute, resetBuiltin, builtinCalls } from "./stubs/pi-coding-agent.mjs";

function fresh() {
	resetRegistry();
	resetBuiltin();
	return fakePi();
}

function pidFrom(armed) {
	const match = armed.match(/pid (\d+)/);
	assert.ok(match, "armed reply names a pid");
	return Number(match[1]);
}

test("registers bash with background plus bash_stop, keeping the builtin shape", () => {
	const app = fresh();
	bashBackground(app.handle);
	const bash = app.bash();
	assert.equal(bash.name, "bash");
	assert.ok(bash.parameters.properties.background, "background flag added");
	assert.ok(bash.parameters.properties.command, "command kept");
	assert.ok(bash.parameters.properties.timeout, "timeout kept");
	assert.ok(bash.description.includes("builtin ok") === false);
	assert.ok(bash.promptSnippet === "Execute bash commands (ls, grep, find, etc)");
	assert.deepEqual(bash.promptGuidelines, ["builtin guideline kept by the spread"]);
	assert.equal(app.bashStop().name, "bash_stop");
});

test("ordinary calls delegate to the builtin with only command and timeout", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const marker = { content: [{ type: "text", text: "delegated" }], details: { truncation: undefined } };
	setBuiltinExecute(() => marker);
	const signal = new AbortController().signal;
	const onUpdate = () => {};
	const ctx = testCtx("/tmp");
	const out = await app.bash().execute("call-1", { command: "ls", timeout: 7 }, signal, onUpdate, ctx);
	assert.equal(out, marker);
	assert.equal(builtinCalls().length, 1);
	assert.deepEqual(builtinCalls()[0].params, { command: "ls", timeout: 7 });
	assert.equal(builtinCalls()[0].signal, signal);
	assert.equal(builtinCalls()[0].onUpdate, onUpdate);
	assert.equal(builtinCalls()[0].ctx, ctx);
});

test("background start returns promptly with job id, log path and delivery contract", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const cwd = mkdtempSync(join(tmpdir(), "bash-bg-test-"));
	try {
		const started = Date.now();
		const out = await app.bash().execute("call-1", { command: "echo started-ok", background: true }, undefined, undefined, testCtx(cwd));
		assert.ok(Date.now() - started < 4000, "returns without waiting for the command");
		assert.match(out.content[0].text, /bg-1 started \(pid \d+\)/);
		assert.match(out.content[0].text, /Output streams to \S+/);
		assert.match(out.content[0].text, /No deadline\./);
		assert.match(out.content[0].text, /delivered here automatically/);
		assert.match(out.content[0].text, /instead of polling/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("completion is a custom followUp with triggerTurn, delivered exactly once", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const out = await app.bash().execute("c1", { command: "echo natural-exit; echo second-line", background: true }, undefined, undefined, testCtx("/tmp"));
	assert.equal(app.sent.length, 0, "nothing delivered at start");
	await waitFor(() => app.sent.length === 1);
	const { message, options } = app.sent[0];
	assert.equal(message.customType, "bash-background-result");
	assert.equal(message.display, true);
	assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
	assert.match(message.content, /Background command bg-1 exited with code 0/);
	assert.match(message.content, /natural-exit/);
	assert.match(message.content, /second-line/);
	assert.match(message.content, new RegExp(out.content[0].text.match(/Output streams to (\S+)/)[1]));
	await new Promise((r) => setTimeout(r, 700));
	assert.equal(app.sent.length, 1, "no duplicate completion");
});

test("nonzero exits are reported honestly", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.bash().execute("c1", { command: "echo before-fail; exit 3", background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => app.sent.length === 1);
	assert.match(app.sent[0].message.content, /failed: exited with code 3/);
	assert.match(app.sent[0].message.content, /before-fail/);
});

test("signal-killed commands follow the shell convention", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.bash().execute("c1", { command: "kill -9 $$", background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => app.sent.length === 1);
	assert.match(app.sent[0].message.content, /exited with code 137/);
});

test("invalid timeouts follow the pinned bash convention", async () => {
	const app = fresh();
	bashBackground(app.handle);
	for (const timeout of [0, -5, Number.NaN]) {
		await assert.rejects(
			app.bash().execute("c1", { command: "echo x", background: true, timeout }, undefined, undefined, testCtx("/tmp")),
			/Invalid timeout: must be a finite number of seconds/,
		);
	}
	await assert.rejects(
		app.bash().execute("c1", { command: "echo x", background: true, timeout: 99999999 }, undefined, undefined, testCtx("/tmp")),
		/Invalid timeout: maximum is/,
	);
	assert.equal(app.sent.length, 0);
	assert.equal(jobs().length, 0, "nothing armed on rejected calls");
});

test("a positive timeout stops the group and reports the deadline outcome", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const out = await app.bash().execute("c1", { command: "sleep 30", background: true, timeout: 1 }, undefined, undefined, testCtx("/tmp"));
	const pid = pidFrom(out.content[0].text);
	await waitFor(() => app.sent.length === 1, 10000);
	assert.match(app.sent[0].message.content, /timeout of 1s elapsed/);
	await waitFor(() => !groupAlive(pid));
});

test("bash_stop terminates the group and no completion follows", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const out = await app.bash().execute("c1", { command: "sleep 30", background: true }, undefined, undefined, testCtx("/tmp"));
	const pid = pidFrom(out.content[0].text);
	const stopped = await app.bashStop().execute("c2", { id: "bg-1" });
	assert.match(stopped.content[0].text, /bg-1 stopped \(command group gone\)/);
	await waitFor(() => !groupAlive(pid));
	await new Promise((r) => setTimeout(r, 700));
	assert.equal(app.sent.length, 0, "a command the agent stopped sends no completion");
});

test("stopping an unknown or finished id is honest", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const unknown = await app.bashStop().execute("c1", { id: "bg-9" });
	assert.match(unknown.content[0].text, /No background command bg-9/);
	const armed = await app.bash().execute("c2", { command: "echo quick", background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => app.sent.length === 1);
	const late = await app.bashStop().execute("c3", { id: "bg-1" });
	assert.match(late.content[0].text, /already finished/);
	assert.equal(app.sent.length, 1, "no second report after completion");
	assert.match(armed.content[0].text, /bg-1/);
});

test("aborting the starting call does not own the background command", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const controller = new AbortController();
	await app.bash().execute("c1", { command: "sleep 0.5; echo survived-abort", background: true }, controller.signal, undefined, testCtx("/tmp"));
	controller.abort();
	assert.equal(app.sent.length, 0);
	await waitFor(() => app.sent.length === 1);
	assert.match(app.sent[0].message.content, /survived-abort/);
});

test("background commands run in ctx.cwd with inherited and session env", async () => {
	const app = fresh();
	bashBackground(app.handle);
	process.env.SACCADE_TASK = "t-99";
	try {
		const cwd = mkdtempSync(join(tmpdir(), "bash-bg-cwd-"));
		try {
			await app.bash().execute(
				"c1",
				{ command: "pwd; echo $PI_SESSION_ID; echo $PI_MODEL; echo $SACCADE_TASK", background: true },
				undefined,
				undefined,
				testCtx(cwd),
			);
			await waitFor(() => app.sent.length === 1);
			const content = app.sent[0].message.content;
			assert.match(content, new RegExp(cwd.replaceAll("/", "/")));
			assert.match(content, /sess-test-1/);
			assert.match(content, /test-model/);
			assert.match(content, /t-99/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	} finally {
		delete process.env.SACCADE_TASK;
	}
});

test("a failed spawn is a visible error, never a fake armed reply", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await assert.rejects(
		app.bash().execute("c1", { command: "echo x", background: true }, undefined, undefined, testCtx("/nonexistent-cwd-xyz")),
		/Working directory does not exist|ENOENT|no such file/i,
	);
	assert.equal(jobs().length, 0);
	assert.equal(app.sent.length, 0);
});

test("reload keeps commands running and reconnects delivery to the new instance", async () => {
	const first = fresh();
	bashBackground(first.handle);
	await first.emit("session_start", { reason: "startup" });
	await first.bash().execute("c1", { command: "sleep 0.6; echo reloaded-delivery", background: true }, undefined, undefined, testCtx("/tmp"));
	await first.emit("session_shutdown", { reason: "reload" });
	const second = fakePi();
	bashBackground(second.handle);
	await second.emit("session_start", { reason: "reload" });
	await waitFor(() => second.sent.length === 1);
	assert.match(second.sent[0].message.content, /reloaded-delivery/);
	assert.equal(first.sent.length, 0, "the stale instance never delivers");
});

test("quit stops this session's commands", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.emit("session_start", { reason: "startup" });
	const out = await app.bash().execute("c1", { command: "sleep 30", background: true }, undefined, undefined, testCtx("/tmp"));
	const pid = pidFrom(out.content[0].text);
	await app.emit("session_shutdown", { reason: "quit" });
	await waitFor(() => !groupAlive(pid), 10000);
	assert.equal(jobs().length, 0);
});

test("a replaced session never adopts or delivers old jobs", async () => {
	const first = fresh();
	bashBackground(first.handle);
	await first.emit("session_start", { reason: "startup" });
	await first.bash().execute("c1", { command: "sleep 30", background: true }, undefined, undefined, testCtx("/tmp"));
	await first.emit("session_shutdown", { reason: "new" });
	const second = fakePi();
	bashBackground(second.handle);
	await second.emit("session_start", { reason: "resume" });
	assert.equal(second.sent.length, 0);
	const orphan = await second.bashStop().execute("c1", { id: "bg-1" });
	assert.match(orphan.content[0].text, /No background command bg-1/);
});

test("shutdown awaits escalation for TERM-ignoring commands before returning", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.emit("session_start", { reason: "startup" });
	const out = await app.bash().execute("c1", { command: "trap \"\" TERM; sleep 30", background: true }, undefined, undefined, testCtx("/tmp"));
	const pid = pidFrom(out.content[0].text);
	await app.emit("session_shutdown", { reason: "quit" });
	assert.equal(groupAlive(pid), false, "group gone the moment the awaited handler returns");
});

test("large single-line output is cut with an honest notice", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.bash().execute("c1", { command: "head -c 20000 </dev/zero | tr '\\0' 'x'", background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => app.sent.length === 1);
	assert.match(app.sent[0].message.content, /earlier output cut/);
	assert.match(app.sent[0].message.content, /xxxx/);
	assert.doesNotMatch(app.sent[0].message.content, /^Output:$/m);
});

test("user lines resembling the exit marker survive verbatim", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const cmd = "echo '__BASH_BG_EXIT__:0000000000000000:99'; echo marker-fine";
	await app.bash().execute("c1", { command: cmd, background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => app.sent.length === 1);
	assert.match(app.sent[0].message.content, /__BASH_BG_EXIT__:0000000000000000:99/);
	assert.match(app.sent[0].message.content, /marker-fine/);
	assert.match(app.sent[0].message.content, /exited with code 0/, "the real marker still settles the exit");
});

test("output cut mid-character stays valid UTF-8", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const cmd = "i=0; while [ $i -lt 1500 ]; do printf '★'; i=$((i+1)); done; echo done";
	await app.bash().execute("c1", { command: cmd, background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => app.sent.length === 1);
	assert.doesNotMatch(app.sent[0].message.content, /\uFFFD/);
	assert.match(app.sent[0].message.content, /done/);
});

test("concurrent stops join one escalation and report one outcome", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.bash().execute("c1", { command: "sleep 30", background: true }, undefined, undefined, testCtx("/tmp"));
	const [first, second] = await Promise.all([
		app.bashStop().execute("c2", { id: "bg-1" }),
		app.bashStop().execute("c3", { id: "bg-1" }),
	]);
	assert.equal(first.content[0].text, second.content[0].text);
	assert.match(first.content[0].text, /stopped \(command group gone\)/);
	assert.equal(app.sent.length, 0);
});

test("deadline delivery reconnects after reload with the timeout cause", async () => {
	const first = fresh();
	bashBackground(first.handle);
	await first.bash().execute("c1", { command: "sleep 30", background: true, timeout: 1 }, undefined, undefined, testCtx("/tmp"));
	await first.emit("session_shutdown", { reason: "reload" });
	const second = fakePi();
	bashBackground(second.handle);
	await second.emit("session_start", { reason: "reload" });
	await waitFor(() => second.sent.length === 1, 10000);
	assert.match(second.sent[0].message.content, /timeout of 1s elapsed/);
	assert.equal(first.sent.length, 0);
});
