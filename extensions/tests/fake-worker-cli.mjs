// Deterministic long-lived Pi RPC stand-in for the subagent suite. Speaks the
// RPC wire contract the parent relies on: strict LF-only JSONL on stdio,
// responses echoing the request id, readiness answers for get_state /
// get_commands, prompt accepted while busy (steered prompts queue), orderly
// exit 0 on stdin EOF, and a SIGTERM shutdown that cleans up the detached
// descendants it spawned. No model calls, no network, no user config.
//
// Task language - the initial prompt and every decoded inbox message is one
// task (busy workers queue tasks at the turn boundary):
//   SAY:text               reply with text
//   SLOW-SAY:seconds:text  reply with text after a delay
//   REMEMBER:value/RECALL  store and replay conversation memory across turns
//   QUESTION:text          send the parent a worker message, then yield idle
//   WAIT-JOBS:ms:text      yield with progress text, then auto-resume and reply
//   YIELD                  wait with no job or message (unexplained)
//   TURN-ERROR:text        end the turn with an error; the process stays up
//   FAIL:text              write text to stderr, then exit 1 (responses flush first)
//   HANG                   stay busy until shutdown (accepts queued steering)
//   UI-ASK:text            raise an extension_ui_request, wait for the parent's
//                          (declined) response, then reply "declined: text"
//   BG-SLEEP-HANG          spawn a detached descendant, stay busy
//   BG-TRAP-SLOW-HANG:ms   the same, TERM-immune, with an ms slow shutdown
//
// Inbox prompts enter the session as the custom "worker-inbox" message real
// Pi delivers for a slash command, carrying the sender - that is how the
// parent attributes a turn's source.
//
// When FAKE_PI_FACTS names a file, the fixture appends JSONL facts (each
// stamped with its pid): start (execPath/argv/extensions/model/cwd/env), rpc
// (handled command types in order), task, inbox (decoded sender + text),
// ui-response, descendant. FAKE_PI_DIE_AT_BOOT mirrors a real pi refusing
// non-interactive startup (unusable model): one stderr line, then exit 1
// before answering any command. FAKE_PI_NO_INBOX answers get_commands without
// the inbox - the other deterministic readiness failure.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const extensions = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === "-e") extensions.push(argv[++i]);
const model = argv[argv.indexOf("--model") + 1];
const noInbox = process.env.FAKE_PI_NO_INBOX === "1";
let pendingWrites = 0;
const facts = (data) => {
	if (process.env.FAKE_PI_FACTS) appendFileSync(process.env.FAKE_PI_FACTS, JSON.stringify({ pid: process.pid, ...data }) + "\n");
};
facts({ kind: "start", execPath: process.execPath, argvFull: process.argv, argv, extensions, model, cwd: process.cwd(), childMarker: process.env.WRAPPED_PI_CHILD,
	staleSessionEnv: ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"].filter((key) => process.env[key]),
	extensionsEnv: process.env.WRAPPED_PI_EXTENSIONS ?? null });
if (process.env.FAKE_PI_DIE_AT_BOOT === "1") {
	process.stderr.write("fake pi refused to start: unusable model\n", () => process.exit(1));
}

let busy = false;
let remembered = "";
let queue = [];
let timer;
let child;
let slowCleanup = 0;
let ending = false;
let uiSeq = 0;
let uiWaiter;
const emit = (record) => {
	pendingWrites += 1;
	process.stdout.write(JSON.stringify(record) + "\n", () => { pendingWrites -= 1; });
};
const answer = (command, data = {}) => emit({ type: "response", id: command.id, command: command.type, success: true, data });
const messageEnd = (text) => emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
function finish(text) {
	emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
	messageEnd(text);
	busy = false;
	emit({ type: "agent_settled", aborted: false });
	if (queue.length) { const next = queue.shift(); run(next.task, next.from); }
}
function run(task, from) {
	if (busy) { queue.push({ task, from }); return; }
	busy = true;
	facts({ kind: "task", task });
	emit({ type: "agent_start" });
	if (from) {
		emit({ type: "message_end", message: { role: "custom", customType: "worker-inbox", content: `Message from ${from}:\n${task}`, details: { from } } });
	} else {
		emit({ type: "message_end", message: { role: "user", content: task } });
	}
	if (task.startsWith("SLOW-SAY:")) {
		const match = /^SLOW-SAY:([\d.]+):([\s\S]*)$/.exec(task);
		timer = setTimeout(() => finish(match[2]), Number(match[1]) * 1000);
	} else if (task.startsWith("FAIL:")) {
		// Flush the already-queued disposition response before dying, so the
		// parent's launch or message resolves and the exit is the only surprise.
		process.stderr.write(`child failed: ${task.slice(5)}\n`, () => {
			const deadline = Date.now() + 2000;
			const exitWhenFlushed = () => {
				if (pendingWrites === 0 || Date.now() > deadline) process.exit(1);
				setTimeout(exitWhenFlushed, 5);
			};
			exitWhenFlushed();
		});
	} else if (task.startsWith("WAIT-JOBS:") || task === "YIELD") {
		const [, ms = "0", progress = ""] = task.split(":");
		emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [
			{ type: "text", text: progress }, { type: "toolCall", id: "wait-1", name: "wait", arguments: {} },
		] } });
		emit({ type: "tool_execution_end", toolCallId: "wait-1", toolName: "wait", isError: false,
			result: { content: [], details: { running: task === "YIELD" ? [] : ["bg-1"] }, terminate: true } });
		busy = false;
		emit({ type: "agent_settled", aborted: false });
		if (task !== "YIELD") timer = setTimeout(() => {
			busy = true;
			emit({ type: "agent_start" });
			emit({ type: "message_end", message: { role: "custom", customType: "bash-background-result", content: "job finished", details: { id: "bg-1" } } });
			finish("automatic final reply");
		}, Number(ms));
	} else if (task.startsWith("TURN-ERROR:")) {
		emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: task.slice(11) } });
		busy = false;
		emit({ type: "agent_settled", aborted: false });
	} else if (task.startsWith("QUESTION:")) {
		emit({ type: "entry_appended", entry: { type: "custom", customType: "wrapped-pi-worker-message", data: { text: task.slice(9) } } });
		busy = false;
		emit({ type: "agent_settled", aborted: false });
	} else if (task.startsWith("UI-ASK:")) {
		const question = task.slice(7);
		emit({ type: "extension_ui_request", id: `ui-${++uiSeq}`, method: "confirm", title: question, message: question });
		uiWaiter = () => finish(`declined: ${question}`);
	} else if (task.startsWith("REMEMBER:")) {
		remembered = task.slice(9);
		finish("remembered");
	} else if (task === "RECALL") finish(remembered);
	else if (task.startsWith("BG-")) {
		const immune = task.startsWith("BG-TRAP-SLOW-HANG:");
		slowCleanup = immune ? Number(task.split(":")[1]) : 0;
		child = spawn("sh", ["-c", immune ? 'trap "" TERM; while :; do sleep 0.1; done' : "sleep 300"], { detached: true, stdio: "ignore" });
		child.on("spawn", () => facts({ kind: "descendant", pid: child.pid, owner: process.pid }));
	} else if (task.startsWith("HANG")) {
		// Remain busy, but accept queued steering and shutdown over stdin.
	} else finish(task.startsWith("SAY:") ? task.slice(4) : task);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
		if (!line.trim()) continue;
		const command = JSON.parse(line);
		if (command.type === "get_state") {
			facts({ kind: "rpc", command: "get_state" });
			answer(command, { isStreaming: busy, model: { provider: "test", id: model }, sessionId: "fake-worker" });
		} else if (command.type === "get_commands") {
			facts({ kind: "rpc", command: "get_commands" });
			answer(command, { commands: noInbox ? [] : [{ name: "wrapped-pi-inbox" }] });
		} else if (command.type === "prompt") {
			facts({ kind: "rpc", command: "prompt" });
			let task = command.message;
			let from = null;
			if (task.startsWith("/wrapped-pi-inbox ")) {
				const packet = JSON.parse(Buffer.from(task.slice("/wrapped-pi-inbox ".length), "base64").toString("utf8"));
				facts({ kind: "inbox", from: packet.from, text: packet.text });
				task = packet.text;
				from = packet.from;
			}
			answer(command, { disposition: busy ? "queued" : "started" });
			run(task, from);
		} else if (command.type === "abort") {
			clearTimeout(timer); busy = false; queue = [];
			emit({ type: "agent_settled", aborted: true }); answer(command);
		} else if (command.type === "extension_ui_response") {
			facts({ kind: "ui-response", id: command.id ?? null, cancelled: command.cancelled ?? null });
			const waiter = uiWaiter;
			uiWaiter = undefined;
			if (waiter) waiter();
		} else answer(command);
	}
});
async function shutdown() {
	if (ending) return;
	ending = true;
	clearTimeout(timer);
	if (child?.pid) {
		try { process.kill(-child.pid, "SIGTERM"); } catch {}
		if (slowCleanup) await new Promise((resolve) => setTimeout(resolve, slowCleanup));
		try { process.kill(-child.pid, "SIGKILL"); } catch {}
		await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 500); });
	}
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
