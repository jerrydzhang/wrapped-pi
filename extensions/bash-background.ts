import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRpc } from "./lib/worker-rpc.ts";
import {
	applyWorkerRecord, newWorkerState, validateWorkerMessage, workerLabel, workerStatus,
	WORKER_INBOX_COMMAND, WORKER_MESSAGE_ENTRY, type WorkerState,
} from "./lib/worker-state.ts";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	createBashToolDefinition,
	getAgentDir,
	getShellConfig,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const MARKER = "__BASH_BG_EXIT__";
const POLL_MS = 500;
const STOP_GRACE_MS = 2000;
const STOP_POLL_STEP_MS = 100;
const AFTER_KILL_MS = 1000;
// A subagent's SIGTERM shutdown is not instant: the child's RPC mode runs
// its extension shutdown - which escalates against the child's own detached
// jobs through the same TERM-then-KILL ladder (grace + kill windows) - before
// it exits. The parent must outwait that whole cleanup, or its SIGKILL lands
// mid-cleanup and orphans whatever detached group the child is still
// escalating against (reproduced live: parent KILL at 2s, child escalation
// pending at ~2.4s). Bounded extra patience, not a supervisor.
const SA_STOP_GRACE_MS = STOP_GRACE_MS + AFTER_KILL_MS + 2000;
const TAIL_BYTES = 4096;
const TAIL_LINES = 20;
// A subagent's result is a final assistant response, not command output: it
// gets its own byte budget with no line cap, so a useful long answer survives
// while context stays bounded. The full result stays on disk either way.
const RESULT_TAIL_BYTES = 65536;
const MAX_TIMEOUT_MS = 2_147_483_647;
const SESSION_ENV_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"] as const;
// Shared by both job kinds: the wrapper shell around a job's process appends
// the nonce-tagged exit line, so a reloaded instance (which holds no
// ChildProcess) recovers the exit code - and for subagents the result text -
// from the file.
const WRAPPER = [
	"cmd=$1; nonce=$2; shift 2",
	'"$@" "$cmd"; code=$?',
	`printf "\\n${MARKER}:%s:%s\\n" "$nonce" "$code"`,
].join("\n");

// User configuration for subagents: one user-authored JSON file in Pi's agent
// directory (PI_CODING_AGENT_DIR respected, default ~/.pi/agent), read afresh
// at every launch - the wrapper convention: nothing is installed into or
// written under ~/.pi. The model pattern is anything pi --model accepts;
// there is never a fallback to the session model.
const CONFIG_FILE = "wrapped-pi.json";
// Set in every subagent child: the extension registers no subagent tool
// there. Ordinary recursion prevention, not a security boundary - the child
// can still launch pi through bash.
const CHILD_ENV = "WRAPPED_PI_CHILD";
// Exported by the wrapper with the same store-pinned extension paths it
// passes as -e, so the bundled set (extraExtensions included) reaches
// children too. Absent (plain pi, dev tree) - children load ordinary
// discovery only.
const EXTENSIONS_ENV = "WRAPPED_PI_EXTENSIONS";

type JobState = "running" | "stopping" | "exited" | "unknown" | "stopped";

type JobKind = "bash" | "subagent";

interface JobCommon {
	id: string;
	kind: JobKind;
	pid: number;
	nonce: string;
	startedAt: number;
	state: JobState;
	stopReason?: "stopped" | "timeout";
	/** Set when a stop escalation ended unresolved; the job may live on. */
	stopFailed?: "survived" | "denied";
	exitCode?: number;
	endedAt?: number;
	notified: boolean;
	stopping: boolean;
	groupGone: boolean;
}

// Bash jobs are plain marker-recoverable data. RPC workers additionally hold
// their one live transport; neither job kind retains a parent session context.
interface BashJob extends JobCommon {
	kind: "bash";
	command: string;
	/** Combined command output plus the exit marker. */
	logPath: string;
	deadlineAt?: number;
}

interface SubagentJob extends JobCommon {
	kind: "subagent";
	task: string;
	model: string;
	/** RPC event transcript (or a legacy print child's response/exit marker). */
	logPath: string;
	/** The child's stderr - diagnostics, surfaced on failure. */
	errPath: string;
	/** Single RPC owner, held across parent reload; absent on legacy print jobs. */
	rpc?: WorkerRpc;
	worker?: WorkerState;
}

type BgJob = BashJob | SubagentJob;

interface Registry {
	jobs: Map<string, BgJob>;
	nextId: number;
	poller?: ReturnType<typeof setInterval>;
}

// On globalThis because pi reloads extensions with moduleCache: false - module
// state dies on /reload, this survives it within the same process.
const REGISTRY_KEY = Symbol.for("bash-background.jobs");

function registry(): Registry {
	const holder = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
	return (holder[REGISTRY_KEY] ??= { jobs: new Map<string, BgJob>(), nextId: 1 });
}

let pi: ExtensionAPI | undefined;
// Module-local, rebound at session boundaries; never retained in worker state.
let deliveryContext: ExtensionContext | undefined;

// The ui surface this extension touches, captured at session boundaries.
// Undefined in headless modes and in tests.
interface UiLike {
	setStatus: (key: string, text: string | undefined) => void;
	theme: { fg: (color: string, text: string) => string };
}
let ui: UiLike | undefined;
const STATUS_KEY = "bash-bg";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// EPERM on a probe means the target exists but cannot be signalled;
// existence, never absence; only ESRCH settles liveness.
function probeAlive(pid: number, group: boolean): boolean {
	try {
		process.kill(group ? -pid : pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function signalGroup(pid: number, sig: NodeJS.Signals): "sent" | "absent" | "denied" {
	try {
		process.kill(-pid, sig);
		return "sent";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "absent";
		if (code === "EPERM") return "denied";
		throw error;
	}
}

// Pinned bash convention: the same timeout refusals the built-in raises.
function validateTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	if (timeout * 1000 > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	}
}

function shellEnv(ctx: ExtensionContext | undefined): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of SESSION_ENV_KEYS) delete env[key];
	if (ctx) {
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const file = ctx.sessionManager.getSessionFile();
		if (file) env.PI_SESSION_FILE = file;
		if (ctx.model) {
			env.PI_PROVIDER = ctx.model.provider;
			env.PI_MODEL = ctx.model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	return env;
}

async function spawnJob(command: string, timeout: number | undefined, ctx: ExtensionContext | undefined): Promise<BgJob> {
	const cwd = ctx?.cwd ?? process.cwd();
	const logPath = join(tmpdir(), `bash-bg-${randomBytes(6).toString("hex")}.log`);
	const nonce = randomBytes(8).toString("hex");
	try {
		accessSync(cwd);
	} catch {
		throw new Error(`Working directory does not exist: ${cwd}\nCannot execute background commands.`);
	}
	const fd = openSync(logPath, "wx", 0o600);
	try {
		const { shell, args } = getShellConfig();
		const child = spawn("sh", ["-c", WRAPPER, "bash-bg", command, nonce, shell, ...args], {
			cwd,
			env: shellEnv(ctx),
			detached: true,
			stdio: ["ignore", fd, fd],
		});
		// The armed reply must not lie: spawn failures surface here as errors.
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		// A dropped handle still needs this listener, or a later error crashes
		// the host process.
		child.on("error", () => {});
		child.unref();
		const reg = registry();
		const job: BgJob = {
			kind: "bash",
			id: `bg-${reg.nextId++}`,
			command,
			logPath,
			pid: child.pid!,
			nonce,
			startedAt: Date.now(),
			deadlineAt: timeout !== undefined ? Date.now() + timeout * 1000 : undefined,
			state: "running",
			notified: false,
			stopping: false,
			groupGone: false,
		};
		reg.jobs.set(job.id, job);
		ensurePoller();
		return job;
	} finally {
		closeSync(fd);
	}
}

// The child Pi must not see the parent session's PI_* state (pi's own
// nested-pi hygiene - the child sets its own). The child marker disables the
// subagent tool there: ordinary recursion prevention, nothing more.
function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of SESSION_ENV_KEYS) delete env[key];
	env[CHILD_ENV] = "1";
	return env;
}

// The wrapper exports the store-pinned -e list so the bundled set
// (extraExtensions included) reaches children. Newline-separated; blank
// lines are ignored.
function childExtensions(): string[] {
	const raw = process.env[EXTENSIONS_ENV];
	if (!raw) return [];
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function configPath(): string {
	return join(getAgentDir(), CONFIG_FILE);
}

// Reads the user's wrapped-pi.json afresh on every call (no caching - edits
// apply to the next launch without restarting Pi) and refuses loudly on any
// problem: every message names the file and an actionable cause. There is no
// fallback and no precedence: a missing or invalid file is an error, never a
// silent default.
function configuredModel(): string {
	const path = configPath();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(
				`No subagent model configured. Create ${path} containing {"model": "provider/model-id"} - the model is any pattern pi --model accepts. There is no fallback to the session model.`,
			);
		}
		throw new Error(
			`Cannot read the subagent configuration ${path} (${code}). Make the file readable, then launch the subagent again.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`Cannot parse the subagent configuration ${path}: not valid JSON (${(error as Error).message}). Fix the file, then launch the subagent again.`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`Invalid subagent configuration in ${path}: expected a JSON object like {"model": "provider/model-id"}.`,
		);
	}
	const model = (parsed as { model?: unknown }).model;
	if (typeof model !== "string") {
		throw new Error(
			`Invalid subagent configuration in ${path}: "model" must be a non-empty string like "provider/model-id" (missing or not a string).`,
		);
	}
	const trimmed = model.trim();
	if (trimmed === "") {
		throw new Error(
			`Invalid subagent configuration in ${path}: "model" must be a non-empty string like "provider/model-id" (it is blank).`,
		);
	}
	return trimmed;
}

async function spawnSubagent(task: string, model: string, ctx: ExtensionContext | undefined): Promise<SubagentJob> {
	const entry = process.argv[1];
	if (typeof entry !== "string" || entry === "") {
		throw new Error("Cannot locate the Pi CLI entry (process.argv[1] is empty); launching a subagent needs the running Pi command line.");
	}
	const cwd = ctx?.cwd ?? process.cwd();
	try { accessSync(cwd); } catch {
		throw new Error(`Working directory does not exist: ${cwd}\nCannot launch a subagent.`);
	}
	const stem = randomBytes(6).toString("hex");
	const args = [entry, "--mode", "rpc", "--no-session", "--model", model];
	// Always load this extension for the child's inbox and parent message tool,
	// even in plain-pi development. Wrapper extras remain store-pinned.
	for (const extension of new Set([...childExtensions(), fileURLToPath(import.meta.url)])) args.push("-e", extension);
	const rpc = await WorkerRpc.start({
		executable: process.execPath, args, cwd, env: childEnv(),
		logPath: join(tmpdir(), `sa-${stem}.jsonl`), errPath: join(tmpdir(), `sa-${stem}.err`),
	});
	const reg = registry();
	const job: SubagentJob = {
		kind: "subagent", id: `sa-${reg.nextId++}`, task, model,
		logPath: join(tmpdir(), `sa-${stem}.jsonl`), errPath: join(tmpdir(), `sa-${stem}.err`),
		pid: rpc.pid, nonce: randomBytes(8).toString("hex"), startedAt: Date.now(),
		state: "running", notified: false, stopping: false, groupGone: false,
		rpc, worker: newWorkerState(),
	};
	reg.jobs.set(job.id, job);
	bindWorker(job);
	ensurePoller();
	try {
		// Pi refuses non-interactive startup without a valid model. Checking
		// commands proves readiness without exporting a full model object (which
		// can include user-authored provider headers) into the transcript log.
		const commands = await rpc.request({ type: "get_commands" });
		if (!commands?.commands?.some((command: { name: string }) => command.name === WORKER_INBOX_COMMAND)) {
			throw new Error("Child Pi did not register its worker inbox.");
		}
		await rpc.request({ type: "prompt", message: task, streamingBehavior: "steer" });
		return job;
	} catch (error) {
		await stopJob(job, "stopped");
		if (job.groupGone || rpc.exited) reg.jobs.delete(job.id);
		throw new Error(`Cannot start ${job.id}: ${(error as Error).message}. Diagnostics: ${job.errPath}${isLive(job) ? `; stop ${job.id} to retry cleanup` : ""}`);
	}
}

// These callbacks update plain state only. They keep draining through a reload
// gap; rebinding replaces callbacks, never adds another stdio reader/driver.
function bindWorker(job: SubagentJob): void {
	const rpc = job.rpc;
	const worker = job.worker;
	if (!rpc || !worker) return;
	rpc.onRecord = (record) => {
		applyWorkerRecord(worker, record);
		if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(record.method)) {
			// Never auto-approve a headless child's permission/auth question.
			// Decline it and surface the request; workers should message parent.
			applyWorkerRecord(worker, { type: "entry_appended", entry: {
				customType: WORKER_MESSAGE_ENTRY, data: { text: `Child UI request declined (${record.method}): ${record.title ?? record.message ?? "question"}. Use message to ask the parent instead.` },
			} });
			void rpc.writeRecord({ type: "extension_ui_response", id: record.id, cancelled: true }).catch(() => {});
		}
		ensurePoller();
	};
	rpc.onExit = () => { ensurePoller(); };
}

async function messageWorker(id: string, text: string, from: "parent" | "human"): Promise<void> {
	validateWorkerMessage(text);
	const job = registry().jobs.get(id);
	if (!job || job.kind !== "subagent" || !job.rpc || !isLive(job) || job.stopping || job.rpc.exited) {
		throw new Error(`No addressable worker ${id} in this session.`);
	}
	if (job.worker?.fatal) throw new Error(`${id} has a fatal transport error; stop it and start another worker.`);
	const packet = Buffer.from(JSON.stringify({ from, text })).toString("base64");
	await job.rpc.request({ type: "prompt", message: `/${WORKER_INBOX_COMMAND} ${packet}`, streamingBehavior: "steer" });
}

// Bounded reads only: a log can grow without limit.
function readPathTail(path: string, bytes: number): { text: string; size: number } {
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			const start = Math.max(0, size - bytes);
			const buffer = Buffer.alloc(size - start);
			readSync(fd, buffer, 0, buffer.length, start);
			return { text: buffer.toString("utf8"), size };
		} finally {
			closeSync(fd);
		}
	} catch {
		return { text: "", size: 0 };
	}
}

function readTail(job: BgJob, bytes: number): { text: string; size: number } {
	return readPathTail(job.logPath, bytes);
}

// Only a completed, nonce-tagged marker line counts; anything else a command
// prints is user output, never exit evidence.
function readMarker(job: BgJob): number | undefined {
	const { text } = readTail(job, TAIL_BYTES * 2);
	const pattern = new RegExp(`(?:^|\\n)${MARKER}:([0-9a-f]{16}):(\\d+)\\n`, "g");
	let match: RegExpExecArray | null;
	let found: number | undefined;
	while ((match = pattern.exec(text)) !== null) {
		if (match[1] === job.nonce) found = Number(match[2]);
	}
	return found;
}

function outputTail(job: BgJob): { text: string; cut: "none" | "lines" | "bytes" } {
	const { text: raw, size } = readTail(job, TAIL_BYTES);
	const bytesCut = size > TAIL_BYTES;
	// The window can start mid-character; drop continuation bytes so the text
	// stays valid UTF-8.
	let start = 0;
	while (start < Math.min(3, raw.length) && (raw.charCodeAt(start) & 0xc0) === 0x80) start++;
	// Strip this job's control marker (complete or torn by a kill) together
	// with its separating newline; nothing else the command printed is touched.
	let text = raw
		.slice(start)
		.replace(new RegExp(`\\n?${MARKER}:${job.nonce}(:\\d+)?(\\n|$)`), "");
	if (bytesCut) {
		// The window opens mid-line; drop that partial line unless the whole
		// window is one unterminated line, where the cut notice covers it.
		const newline = text.indexOf("\n");
		if (newline !== -1) text = text.slice(newline + 1);
	}
	const lines = text.split("\n");
	const joined = lines.join("\n").replace(/\n+$/, "");
	if (joined === "") return { text: "", cut: bytesCut ? "bytes" : "none" };
	if (bytesCut) return { text: joined, cut: "bytes" };
	const cut = lines.length > TAIL_LINES || Buffer.byteLength(joined) > TAIL_BYTES;
	return {
		text: cut ? lines.slice(-TAIL_LINES).join("\n") : joined,
		cut: cut ? "lines" : "none",
	};
}

// The subagent result: the child's stdout is its final assistant response,
// so this is NOT command-output tail semantics - the byte budget is its own
// (RESULT_TAIL_BYTES), there is no line cap, and the only thing stripped is
// the control marker. A cut result still points at the full text on disk.
function resultTail(job: SubagentJob): { text: string; cut: boolean } {
	const { text: raw, size } = readPathTail(job.logPath, RESULT_TAIL_BYTES);
	const bytesCut = size > RESULT_TAIL_BYTES;
	let start = 0;
	while (start < Math.min(3, raw.length) && (raw.charCodeAt(start) & 0xc0) === 0x80) start++;
	const text = raw
		.slice(start)
		.replace(new RegExp(`\\n?${MARKER}:${job.nonce}(:\\d+)?(\\n|$)`), "")
		.replace(/\n+$/, "");
	if (bytesCut) {
		// The window opens mid-line; drop that partial line - the cut notice
		// covers it.
		const newline = text.indexOf("\n");
		if (newline !== -1) return { text: text.slice(newline + 1), cut: true };
	}
	return { text, cut: bytesCut };
}

// Diagnostics are failure detail: the command-output caps fit and keep the
// completion from flooding context.
function errTail(job: SubagentJob): { text: string; cut: "none" | "lines" | "bytes" } {
	const { text: raw, size } = readPathTail(job.errPath, TAIL_BYTES);
	const bytesCut = size > TAIL_BYTES;
	let start = 0;
	while (start < Math.min(3, raw.length) && (raw.charCodeAt(start) & 0xc0) === 0x80) start++;
	let text = raw.slice(start);
	if (bytesCut) {
		const newline = text.indexOf("\n");
		if (newline !== -1) text = text.slice(newline + 1);
	}
	const lines = text.split("\n");
	const joined = lines.join("\n").replace(/\n+$/, "");
	if (joined === "") return { text: "", cut: bytesCut ? "bytes" : "none" };
	if (bytesCut) return { text: joined, cut: "bytes" };
	const cut = lines.length > TAIL_LINES || Buffer.byteLength(joined) > TAIL_BYTES;
	return {
		text: cut ? lines.slice(-TAIL_LINES).join("\n") : joined,
		cut: cut ? "lines" : "none",
	};
}

function oneLine(command: string): string {
	const line = command.replace(/\s*\n\s*/g, " ");
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

// The card caps tighter than oneLine: a snapshot row stays one line on any
// reasonable pane instead of wrapping. The job's own text - command or task.
function cardText(job: BgJob): string {
	const line = oneLine(job.kind === "subagent" ? job.task : job.command);
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function fmtElapsedMs(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

// Round totals drop the seconds: 2m, not 2m00s.
function fmtTotalMs(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	return s % 60 === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}m${s % 60}s`;
}

// A timer, or elapsed/total when the job carries a deadline.
function timerField(elapsedMs: number, totalMs: number | undefined): string {
	return totalMs !== undefined ? `${fmtElapsedMs(elapsedMs)}/${fmtTotalMs(totalMs)}` : fmtElapsedMs(elapsedMs);
}

function jobTotalMs(job: BgJob): number | undefined {
	return job.kind === "bash" && job.deadlineAt !== undefined ? job.deadlineAt - job.startedAt : undefined;
}

// Live is the wait-relevant sense: a job the session can still see settle.
function isLive(job: BgJob): boolean {
	return job.state === "running" || job.state === "stopping";
}

function liveJobs(): BgJob[] {
	return [...registry().jobs.values()].filter(isLive).sort((a, b) => a.startedAt - b.startedAt);
}

// The footer is the live signal: running/stopping jobs only, refreshed on
// the poller's own tick, cleared the moment nothing is pending. A settled
// job waiting on delivery is no longer "taking time" and drops out.
function refreshStatus(): void {
	if (!ui) return;
	const live = liveJobs();
	if (live.length === 0) {
		ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const parts = live.map((j) => j.kind === "subagent" && j.worker
		? `${j.id} ${j.stopping ? "stopping" : workerStatus(j.worker)}${j.worker.phase === "working" ? ` ${fmtElapsedMs(Date.now() - j.startedAt)}` : ""}`
		: `${j.id} ${timerField(Date.now() - j.startedAt, jobTotalMs(j))}`);
	ui.setStatus(STATUS_KEY, ui.theme.fg("dim", parts.join(", ")));
}

function timeoutSeconds(job: BgJob): number {
	return Math.round(((job.deadlineAt ?? 0) - job.startedAt) / 100) / 10;
}

function outcome(job: BgJob): string {
	if (job.state === "exited") {
		const base =
			job.kind === "subagent"
				? job.exitCode === 0
					? "finished"
					: `failed: its Pi process exited with code ${job.exitCode}`
				: job.exitCode === 0
					? "exited with code 0"
					: `failed: exited with code ${job.exitCode}`;
		if (job.stopFailed === "denied" || job.stopFailed === "survived") {
			return job.stopReason === "timeout"
				? `${base} after its timeout of ${timeoutSeconds(job)}s elapsed (stop could not be completed)`
				: `${base} (an earlier stop attempt did not complete)`;
		}
		return base;
	}
	if (job.state === "stopped" && job.stopReason === "timeout") {
		return `was stopped: its timeout of ${timeoutSeconds(job)}s elapsed`;
	}
	if (job.state === "unknown") return "ended without reporting an exit status";
	return `was stopped (${job.stopReason ?? "by request"})`;
}

function completionText(job: BgJob): string {
	if (job.kind === "subagent") return subagentCompletionText(job);
	const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10;
	const { text, cut } = outputTail(job);
	const lines = [
		`Background command ${job.id} ${outcome(job)}, ran ${seconds}s.`,
		`Command: ${oneLine(job.command)}`,
	];
	// The durable pointer rides every branch: the completion is the terminal
	// carrier of the log path, present even when there is no output to tail.
	if (text === "" && cut === "bytes") lines.push(`No output in view; earlier output cut. Full output: ${job.logPath}`);
	else if (text === "") lines.push("(no output)", `Full output: ${job.logPath}`);
	else if (cut === "bytes") lines.push(`Output (tail; earlier output cut) - full output: ${job.logPath}`, text);
	else if (cut === "lines") lines.push(`Output, last ${TAIL_LINES} lines - full output: ${job.logPath}`, text);
	else lines.push("Output:", text, `Full output: ${job.logPath}`);
	return lines.join("\n");
}

function subagentCompletionText(job: SubagentJob): string {
	if (job.rpc) {
		const diagnostics = errTail(job);
		return [
			`Worker ${job.id} process ended (${job.exitCode !== undefined ? `exit code ${job.exitCode}` : job.rpc.signal ? `signal ${job.rpc.signal}` : "exit status unknown"}); its conversation is no longer addressable.`,
			job.worker?.error ?? "",
			diagnostics.text ? `Diagnostics${diagnostics.cut !== "none" ? " (tail)" : ""}:\n${diagnostics.text}` : "",
			`Full transcript: ${job.logPath}\nFull diagnostics: ${job.errPath}`,
		].filter(Boolean).join("\n");
	}
	const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10;
	const lines = [
		`Subagent ${job.id} ${outcome(job)}, ran ${seconds}s.`,
		`Task: ${oneLine(job.task)}`,
	];
	if (job.state === "exited" && job.exitCode === 0) {
		const { text, cut } = resultTail(job);
		// The durable pointer rides every branch, exactly as for a command.
		if (text === "" && cut) lines.push(`No response in view; earlier response cut. Full result: ${job.logPath}`);
		else if (text === "") lines.push("(no response text)", `Full result: ${job.logPath}`);
		else if (cut) lines.push(`Result (tail; earlier response cut) - full result: ${job.logPath}`, text);
		else lines.push("Result:", text, `Full result: ${job.logPath}`);
		return lines.join("\n");
	}
	const { text, cut } = errTail(job);
	if (text === "" && cut === "bytes") lines.push(`No diagnostics in view; earlier diagnostics cut. Full diagnostics: ${job.errPath}`);
	else if (text === "") lines.push("(no diagnostics)", `Full diagnostics: ${job.errPath}`);
	else if (cut === "bytes") lines.push(`Diagnostics (tail; earlier output cut) - full diagnostics: ${job.errPath}`, text);
	else if (cut === "lines") lines.push(`Diagnostics, last ${TAIL_LINES} lines - full diagnostics: ${job.errPath}`, text);
	else lines.push("Diagnostics:", text, `Full diagnostics: ${job.errPath}`);
	lines.push(`Any partial response: ${job.logPath}`);
	return lines.join("\n");
}

function deliver(job: BgJob): void {
	// Pi exposes a live signal during an agent run, but not manual compaction
	// or other busy pre/post-run boundaries. Keep mail queued until it can be
	// steered safely or wake a genuinely idle session, rather than start a run
	// over an in-progress manual compaction.
	try {
		if (deliveryContext?.isIdle && !deliveryContext.isIdle() && !deliveryContext.signal) return;
	} catch { return; } // A stale reload context must never claim delivery.
	if (pi && job.kind === "subagent" && job.worker && !job.stopping && (job.stopReason !== "stopped" || job.stopFailed)) {
		while (job.worker.notices.length > 0) {
			const notice = job.worker.notices[0];
			try {
				const label = notice.kind === "message" ? "Message from" : notice.kind === "reply" ? "Reply from" : "Status from";
				const source = notice.trigger === "background"
					? `resumed by background result; last input from ${notice.source ?? "parent"}`
					: `responding to ${notice.source ?? "parent"}`;
				pi.sendMessage({
					customType: notice.kind === "message" ? "subagent-message" : "subagent-reply",
					content: `${label} worker ${job.id} (turn ${notice.turn}; ${source}):\n${notice.text}\nFull transcript: ${job.logPath}`,
					display: true,
					details: { id: job.id, turn: notice.turn, kind: notice.kind, logPath: job.logPath,
						...(notice.reason ? { reason: notice.reason } : {}), ...(notice.trigger ? { trigger: notice.trigger } : {}) },
				}, { deliverAs: "steer", triggerTurn: true });
				job.worker.notices.shift();
			} catch { break; }
		}
	}
	if (!pi || job.notified || job.state === "running" || job.state === "stopping") return;
	job.notified = true;
	try {
		pi.sendMessage(
			{
				customType: "bash-background-result",
				content: completionText(job),
				display: true,
				details: {
					id: job.id,
					state: job.state,
					exitCode: job.exitCode ?? null,
					durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
					logPath: job.logPath,
					...(job.kind === "subagent" ? { errPath: job.errPath } : {}),
				},
			},
			// steer is the one completion carrier: mid-run the message enters at
			// the next turn boundary - after the current tool calls, before the
			// model's next request - and the agent loop cannot end a run while
			// steering messages are queued, so a completion armed mid-run is
			// always consumed inside that run, never a trailing wake.
			// triggerTurn wakes an idle session with the same message.
			{ deliverAs: "steer", triggerTurn: true },
		);
	} catch {
		// A stale handle must not consume the result: the rebound instance
		// retries on its next tick.
		job.notified = false;
	}
}

const killsInFlight = new Map<string, Promise<string>>();

function settleFromMarker(job: BgJob): string | undefined {
	if (job.kind === "subagent" && job.rpc) {
		if (!job.rpc.exited) return undefined;
		job.exitCode = job.rpc.exitCode ?? undefined;
		job.state = job.exitCode === undefined ? "unknown" : "exited";
		job.endedAt = Date.now();
		job.groupGone ||= !probeAlive(job.pid, true);
		return `worker process ended (${job.exitCode !== undefined ? `exit code ${job.exitCode}` : job.rpc.signal ? `signal ${job.rpc.signal}` : "exit status unknown"})`;
	}
	const marker = readMarker(job);
	if (marker === undefined) return undefined;
	job.state = "exited";
	job.exitCode = marker;
	job.endedAt = Date.now();
	// A late marker during a stop attempt is not "finished on its own" when the
	// deadline caused the attempt.
	if (job.stopReason === "timeout") {
		return `exited with code ${marker} after its timeout of ${timeoutSeconds(job)}s elapsed (stop was in progress)`;
	}
	return `finished on its own while being stopped: exited with code ${marker}`;
}

// Returns the observed outcome; the caller words it. Terminal only when
// settlement was actually observed - an unkillable group stays running.
async function stopJob(job: BgJob, reason: "stopped" | "timeout"): Promise<string> {
	const existing = killsInFlight.get(job.id);
	if (existing) return existing;
	const run = (async (): Promise<string> => {
		job.stopping = true;
		job.stopReason = reason;
		// Set before the kill so an explicitly stopped command can never
		// deliver afterwards; the stop result itself carries the outcome. A
		// deadline stop keeps delivering - with its cause preserved.
		if (reason === "stopped") {
			job.notified = true;
			if (job.kind === "subagent" && job.worker) job.worker.notices.length = 0;
		}
		if (job.kind === "subagent") job.rpc?.closeInput();
		const settled = settleFromMarker(job);
		if (settled !== undefined) return settled;
		if (job.groupGone) {
			// Evidence from an earlier settlement: this pid is never signalled again.
			job.state = "unknown";
			job.endedAt = Date.now();
			return "had already ended (exit status unknown)";
		}
		let stopped = false;
		let denied = false;
		const attempt = (sig: NodeJS.Signals): void => {
			const how = signalGroup(job.pid, sig);
			if (how === "absent") stopped = true;
			if (how === "denied") denied = true;
		};
		attempt("SIGTERM");
		const grace = job.kind === "subagent" ? SA_STOP_GRACE_MS : STOP_GRACE_MS;
		for (let waited = 0; !stopped && !denied && waited < grace; waited += STOP_POLL_STEP_MS) {
			await sleep(STOP_POLL_STEP_MS);
			stopped = !probeAlive(job.pid, true);
		}
		if (!stopped && !denied) {
			attempt("SIGKILL");
			for (let waited = 0; !stopped && !denied && waited < AFTER_KILL_MS; waited += STOP_POLL_STEP_MS) {
				await sleep(STOP_POLL_STEP_MS);
				stopped = !probeAlive(job.pid, true);
			}
		}
		const late = settleFromMarker(job);
		if (late !== undefined) return late;
		if (stopped) {
			job.state = "stopped";
			job.groupGone = true;
			job.endedAt = Date.now();
			return reason === "timeout"
				? "stopped at its deadline (command group gone)"
				: "stopped (command group gone)";
		}
		// Unresolved: the group is still alive or unprobeable, so the job stays
		// running and later ticks keep watching for a natural exit.
		job.stopping = false;
		job.stopFailed = denied ? "denied" : "survived";
		// A failed stop did not establish termination. Keep future worker
		// replies/errors and an eventual process exit observable.
		if (job.kind === "subagent") job.notified = false;
		return denied
			? "could not be stopped: the command group could not be signalled (permission denied) and may still be running"
			: "could not be stopped: the command group survived SIGKILL and may still be running";
	})();
	const shared = run.finally(() => {
		job.stopping = false;
		killsInFlight.delete(job.id);
	});
	killsInFlight.set(job.id, shared);
	return shared;
}

// Explicit worker stop means terminate and forget, not pause or archive.
// Keep unresolved stops visible: never hide a group that may still be alive.
async function stopExplicitly(job: BgJob): Promise<string> {
	const how = await stopJob(job, "stopped");
	if (job.kind === "subagent" && job.groupGone && registry().jobs.get(job.id) === job) {
		registry().jobs.delete(job.id);
		refreshStatus();
		return `${how}; worker removed from this session`;
	}
	return job.kind === "subagent" && !job.groupGone
		? `${how}; worker retained because its process group may still be running`
		: how;
}

// Awaited by shutdown hooks so pi can hold exit until escalation settles.
async function stopAllJobs(): Promise<void> {
	const active = [...registry().jobs.values()].filter((j) => j.state === "running" || j.state === "stopping");
	await Promise.allSettled(active.map((j) => stopJob(j, "stopped")));
}

function ensurePoller(): void {
	const reg = registry();
	if (reg.poller !== undefined) return;
	reg.poller = setInterval(pollTick, POLL_MS);
	reg.poller.unref();
}

function stopPoller(): void {
	const reg = registry();
	if (reg.poller !== undefined) clearInterval(reg.poller);
	reg.poller = undefined;
}

function pollTick(): void {
	const reg = registry();
	for (const job of reg.jobs.values()) {
		if (job.state !== "running" || job.stopping) continue;
		if (job.kind === "subagent" && job.rpc) {
			if (job.rpc.exited) settleFromMarker(job);
			else if (job.worker?.fatal) {
				deliver(job);
				void stopJob(job, "stopped");
			}
			continue;
		}
		if (job.kind === "bash" && job.deadlineAt !== undefined && !job.stopFailed && Date.now() >= job.deadlineAt) {
			void stopJob(job, "timeout");
			continue;
		}
		const marker = readMarker(job);
		if (marker !== undefined) {
			job.state = "exited";
			job.exitCode = marker;
			job.endedAt = Date.now();
		} else if (!probeAlive(job.pid, false)) {
			job.state = "unknown";
			job.endedAt = Date.now();
		}
	}
	for (const job of reg.jobs.values()) {
		deliver(job);
	}
	const pending = [...reg.jobs.values()].some(
		(job) => job.state === "running" || job.state === "stopping" || !job.notified,
	);
	if (!pending) stopPoller();
	refreshStatus();
}

// A reload re-runs the factory against the same registry: drop this module
// copy's stale timer and reconnect delivery to the live handle.
function attach(handle: ExtensionAPI): void {
	pi = handle;
	for (const job of registry().jobs.values()) if (job.kind === "subagent") bindWorker(job);
	stopPoller();
	ensurePoller();
}

const BACKGROUND_CONTRACT =
	"Set background:true to run a command detached and continue other work: the call returns at once with a job id and the log path, and when the command finishes its result is delivered to you automatically as its own message - it arrives between your tool calls while you keep working, or wakes an idle session; do not poll or sleep-wait. The log path is for progress while the job runs. timeout, if set, limits total runtime including time in the background. Stop a running background job with stop. When nothing useful remains to do, call wait alone to end your turn.";

const SUBAGENT_CONTRACT =
	"Launch an addressable worker: a fresh Pi conversation in this working directory, starting from the task and ordinary project instructions - never this conversation - with ordinary tools but no subagent tool of its own (no recursive agents). Returns a stable sa-N id. Replies, messages, interruptions, errors, and unexplained stops arrive automatically, between tool calls or waking you while idle. Waiting on the worker's background jobs is quiet; those jobs resume it automatically, so do not send continue nudges. A reply ends a run; it is not proof of task completion. The worker retains its conversation: use message with its id for follow-ups or answers, and stop to terminate it. Workers live only within this parent session, including /reload, never across parent exit or replacement. Call wait alone when nothing useful remains; never poll. The child model is user-configured, not chosen per call.";

export default function (handle: ExtensionAPI) {
	// Bound at factory time, not only at session_start: a completion may land
	// between the two, and delivery must never wait on lifecycle ordering.
	pi = handle;
	const builtin = createBashToolDefinition(process.cwd());
	handle.registerTool({
		...builtin,
		description: `${builtin.description} ${BACKGROUND_CONTRACT}`,
		parameters: Type.Object({
			...builtin.parameters.properties,
			background: Type.Optional(
				Type.Boolean({ description: "Run detached; when it finishes the result arrives automatically as its own message between your tool calls" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const input = params as { command: string; timeout?: number; background?: boolean };
			if (input.background !== true) {
				return builtin.execute(toolCallId, { command: input.command, timeout: input.timeout }, signal, onUpdate, ctx);
			}
			validateTimeout(input.timeout);
			// The call's abort signal is deliberately unused: it aborts the tool
			// call, and a background command must outlive the call that started it.
			const job = await spawnJob(input.command, input.timeout, ctx);
			return {
				content: [
					{
						type: "text",
						text: [
							`Background command ${job.id} started (pid ${job.pid}).`,
							`Command: ${oneLine(input.command)}`,
							`Output streams to ${job.logPath} - read it anytime for progress while the job runs.`,
							job.deadlineAt !== undefined ? `Deadline: ${input.timeout}s total runtime.` : "No deadline.",
							"When it finishes, the result is delivered here automatically - it arrives between your tool calls. Continue other work instead of polling; when nothing useful remains to do, call wait alone to end your turn.",
						].join("\n"),
					},
				],
				details: { truncation: undefined, backgroundJob: { id: job.id } },
			};
		},
	});
	handle.registerTool({
		name: "stop",
		label: "Stop background job",
		description:
			"Stop a background job (a bash command started with background:true, or a subagent) that this session started, by its job id (bg-N or sa-N). Terminates the job's whole process group and reports the observed outcome; the stop result is the outcome - no completion message follows for a job you stopped. A successfully stopped worker is removed from the session and /bg, not paused or retained.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id returned by a background bash call (bg-N) or a subagent call (sa-N)" }),
		}),
		async execute(_toolCallId, params) {
			const job = registry().jobs.get(params.id);
			if (!job) {
				return {
					content: [{ type: "text", text: `No background job ${params.id} in this session. Only jobs started here can be stopped.` }],
					details: { id: params.id, found: false },
				};
			}
			if (job.kind !== "subagent" && job.state !== "running" && job.state !== "stopping") {
				const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10;
				// Status only: pointers ride boundaries (start message, completion),
				// never pulls.
				return {
					content: [
						{
							type: "text",
							text: `${job.id} already finished: ${outcome(job)}, ran ${seconds}s.`,
						},
					],
					details: { id: job.id, state: job.state },
				};
			}
			const how = await stopExplicitly(job);
			return {
				content: [{ type: "text", text: `${job.id} ${how}.` }],
				details: { id: job.id, state: job.state, outcome: how },
			};
		},
	});
	// A conversational yield, not a blocking wait: the result carries
	// terminate, so the run ends right there unless completions were armed in
	// the same call - those enter as steering messages and the loop continues
	// into them. No timers, no waiter sets: delivery stays the poller's
	// steer/triggerTurn path, and wait only arms what is already settled and
	// undelivered (deliver() is idempotent, so consumed jobs never repeat).
	handle.registerTool({
		name: "wait",
		label: "Wait for input",
		description:
			"Yield when nothing useful remains to do. Call wait alone, with no arguments and no other tool calls in the same turn. Incoming human messages, worker messages, or job results resume you automatically; do not poll. Already-pending results are delivered first. Jobs keep running. With no background work, yield to the human.",
		// Declared to the model, never callable from codemode scripts: a script
		// must not be able to end a run.
		exposure: "model-only",
		promptGuidelines: [
			"Keep doing useful work while background jobs run; their results arrive automatically as their own messages. When nothing useful remains to do, call wait alone - just wait, no arguments, nothing else in the turn - to end your turn. Never poll or sleep-wait for a job's result.",
		],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			const legacy = Object.keys(params ?? {});
			if (legacy.length > 0) {
				throw new Error(
					`wait takes no arguments (received ${legacy.join(", ")}). Call it alone as wait {} when nothing useful remains to do: finished jobs' results are delivered automatically, and running jobs keep running.`,
				);
			}
			const delivered: string[] = [];
			for (const job of registry().jobs.values()) {
				const pending = !isLive(job) && !job.notified;
				const notices = job.kind === "subagent" ? job.worker?.notices.length ?? 0 : 0;
				deliver(job);
				if ((pending && job.notified) || (job.kind === "subagent" && notices > (job.worker?.notices.length ?? 0))) delivered.push(job.id);
			}
			const live = liveJobs();
			const running = live.filter((job) => job.kind !== "subagent" || !job.worker || ["starting", "working"].includes(job.worker.phase) || job.worker.settlement === "waiting-jobs");
			const parked = live.filter((job) => !running.includes(job));
			const parts: string[] = [];
			if (delivered.length > 0) parts.push(`Results delivered for: ${delivered.join(", ")}.`);
			if (running.length > 0) {
				parts.push(
					`Still running: ${running
						.map((j) => `${j.id} ${timerField(Date.now() - j.startedAt, jobTotalMs(j))}`)
						.join(", ")} - each result arrives automatically as its own message.`,
				);
			}
			if (parked.length > 0) parts.push(`Workers awaiting input or follow-up: ${parked.map((job) => `${job.id} (${job.kind === "subagent" && job.worker ? workerLabel(job.worker) : job.state})`).join(", ")}.`);
			return {
				content: [{ type: "text", text: ["Yielding. Incoming messages or results will resume this session.", ...parts].join(" ") }],
				details: { delivered, running: running.map((j) => j.id) },
				terminate: true,
			};
		},
	});
	const isChild = process.env[CHILD_ENV] === "1";
	handle.registerTool({
		name: "message",
		label: isChild ? "Message parent" : "Message a worker",
		description: isChild
			? "Send a question, progress report, or blocker to your parent before your task finishes. Use id: parent. The parent can answer in this same conversation. Do not poll for a reply; call wait alone if you have nothing else to do."
			: "Send a follow-up, answer, or instruction to an existing worker by its sa-N id. A busy worker reads it at a supported boundary; an idle worker starts another turn in the same conversation. Its replies arrive automatically. This submits a message, not proof the worker has read it.",
		parameters: Type.Object({
			id: Type.String({ description: isChild ? "parent" : "Worker id returned by subagent, e.g. sa-1" }),
			message: Type.String({ description: "Message text (up to 16 KiB); use a file path for longer details" }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			const text = validateWorkerMessage(params.message);
			if (isChild) {
				if (params.id !== "parent") throw new Error("Workers can message only id: parent; sibling messaging is not supported.");
				handle.appendEntry(WORKER_MESSAGE_ENTRY, { text });
			} else await messageWorker(params.id, text, "parent");
			return { content: [{ type: "text", text: `Message submitted to ${params.id}. Replies arrive automatically.` }], details: { id: params.id } };
		},
	});
	if (isChild) handle.registerCommand(WORKER_INBOX_COMMAND, {
		description: "Internal RPC worker inbox",
		handler: async (encoded, ctx) => {
			if (ctx.mode !== "rpc") throw new Error("The worker inbox is RPC-only.");
			const packet = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
			if (packet.from !== "parent" && packet.from !== "human") throw new Error("Invalid worker message sender.");
			const text = validateWorkerMessage(packet.text);
			if (ctx.isIdle && !ctx.isIdle() && !ctx.signal) {
				throw new Error("Worker is preparing or compacting; message was not submitted. Resubmit after that operation settles.");
			}
			handle.sendMessage({
				customType: "worker-inbox", content: `Message from ${packet.from}:\n${text}`, display: true,
				details: { from: packet.from },
			}, { deliverAs: "steer", triggerTurn: true });
		},
	});
	// Registered only outside subagent children: the child marker set by
	// spawnSubagent removes the tool there, which is ordinary recursion
	// prevention - not a security boundary (a child can still launch pi through
	// bash).
	if (process.env[CHILD_ENV] !== "1") {
		handle.registerTool({
			name: "subagent",
			label: "Launch a subagent",
			description: SUBAGENT_CONTRACT,
			parameters: Type.Object({
				task: Type.String({
					description: "The task for the child to carry out; it sees project instructions and ordinary tools, never this conversation",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const task = (params as { task: string }).task;
				if (task.trim() === "") {
					throw new Error("Give the subagent a task: a non-empty description of the work.");
				}
				const model = configuredModel();
				// The call's abort signal is deliberately unused: it aborts the tool
				// call, and a subagent must outlive the call that started it.
				const job = await spawnSubagent(task, model, ctx);
				return {
					content: [
						{
							type: "text",
							text: [
								`Subagent ${job.id} started (pid ${job.pid}).`,
								`Task: ${oneLine(task)}`,
								`Model: ${model}`,
								"Replies and messages arrive automatically. Background-job waits are quiet and resume automatically; do not nudge. Use message with this id for follow-ups or answers. A reply is not proof of task completion. Call wait alone when you have nothing useful to do.",
								`Open its live conversation with /bg ${job.id}. Full event transcript: ${job.logPath}; diagnostics: ${job.errPath}.`,
							].join("\n"),
						},
					],
					details: undefined,
				};
			},
		});
	}
	handle.registerCommand("bg", {
		description: "Open background jobs and worker conversations; /bg sa-N opens that worker directly (human-only, no model context)",
		handler: async (args, ctx) => {
			if (ctx?.mode === "tui") {
				const { openWorkerInspector } = await import("./lib/worker-inspector.ts");
				await openWorkerInspector(ctx, {
					initialId: args.trim() || undefined,
					rows: () => [...registry().jobs.values()].filter((job) => isLive(job) || job.kind === "subagent").map((job) => ({
						id: job.id, kind: job.kind,
						state: job.stopping ? "stopping" : !isLive(job) && job.stopReason === "stopped" ? "stopped" : job.kind === "subagent" && isLive(job) && job.worker ? workerLabel(job.worker) : job.state,
						task: job.kind === "subagent" ? job.task : job.command,
						model: job.kind === "subagent" ? job.model : undefined,
						activity: job.kind === "subagent" ? isLive(job) ? job.worker?.activity : "conversation closed" : undefined,
						startedAt: job.startedAt, endedAt: job.endedAt, logPath: job.logPath,
						transcript: job.kind === "subagent" && job.worker
							? job.worker.transcript + (job.worker.partial ? `\nAssistant (streaming):\n${job.worker.partial}` : "")
							: outputTail(job).text,
					})),
					send: (id, text) => messageWorker(id, text, "human"),
					stop: async (id) => {
						const job = registry().jobs.get(id);
						if (!job || (job.kind !== "subagent" && !isLive(job))) throw new Error(`${id} is no longer running.`);
						ctx.ui.notify(`${id} ${await stopExplicitly(job)}.`, "info");
					},
				});
				return;
			}
			// The non-TUI card is a record of the check: custom entries never enter LLM
			// context, and the snapshot stays honest in scrollback and on disk.
			pi?.appendEntry("bash-bg-status", {
				at: new Date().toISOString(),
				jobs: liveJobs().map((j) => ({
					id: j.id,
					elapsedMs: Date.now() - j.startedAt,
					timeoutMs: jobTotalMs(j),
					command: cardText(j),
					logPath: j.logPath,
				})),
			});
		},
	});
	handle.registerEntryRenderer("bash-bg-status", (entry, _opts, theme) => {
		const data = entry.data as {
			at: string;
			jobs: { id: string; elapsedMs: number; timeoutMs?: number; command: string }[];
		};
		const time = new Date(data.at).toLocaleTimeString();
		// One Text for the whole card: a Text per line renders paddingY's blank
		// line between jobs.
		const lines = [theme.fg("dim", `background jobs - checked ${time}`)];
		if (data.jobs.length === 0) lines.push(theme.fg("dim", "none running"));
		for (const j of data.jobs) {
			lines.push(
				theme.fg("accent", j.id) +
					theme.fg("dim", `  ${timerField(j.elapsedMs, j.timeoutMs).padStart(8)}`) +
					theme.fg("muted", `  ${j.command}`),
			);
		}
		const box = new Box(1, 0, (text) => text);
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});
	handle.on("session_start", async (event, ctx) => {
		// A replaced session (new/resume/fork) never adopts the old session's
		// jobs; a reload takes them over. Awaited cleanup here is
		// belt-and-braces for a shutdown that did not run.
		// Headless modes (and the stub suite) carry no ui; the footer needs one.
		deliveryContext = ctx;
		if (ctx?.ui && ctx.hasUI !== false) ui = ctx.ui as unknown as UiLike;
		if (event.reason !== "reload" && event.reason !== "startup") {
			await stopAllJobs();
			registry().jobs.clear();
			stopPoller();
		}
		attach(handle);
		refreshStatus();
	});
	handle.on("session_shutdown", async (event) => {
		if (event.reason === "reload") {
			// Jobs keep running; this instance's handle must never deliver again.
			// ui stays: this copy's pollTick keeps the footer honest until the
			// replacement instance attaches.
			deliveryContext = undefined;
			pi = undefined;
			return;
		}
		pi = undefined;
		deliveryContext = undefined;
		await stopAllJobs();
		registry().jobs.clear();
		stopPoller();
		ui?.setStatus(STATUS_KEY, undefined);
		ui = undefined;
		pi = undefined;
	});
}
