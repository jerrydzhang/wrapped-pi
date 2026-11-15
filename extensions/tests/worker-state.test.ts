import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWorkerRecord, boundedText, contentText, newWorkerState, validateWorkerMessage, WORKER_MESSAGE_ENTRY, TRANSCRIPT_BYTES } from "../lib/worker-state.ts";

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
	assert.match(state.notices[1].text, /yielded/);
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

test("message input has explicit nonempty and byte bounds", () => {
	assert.throws(() => validateWorkerMessage("  "), /non-empty/);
	assert.throws(() => validateWorkerMessage("界".repeat(6000)), /exceeds/);
	assert.equal(validateWorkerMessage("hello"), "hello");
	assert.equal(contentText([{ type: "image" }, { type: "text", text: "yes" }]), "yes");
});
