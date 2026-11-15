// Plain worker state survives extension reload. No Pi handles or terminal UI.
export const TRANSCRIPT_BYTES = 128 * 1024;
export const REPORT_BYTES = 64 * 1024;
export const MESSAGE_BYTES = 16 * 1024;
export const WORKER_MESSAGE_ENTRY = "wrapped-pi-worker-message";
export const WORKER_INBOX_COMMAND = "wrapped-pi-inbox";

export interface WorkerNotice {
	kind: "reply" | "message" | "error";
	text: string;
	turn: number;
	source: "parent" | "human";
}

export interface WorkerState {
	phase: "starting" | "working" | "idle" | "failed";
	activity: string;
	turn: number;
	transcript: string;
	partial: string;
	lastText: string;
	messagedThisTurn: boolean;
	lastSender?: "parent" | "human";
	error?: string;
	fatal?: boolean;
	activeTools: Map<string, string>;
	notices: WorkerNotice[];
}

export function boundedText(text: string, bytes: number): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= bytes) return text;
	// Keep the beginning of answers; never split a UTF-8 sequence.
	let end = bytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return `${buffer.subarray(0, end).toString("utf8")}\n[truncated; full transcript in event log]`;
}

export function newWorkerState(): WorkerState {
	return { phase: "starting", activity: "starting Pi", turn: 0, transcript: "", partial: "", lastText: "", messagedThisTurn: false, activeTools: new Map(), notices: [] };
}

function append(state: WorkerState, text: string): void {
	const buffer = Buffer.from(state.transcript + text + "\n");
	let start = Math.max(0, buffer.length - TRANSCRIPT_BYTES);
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	state.transcript = buffer.subarray(start).toString("utf8");
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

function notice(state: WorkerState, kind: WorkerNotice["kind"], text: string): void {
	// Backpressure is enforced by the caller before accepting another prompt.
	// A burst from one worker is bounded too; do not silently grow parent RAM.
	if (state.notices.length >= 128) {
		state.error = "Worker message backlog exceeded its limit. Further messages remain only in the event log.";
		state.fatal = true;
		state.phase = "failed";
		state.activity = state.error;
		state.notices = [{ kind: "error", text: state.error, turn: state.turn, source: state.lastSender ?? "parent" }];
		return;
	}
	state.notices.push({ kind, text: boundedText(text, REPORT_BYTES), turn: state.turn, source: state.lastSender ?? "parent" });
}

export function applyWorkerRecord(state: WorkerState, record: any): void {
	if (state.fatal) return;
	switch (record?.type) {
		case "agent_start":
			state.phase = "working";
			state.activity = "thinking";
			state.turn++;
			state.lastText = "";
			state.messagedThisTurn = false;
			state.error = undefined;
			break;
		case "message_update": {
			const update = record.assistantMessageEvent;
			if (update?.type === "text_delta" && typeof update.delta === "string") {
				state.partial = boundedText(state.partial + update.delta, TRANSCRIPT_BYTES);
				state.activity = "responding";
			}
			break;
		}
		case "message_end": {
			const message = record.message;
			const text = contentText(message?.content);
			if (message?.role === "user") state.lastSender = "parent";
			if (message?.role === "custom" && message.customType === "worker-inbox" && ["parent", "human"].includes(message.details?.from)) {
				state.lastSender = message.details.from;
			}
			if (message?.role === "assistant") {
				state.partial = "";
				state.lastText = boundedText(text, REPORT_BYTES);
				if (text) append(state, `Assistant:\n${boundedText(text, TRANSCRIPT_BYTES)}`);
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					state.error = typeof message.errorMessage === "string" ? message.errorMessage : `Worker response ${message.stopReason}`;
				}
			} else if (text && (message?.role === "user" || message?.role === "custom")) {
				append(state, `${message.role === "custom" ? "Message" : "Task"}:\n${boundedText(text, TRANSCRIPT_BYTES)}`);
			}
			break;
		}
		case "tool_execution_start":
			state.activeTools.set(record.toolCallId, record.toolName);
			state.activity = [...state.activeTools.values()].join(", ");
			append(state, `Tool ${record.toolName}: ${boundedText(JSON.stringify(record.args ?? {}), 4096)}`);
			break;
		case "tool_execution_end":
			state.activeTools.delete(record.toolCallId);
			state.activity = state.activeTools.size ? [...state.activeTools.values()].join(", ") : "thinking";
			append(state, `${record.toolName}${record.isError ? " failed" : " result"}:\n${boundedText(contentText(record.result?.content), 4096)}`);
			break;
		case "entry_appended":
			if (record.entry?.customType === WORKER_MESSAGE_ENTRY && typeof record.entry.data?.text === "string") {
				const text = boundedText(record.entry.data.text, MESSAGE_BYTES);
				append(state, `Message to parent:\n${text}`);
				state.messagedThisTurn = true;
				notice(state, "message", text);
			}
			break;
		case "agent_settled":
			state.activeTools.clear();
			state.partial = "";
			state.phase = state.error || record.aborted ? "failed" : "idle";
			state.activity = state.phase === "idle" ? "ready for another message" : "turn ended with an error";
			// A question/progress message followed by wait already reported this
			// run. Do not wake the parent again just to say the child is idle.
			if (state.phase !== "idle" || state.lastText || !state.messagedThisTurn) {
				notice(state, state.phase === "idle" ? "reply" : "error", state.error ?? (record.aborted ? "Worker turn aborted." : state.lastText || "Worker yielded and is available for another message."));
			}
			break;
		case "compaction_start":
			state.activity = "compacting";
			break;
		case "auto_retry_start":
			state.activity = "retrying provider request";
			break;
		case "worker_protocol_error":
			state.phase = "failed";
			state.error = String(record.error);
			state.activity = "RPC protocol failure";
			notice(state, "error", state.error);
			state.fatal = true;
			break;
	}
}

export function validateWorkerMessage(text: unknown): string {
	if (typeof text !== "string" || !text.trim()) throw new Error("Give a non-empty message.");
	if (Buffer.byteLength(text) > MESSAGE_BYTES) throw new Error(`Message exceeds ${MESSAGE_BYTES} bytes; put long details in a file and send its path.`);
	return text;
}
