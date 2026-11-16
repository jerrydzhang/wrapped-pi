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

test("registers bash with background plus stop and wait, keeping the builtin shape", () => {
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
	assert.equal(app.stop().name, "stop");
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
		assert.deepEqual(out.details, { truncation: undefined, backgroundJob: { id: "bg-1" } }, "worker status tracks the structured job id, not result text");
		assert.match(out.content[0].text, /delivered here automatically/);
		assert.match(out.content[0].text, /instead of polling/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("completion is a custom steer with triggerTurn, delivered exactly once", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const out = await app.bash().execute("c1", { command: "echo natural-exit; echo second-line", background: true }, undefined, undefined, testCtx("/tmp"));
	assert.equal(app.sent.length, 0, "nothing delivered at start");
	await waitFor(() => app.sent.length === 1);
	const { message, options } = app.sent[0];
	assert.equal(message.customType, "bash-background-result");
	assert.equal(message.display, true);
	assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
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

test("stop terminates the group and no completion follows", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const out = await app.bash().execute("c1", { command: "sleep 30", background: true }, undefined, undefined, testCtx("/tmp"));
	const pid = pidFrom(out.content[0].text);
	const stopped = await app.stop().execute("c2", { id: "bg-1" });
	assert.match(stopped.content[0].text, /bg-1 stopped \(command group gone\)/);
	await waitFor(() => !groupAlive(pid));
	await new Promise((r) => setTimeout(r, 700));
	assert.equal(app.sent.length, 0, "a command the agent stopped sends no completion");
});

test("stopping an unknown or finished id is honest", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const unknown = await app.stop().execute("c1", { id: "bg-9" });
	assert.match(unknown.content[0].text, /No background job bg-9/);
	const armed = await app.bash().execute("c2", { command: "echo quick", background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => app.sent.length === 1);
	const late = await app.stop().execute("c3", { id: "bg-1" });
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
	const orphan = await second.stop().execute("c1", { id: "bg-1" });
	assert.match(orphan.content[0].text, /No background job bg-1/);
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
		app.stop().execute("c2", { id: "bg-1" }),
		app.stop().execute("c3", { id: "bg-1" }),
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

function uiCtx(app) {
	return { ui: app.ui(), hasUI: true };
}

function statusTexts(app) {
	return app.status.filter((s) => s.key === "bash-bg").map((s) => s.text);
}

test("footer status tracks running jobs and clears when nothing is pending", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.emit("session_start", { reason: "startup" }, uiCtx(app));
	await app.bash().execute("c1", { command: "sleep 4", background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => statusTexts(app).some((t) => /^bg-1 \d+s$/.test(t ?? "")), 5000);
	await waitFor(() => app.sent.length === 1, 10000);
	await waitFor(() => statusTexts(app).at(-1) === undefined, 5000);
});

test("timed jobs render elapsed/total in the footer", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.emit("session_start", { reason: "startup" }, uiCtx(app));
	await app.bash().execute("c1", { command: "sleep 30", background: true, timeout: 1 }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => statusTexts(app).some((t) => /^bg-1 \d+s\/1s$/.test(t ?? "")), 5000);
	await waitFor(() => app.sent.length === 1, 10000);
	await waitFor(() => statusTexts(app).at(-1) === undefined, 5000);
});

test("/bg appends a snapshot card without model context, then an empty card", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.emit("session_start", { reason: "startup" }, uiCtx(app));
	await app.bash().execute("c1", { command: "sleep 30", background: true }, undefined, undefined, testCtx("/tmp"));
	await app.bash().execute("c2", { command: "sleep 30", background: true, timeout: 2 }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => statusTexts(app).some((t) => (t ?? "").includes("bg-2")), 5000);
	assert.ok(app.renderers.has("bash-bg-status"), "card renderer registered");
	await app.bgCommand().handler("", { ui: app.ui() });
	assert.equal(app.entries.length, 1);
	const card = app.entries[0];
	assert.equal(card.customType, "bash-bg-status");
	assert.ok(card.data.at, "check timestamp recorded");
	assert.deepEqual(
		card.data.jobs.map((j) => [j.id, j.command, j.timeoutMs]),
		[
			["bg-1", "sleep 30", undefined],
			["bg-2", "sleep 30", 2000],
		],
	);
	assert.ok(card.data.jobs.every((j) => j.elapsedMs >= 0));
	await app.stop().execute("c3", { id: "bg-1" });
	await app.stop().execute("c4", { id: "bg-2" });
	await app.bgCommand().handler("", { ui: app.ui() });
	assert.equal(app.entries.length, 2);
	assert.deepEqual(app.entries[1].data.jobs, [], "empty check records no jobs");
	assert.equal(app.sent.length, 0, "stopped jobs deliver no completions");
});

test("session shutdown stops jobs and clears the footer status", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.emit("session_start", { reason: "startup" }, uiCtx(app));
	await app.bash().execute("c1", { command: "sleep 30", background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => statusTexts(app).some((t) => /^bg-1 \d+s$/.test(t ?? "")), 5000);
	await app.emit("session_shutdown", { reason: "quit" }, uiCtx(app));
	await waitFor(() => statusTexts(app).at(-1) === undefined, 5000);
	assert.equal(jobs().length, 0, "registry cleared on shutdown");
});

test("card commands are capped to a single 80-char line", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.emit("session_start", { reason: "startup" }, uiCtx(app));
	const pad = "a".repeat(180);
	await app.bash().execute("c1", { command: `sleep 30; echo ${pad}`, background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => statusTexts(app).some((t) => /^bg-1 \d+s$/.test(t ?? "")), 5000);
	await app.bgCommand().handler("", { ui: app.ui() });
	const command = app.entries[0].data.jobs[0].command;
	assert.equal(command.length, 80, "77 chars plus the ellipsis");
	assert.match(command, /^sleep 30; echo a+\.+$/, "capped with an ellipsis");
	assert.ok(!command.includes("\n"), "newlines collapsed");
	await app.stop().execute("c2", { id: "bg-1" });
});

// ---- wait ----

test("registers wait as a strict no-argument model-only yield", () => {
	const app = fresh();
	bashBackground(app.handle);
	const wait = app.wait();
	assert.equal(wait.name, "wait");
	assert.equal(wait.label, "Wait for input");
	assert.deepEqual(wait.parameters.properties, {}, "no parameters at all");
	assert.equal(wait.parameters.additionalProperties, false, "strict schema rejects legacy keys before execute");
	assert.equal(wait.exposure, "model-only");
	assert.match(wait.description, /no arguments/);
	assert.match(wait.description, /alone/);
	const guidelines = wait.promptGuidelines.join(" ");
	assert.match(guidelines, /useful work/);
	assert.match(guidelines, /wait alone/);
	assert.match(guidelines, /Never poll/);
});

test("wait refuses legacy arguments with the current usage", async () => {
	const app = fresh();
	bashBackground(app.handle);
	for (const legacy of [{ id: "bg-1" }, { all: true }, { timeout: 5 }, { id: "bg-1", timeout: 5 }]) {
		await assert.rejects(app.wait().execute("c1", legacy), /wait takes no arguments/);
	}
	assert.equal(app.sent.length, 0);
	assert.equal(jobs().length, 0, "refused calls arm and start nothing");
});

test("wait yields at once with no jobs", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const out = await app.wait().execute("c1", {});
	assert.equal(out.terminate, true);
	assert.match(out.content[0].text, /Yielding/);
	assert.equal(app.sent.length, 0);
});

test("wait leaves running jobs untouched and sets no timer", async () => {
	const app = fresh();
	bashBackground(app.handle);
	const armed = await app.bash().execute("c1", { command: "sleep 30", background: true }, undefined, undefined, testCtx("/tmp"));
	const pid = pidFrom(armed.content[0].text);
	const started = Date.now();
	const out = await app.wait().execute("c2", {});
	assert.ok(Date.now() - started < 4000, "returns without blocking on the job");
	assert.equal(out.terminate, true);
	assert.match(out.content[0].text, /Still running: bg-1/);
	assert.equal(app.sent.length, 0, "nothing delivered for a running job");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(jobs()[0].state, "running", "no timer fired; the job is untouched");
	assert.ok(groupAlive(pid), "the process group survives the yield");
	const stopped = await app.stop().execute("c3", { id: "bg-1" });
	assert.match(stopped.content[0].text, /stopped/);
	await waitFor(() => !groupAlive(pid));
});

test("wait arms every settled-undelivered result exactly once, never repeats", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.bash().execute("c1", { command: "echo quick-a", background: true }, undefined, undefined, testCtx("/tmp"));
	await app.bash().execute("c2", { command: "echo quick-b", background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => jobs().length === 2 && jobs().every((j) => j.state === "exited"));
	// The settled/undelivered boundary is sub-tick in practice (settle and
	// deliver share a tick), so the suite reaches it the registry-poking way:
	// real settled jobs reset to undelivered, in the same macrotask as the
	// wait call, so no poller tick can interleave.
	for (const job of jobs()) job.notified = false;
	app.sent.length = 0;
	const out = await app.wait().execute("c3", {});
	assert.equal(out.terminate, true);
	assert.match(out.content[0].text, /delivered for: bg-1, bg-2/);
	assert.equal(app.sent.length, 2, "both pending completions armed synchronously");
	assert.deepEqual(app.sent[0].options, { deliverAs: "steer", triggerTurn: true });
	assert.deepEqual(app.sent[1].options, { deliverAs: "steer", triggerTurn: true });
	assert.match(app.sent[0].message.content, /quick-a/);
	assert.match(app.sent[1].message.content, /quick-b/);
	const again = await app.wait().execute("c4", {});
	assert.equal(again.terminate, true);
	assert.doesNotMatch(again.content[0].text, /delivered for/);
	assert.equal(app.sent.length, 2, "consumed results are never repeated");
});

test("a settled job whose delivery the poller already made is not re-armed", async () => {
	const app = fresh();
	bashBackground(app.handle);
	await app.bash().execute("c1", { command: "echo delivered-once", background: true }, undefined, undefined, testCtx("/tmp"));
	await waitFor(() => app.sent.length === 1);
	const out = await app.wait().execute("c2", {});
	assert.equal(out.terminate, true);
	assert.match(out.content[0].text, /Yielding/);
	assert.equal(app.sent.length, 1, "no second completion");
});

test("wait arms a takeover job's pending completion after reload", async () => {
	const first = fresh();
	bashBackground(first.handle);
	await first.emit("session_start", { reason: "startup" });
	await first.bash().execute("c1", { command: "sleep 0.3; echo reload-wait-arm", background: true }, undefined, undefined, testCtx("/tmp"));
	await first.emit("session_shutdown", { reason: "reload" });
	const second = fakePi();
	bashBackground(second.handle);
	await second.emit("session_start", { reason: "reload" });
	await waitFor(() => jobs()[0].state === "exited");
	// Same sub-tick boundary, same macrotask: reset delivery and call wait
	// synchronously so no tick can interleave.
	jobs()[0].notified = false;
	second.sent.length = 0;
	const out = await second.wait().execute("c2", {});
	assert.equal(out.terminate, true);
	assert.equal(second.sent.length, 1, "the wait armed the pending completion once");
	assert.match(second.sent[0].message.content, /reload-wait-arm/);
	assert.equal(first.sent.length, 0, "the stale instance never delivers");
});

test("delivery waits through non-agent busy boundaries but still steers an active run", async () => {
	const app = fresh();
	bashBackground(app.handle);
	let idle = false;
	const ctx = { ...testCtx("/tmp"), isIdle: () => idle, signal: undefined };
	await app.emit("session_start", { reason: "startup" }, ctx);
	await app.bash().execute("a", { command: "printf compact-safe", background: true }, undefined, undefined, ctx);
	await waitFor(() => jobs()[0].state === "exited");
	assert.equal(app.sent.length, 0, "manual-compaction-like busy state must not start another run");
	ctx.signal = new AbortController().signal;
	await waitFor(() => app.sent.length === 1);
	assert.match(app.sent[0].message.content, /compact-safe/);
	assert.equal(app.sent[0].options.deliverAs, "steer", "ordinary active runs retain steering delivery");
	ctx.signal = undefined;
	await app.bash().execute("b", { command: "printf idle-safe", background: true }, undefined, undefined, ctx);
	await waitFor(() => jobs()[1].state === "exited");
	assert.equal(app.sent.length, 1);
	idle = true;
	await waitFor(() => app.sent.length === 2);
	assert.match(app.sent[1].message.content, /idle-safe/);
	await app.emit("session_shutdown", { reason: "quit" }, ctx);
});
