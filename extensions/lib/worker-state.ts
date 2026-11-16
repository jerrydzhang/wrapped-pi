// Plain worker state survives extension reload. No Pi handles or terminal UI.
export const TRANSCRIPT_BYTES = 128 * 1024;
export const REPORT_BYTES = 64 * 1024;
export const MESSAGE_BYTES = 16 * 1024;
export const WORKER_MESSAGE_ENTRY = "wrapped-pi-worker-message";
export const WORKER_INBOX_COMMAND = "wrapped-pi-inbox";

export type WorkerSettlement = "waiting-jobs" | "waiting-input" | "reply" | "unexplained" | "interrupted" | "error";

export interface WorkerNotice {
	kind: "reply" | "message" | "error" | "status";
	text: string;
	turn: number;
	source: "parent" | "human";
	reason?: WorkerSettlement;
	trigger?: "background";
}

export interface WorkerState {
	phase: "starting" | "working" | "idle" | "failed";
	activity: string;
	turn: number;
	transcript: string;
	partial: string;
	lastText: string;
	messagedThisTurn: boolean;
	/** Run-idle is not task completion. These fields describe why it settled. */
	settlement?: WorkerSettlement;
	pendingJobs?: string[];
	waited?: boolean;
	lastMessageHasTools?: boolean;
	interrupted?: boolean;
	trigger?: "background";
	inputSeenThisRun?: boolean;
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

/** Compact, addressable state for the inspector; activity carries the detail. */
export function workerLabel(state: WorkerState): string {
	if (state.phase === "working" || state.phase === "starting") return state.phase;
	switch (state.settlement) {
		case "waiting-jobs": return "waiting";
		case "waiting-input": return "input";
		case "interrupted": return "interrupted";
		case "unexplained": return "unexplained";
		default: return state.phase;
	}
}

export function workerStatus(state: WorkerState): string {
	return state.settlement === "waiting-jobs" || state.settlement === "waiting-input" || state.settlement === "unexplained" || state.settlement === "interrupted"
		? state.activity : workerLabel(state);
}

function notice(state: WorkerState, kind: WorkerNotice["kind"], text: string, reason?: WorkerSettlement): void {
	// Backpressure is enforced by the caller before accepting another prompt.
	// A burst from one worker is bounded too; do not silently grow parent RAM.
	if (state.notices.length >= 128) {
		state.error = "Worker message backlog exceeded its limit. Further messages remain only in the event log.";
		state.fatal = true;
		state.phase = "failed";
		state.settlement = "error";
		state.activity = state.error;
		state.notices = [{ kind: "error", text: state.error, turn: state.turn, source: state.lastSender ?? "parent", reason: "error" }];
		return;
	}
	state.notices.push({ kind, text: boundedText(text, REPORT_BYTES), turn: state.turn, source: state.lastSender ?? "parent",
		...(reason ? { reason } : {}), ...(state.trigger ? { trigger: state.trigger } : {}) });
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
			state.settlement = undefined;
			state.pendingJobs ??= [];
			state.waited = false;
			state.lastMessageHasTools = false;
			state.interrupted = false;
			state.trigger = undefined;
			state.inputSeenThisRun = false;
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
			if (message?.role === "user") {
				state.lastSender = "parent";
				state.inputSeenThisRun = true;
			}
			if (message?.role === "custom" && message.customType === "worker-inbox" && ["parent", "human"].includes(message.details?.from)) {
				state.lastSender = message.details.from;
				state.inputSeenThisRun = true;
			}
			if (message?.role === "custom" && message.customType === "bash-background-result") {
				// A result steered into an already-active run did not wake it.
				if (!state.inputSeenThisRun) state.trigger = "background";
				state.inputSeenThisRun = true;
				state.pendingJobs = (state.pendingJobs ?? []).filter((id) => id !== message.details?.id);
			}
			if (message?.role === "assistant") {
				state.inputSeenThisRun = true;
				state.partial = "";
				state.lastText = boundedText(text, REPORT_BYTES);
				state.lastMessageHasTools = Array.isArray(message.content) && message.content.some((block: any) => block?.type === "toolCall");
				// Only a wait from the final assistant/tool batch explains settlement.
				state.waited = false;
				state.interrupted = message.stopReason === "aborted";
				state.error = undefined;
				if (text) append(state, `Assistant:\n${boundedText(text, TRANSCRIPT_BYTES)}`);
				if (message.stopReason === "error" || state.interrupted) {
					state.error = typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage : `Worker response ${message.stopReason}`;
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
			if (record.toolName === "bash" && !record.isError) {
				const id = record.result?.details?.backgroundJob?.id;
				if (typeof id === "string" && /^bg-\d{1,16}$/.test(id)) {
					state.pendingJobs = [...new Set([...(state.pendingJobs ?? []), id])].slice(0, 128);
				}
			}
			if (record.toolName === "stop" && !record.isError && ["exited", "stopped", "unknown"].includes(record.result?.details?.state)) {
				state.pendingJobs = (state.pendingJobs ?? []).filter((id) => id !== record.result.details.id);
			}
			if (record.toolName === "wait" && !record.parentToolCallId && !record.isError && record.result?.terminate === true) {
				state.waited = true;
				// Trust structured ids, never parse human-facing tool output. Bound
				// status memory too; the complete result remains in the event log.
				state.pendingJobs = Array.isArray(record.result.details?.running)
					? [...new Set<string>(record.result.details.running.filter((id: unknown) => typeof id === "string" && /^(bg|sa)-\d{1,16}$/.test(id)))].slice(0, 128) : [];
			}
			break;
		case "entry_appended":
			if (record.entry?.customType === WORKER_MESSAGE_ENTRY && typeof record.entry.data?.text === "string") {
				const text = boundedText(record.entry.data.text, MESSAGE_BYTES);
				append(state, `Message to parent:\n${text}`);
				state.messagedThisTurn = true;
				notice(state, "message", text);
			}
			break;
		case "agent_settled": {
			state.activeTools.clear();
			state.partial = "";
			state.phase = state.error || record.aborted ? "failed" : "idle";
			if (record.aborted || state.interrupted) {
				state.settlement = "interrupted";
				state.activity = "interrupted; no automatic continuation";
				notice(state, "error", `Worker interrupted. No automatic continuation.${state.error ? ` ${state.error}` : ""}`, "interrupted");
			} else if (state.error) {
				state.settlement = "error";
				state.activity = "turn failed; no automatic continuation";
				notice(state, "error", state.error, "error");
			} else if (!state.waited && !state.lastMessageHasTools && state.lastText.trim()) {
				state.settlement = "reply";
				state.activity = "reply ready; available for follow-up";
				notice(state, "reply", state.lastText, "reply");
			} else if (state.pendingJobs?.length) {
				state.settlement = "waiting-jobs";
				state.activity = `waiting on background work: ${state.pendingJobs.join(", ")}; resumes automatically`;
				// Quiet status, not parent mail. The child's own job completion
				// delivery resumes it; no extra driver, timer or continue nudge.
			} else if (state.messagedThisTurn) {
				state.settlement = "waiting-input";
				state.activity = "waiting for input after message; no background work pending";
			} else {
				state.settlement = "unexplained";
				state.activity = "ended without a reply; no automatic continuation";
				notice(state, "status", "Worker ended its turn without a reply. No background work is pending; it will not resume automatically.", "unexplained");
			}
			break;
		}
		case "compaction_start":
			state.activity = "compacting";
			break;
		case "auto_retry_start":
			state.activity = "retrying provider request";
			break;
		case "worker_protocol_error":
			state.phase = "failed";
			state.settlement = "error";
			state.error = String(record.error);
			state.activity = "RPC protocol failure";
			notice(state, "error", state.error, "error");
			state.fatal = true;
			break;
	}
}

export function validateWorkerMessage(text: unknown): string {
	if (typeof text !== "string" || !text.trim()) throw new Error("Give a non-empty message.");
	if (Buffer.byteLength(text) > MESSAGE_BYTES) throw new Error(`Message exceeds ${MESSAGE_BYTES} bytes; put long details in a file and send its path.`);
	return text;
}
