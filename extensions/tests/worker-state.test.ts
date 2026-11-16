import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWorkerRecord, boundedText, contentText, newWorkerState, validateWorkerMessage, WORKER_MESSAGE_ENTRY, TRANSCRIPT_BYTES, workerLabel, workerStatus } from "../lib/worker-state.ts";

test("worker turns become idle and retain a conversation without replaying prior answers", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	applyWorkerRecord(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } });
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.phase, "idle");
	assert.equal(state.notices[0].text, "first answer");
	applyWorkerRecord(state, { type: "agent_start" });
	applyWorkerRecord(state, { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "wait" }] } });
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.turn, 2);
	assert.match(state.notices[1].text, /ended its turn without a reply/);
	assert.equal(state.notices[1].reason, "unexplained");
	assert.ok(state.transcript.includes("first answer"));
});

test("streaming text is visible live but finalized once", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
	assert.equal(state.partial, "partial");
	applyWorkerRecord(state, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial complete" }] } });
	assert.equal(state.partial, "");
	assert.equal(state.transcript, "Assistant:\npartial complete\n");
});

test("parallel tools remain visible until all settle", () => {
	const state = newWorkerState();
	for (const id of ["one", "two"]) applyWorkerRecord(state, { type: "tool_execution_start", toolCallId: id, toolName: id, args: {} });
	assert.equal(state.activity, "one, two");
	applyWorkerRecord(state, { type: "tool_execution_end", toolCallId: "one", toolName: "one", result: { content: [] } });
	assert.equal(state.activity, "two");
	applyWorkerRecord(state, { type: "tool_execution_end", toolCallId: "two", toolName: "two", result: { content: [] } });
	assert.equal(state.activity, "thinking");
});

test("only the child message entry is forwarded, attributed later by the parent", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "entry_appended", entry: { customType: "unrelated", data: { text: "not mail" } } });
	applyWorkerRecord(state, { type: "entry_appended", entry: { customType: WORKER_MESSAGE_ENTRY, data: { text: "question?", from: "spoof" } } });
	assert.deepEqual(state.notices, [{ kind: "message", text: "question?", turn: 0, source: "parent" }]);
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.notices.length, 1, "a question followed by yield must not produce a redundant idle wake");
});

test("failed and aborted turns report honestly and can be followed by another turn", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	applyWorkerRecord(state, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" } });
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.phase, "failed");
	assert.equal(state.notices[0].text, "provider failed");
	applyWorkerRecord(state, { type: "agent_start" });
	assert.equal(state.phase, "working");
	assert.equal(state.error, undefined);
});

test("reports and transcript windows do not split Unicode", () => {
	const text = "界".repeat(100000);
	assert.doesNotMatch(boundedText(text, 1000), /\uFFFD/);
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "message_end", message: { role: "assistant", content: text } });
	assert.ok(Buffer.byteLength(state.transcript) <= TRANSCRIPT_BYTES);
	assert.doesNotMatch(state.transcript, /\uFFFD/);
});

test("human-driven replies identify their source without copying the human message to the parent", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	applyWorkerRecord(state, { type: "message_end", message: { role: "custom", customType: "worker-inbox", details: { from: "human" }, content: "private direct instruction" } });
	applyWorkerRecord(state, { type: "message_end", message: { role: "assistant", content: "answer" } });
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.notices[0].source, "human");
	assert.equal(state.notices[0].text, "answer");
});

test("mail backlog is bounded and reports a fatal overflow instead of growing RAM", () => {
	const state = newWorkerState();
	for (let i = 0; i < 200; i++) applyWorkerRecord(state, { type: "entry_appended", entry: { customType: WORKER_MESSAGE_ENTRY, data: { text: `message ${i}` } } });
	assert.equal(state.fatal, true);
	assert.equal(state.phase, "failed");
	assert.equal(state.notices.length, 1);
	assert.match(state.notices[0].text, /backlog exceeded/);
});

function assistant(state, text = "", tools = []) {
	applyWorkerRecord(state, { type: "message_end", message: { role: "assistant", content: [
		...(text ? [{ type: "text", text }] : []), ...tools.map((name) => ({ type: "toolCall", name })),
	], stopReason: tools.length ? "toolUse" : "stop" } });
}

function yieldWorker(state, running = [], text = "") {
	assistant(state, text, ["wait"]);
	applyWorkerRecord(state, { type: "tool_execution_end", toolName: "wait", result: {
		content: [{ type: "text", text: "not parsed as status" }], details: { running }, terminate: true,
	} });
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
}

test("waiting on child jobs is quiet, keeps ids visible, and resumes into a real reply", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	yieldWorker(state, ["bg-3"], "Tests are running; this is progress, not a reply.");
	assert.equal(state.phase, "idle", "Pi run is idle, not task complete");
	assert.equal(state.settlement, "waiting-jobs");
	assert.equal(workerLabel(state), "waiting");
	assert.match(workerStatus(state), /bg-3; resumes automatically/);
	assert.equal(state.notices.length, 0, "no parent wakeup, including pre-wait text");
	applyWorkerRecord(state, { type: "agent_start" });
	assert.equal(workerLabel(state), "working");
	applyWorkerRecord(state, { type: "message_end", message: { role: "custom", customType: "bash-background-result", details: { id: "bg-3" }, content: "done" } });
	assistant(state, "Final report");
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.settlement, "reply");
	assert.deepEqual(state.pendingJobs, []);
	assert.equal(state.notices.length, 1);
	assert.equal(state.notices[0].text, "Final report");
	assert.equal(state.notices[0].trigger, "background");
});

test("questions arrive immediately; subsequent input wait adds no reply or progress duplicate", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	applyWorkerRecord(state, { type: "entry_appended", entry: { customType: WORKER_MESSAGE_ENTRY, data: { text: "Which database?" } } });
	assert.equal(state.notices.length, 1, "message is available before settlement");
	yieldWorker(state, [], "I need an answer first.");
	assert.equal(state.settlement, "waiting-input");
	assert.equal(workerLabel(state), "input");
	assert.match(workerStatus(state), /waiting for input/);
	assert.equal(state.notices.length, 1);
});

test("an empty wait without a message or job reports unexplained termination, not a reply", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	yieldWorker(state, [], "Plan: implement, verify, then commit.");
	assert.equal(workerLabel(state), "unexplained");
	assert.equal(state.notices[0].kind, "status");
	assert.equal(state.notices[0].reason, "unexplained");
	assert.match(state.notices[0].text, /will not resume automatically/);
	assert.doesNotMatch(state.notices[0].text, /Plan:/);
});

test("a textless natural stop is unexplained; whitespace is not a reply", () => {
	for (const text of ["", "  \n "]) {
		const state = newWorkerState();
		applyWorkerRecord(state, { type: "agent_start" });
		assistant(state, text);
		applyWorkerRecord(state, { type: "agent_settled", aborted: false });
		assert.equal(state.settlement, "unexplained");
	}
});

test("a final response after a mixed wait/tool batch is a reply, not stale waiting", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	assistant(state, "Progress", ["wait", "read"]);
	applyWorkerRecord(state, { type: "tool_execution_end", toolName: "wait", result: { terminate: true, content: [], details: { running: ["bg-1"] } } });
	assistant(state, "Actual answer");
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.settlement, "reply");
	assert.equal(state.notices[0].text, "Actual answer");
});

test("aborts and errors override quiet waiting and messages, then clear on reuse", () => {
	for (const aborted of [true, false]) {
		const state = newWorkerState();
		applyWorkerRecord(state, { type: "agent_start" });
		applyWorkerRecord(state, { type: "entry_appended", entry: { customType: WORKER_MESSAGE_ENTRY, data: { text: "Progress" } } });
		assistant(state, "", ["wait"]);
		applyWorkerRecord(state, { type: "tool_execution_end", toolName: "wait", result: { terminate: true, content: [], details: { running: ["bg-1"] } } });
		if (!aborted) state.error = "provider failed";
		applyWorkerRecord(state, { type: "agent_settled", aborted });
		assert.equal(state.notices.length, 2);
		assert.equal(state.notices[1].kind, "error");
		assert.equal(state.notices[1].reason, aborted ? "interrupted" : "error");
		if (aborted) assert.match(state.notices[1].text, /interrupted.*No automatic continuation/);
		applyWorkerRecord(state, { type: "agent_start" });
		assistant(state, "Recovered");
		applyWorkerRecord(state, { type: "agent_settled", aborted: false });
		assert.equal(state.settlement, "reply");
		assert.equal(state.notices[2].text, "Recovered");
	}
});

test("assistant abort stopReason is an interruption even if settled omits aborted", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	applyWorkerRecord(state, { type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.settlement, "interrupted");
	assert.equal(workerLabel(state), "interrupted");
});

test("job metadata tracks launches, completion, and stop without reading output or leaking old jobs", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	assistant(state, "Progress", ["bash"]);
	for (const id of ["bg-1", "bg-2"]) applyWorkerRecord(state, { type: "tool_execution_end", toolName: "bash", result: { content: [], details: { backgroundJob: { id } } } });
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.settlement, "waiting-jobs");
	assert.equal(state.notices.length, 0);
	applyWorkerRecord(state, { type: "agent_start" });
	applyWorkerRecord(state, { type: "message_end", message: { role: "custom", customType: "bash-background-result", details: { id: "bg-1" } } });
	applyWorkerRecord(state, { type: "tool_execution_end", toolName: "stop", result: { content: [], details: { id: "bg-2", state: "exited" } } });
	assistant(state, "", ["other-tool"]);
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.deepEqual(state.pendingJobs, []);
	assert.equal(state.settlement, "unexplained");
});

test("wait status ignores malformed ids, errors, nested waits and unrelated result text", () => {
	for (const extra of [{ isError: true }, { parentToolCallId: "outer" }]) {
		const state = newWorkerState();
		applyWorkerRecord(state, { type: "agent_start" });
		assistant(state, "", ["wait"]);
		applyWorkerRecord(state, { type: "tool_execution_end", toolName: "wait", result: { terminate: true, content: [], details: { running: ["bg-1"] } }, ...extra });
		applyWorkerRecord(state, { type: "agent_settled", aborted: false });
		assert.equal(state.settlement, "unexplained");
	}
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	yieldWorker(state, ["bg-1", "bg-1", null, "oops", "bg-" + "1".repeat(1000)]);
	assert.deepEqual(state.pendingJobs, ["bg-1"]);
});

test("a completion steered into a parent-started run is not falsely labeled its wakeup trigger", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	applyWorkerRecord(state, { type: "message_end", message: { role: "user", content: "Do work" } });
	assistant(state, "Progress", ["bash"]);
	applyWorkerRecord(state, { type: "message_end", message: { role: "custom", customType: "bash-background-result", details: { id: "bg-1" } } });
	assistant(state, "Actual reply");
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.notices[0].trigger, undefined);
	assert.equal(state.notices[0].source, "parent");
});

test("empty provider errors still notify, and a later successful retry does not retain a stale error", () => {
	const state = newWorkerState();
	applyWorkerRecord(state, { type: "agent_start" });
	applyWorkerRecord(state, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "" } });
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.settlement, "error");
	assert.equal(state.notices[0].reason, "error");
	assert.match(state.notices[0].text, /Worker response error/);
	applyWorkerRecord(state, { type: "agent_start" });
	applyWorkerRecord(state, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "temporary error" } });
	assistant(state, "Retry succeeded");
	applyWorkerRecord(state, { type: "agent_settled", aborted: false });
	assert.equal(state.settlement, "reply");
	assert.equal(state.notices[1].text, "Retry succeeded");
});

test("message input has explicit nonempty and byte bounds", () => {
	assert.throws(() => validateWorkerMessage("  "), /non-empty/);
	assert.throws(() => validateWorkerMessage("界".repeat(6000)), /exceeds/);
	assert.equal(validateWorkerMessage("hello"), "hello");
	assert.equal(contentText([{ type: "image" }, { type: "text", text: "yes" }]), "yes");
});
