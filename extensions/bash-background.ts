import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	createBashToolDefinition,
	getShellConfig,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const MARKER = "__BASH_BG_EXIT__";
const POLL_MS = 500;
const STOP_GRACE_MS = 2000;
const STOP_POLL_STEP_MS = 100;
const AFTER_KILL_MS = 1000;
// A subagent's SIGTERM shutdown is not instant: the child's print mode runs
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

// The subagent child: the same Pi the session runs in, relaunched headless
// (print mode writes only the final assistant response to stdout). stdout is
// captured to the result file, stderr to the diagnostics file, and the exit
// marker lands in the result file - reload takeover reads all three back.
const SA_WRAPPER = [
	"out=$1; err=$2; nonce=$3; shift 3",
	'"$@" >"$out" 2>"$err"; code=$?',
	`printf "\\n${MARKER}:%s:%s\\n" "$nonce" "$code" >>"$out"`,
].join("\n");

// User configuration for subagents, read from the environment (the wrapper
// convention - nothing is installed into ~/.pi). The model pattern is
// anything pi --model accepts; there is never a fallback to the session
// model.
const MODEL_ENV = "WRAPPED_PI_SUBAGENT_MODEL";
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

// Plain data only: a reloaded instance takes jobs over from marker reads, so
// nothing process-bound or session-bound may live here.
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
	/** The result file: the child's stdout (its final response) plus the exit marker. */
	logPath: string;
	/** The child's stderr - diagnostics, surfaced on failure. */
	errPath: string;
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

function configuredModel(): string | undefined {
	const raw = process.env[MODEL_ENV]?.trim();
	return raw ? raw : undefined;
}

async function spawnSubagent(task: string, model: string, ctx: ExtensionContext | undefined): Promise<BgJob> {
	// Relaunch the same Pi this session runs in: argv[1] is the CLI entry the
	// host executed, execPath the interpreter running it.
	const entry = process.argv[1];
	if (typeof entry !== "string" || entry === "") {
		throw new Error("Cannot locate the Pi CLI entry (process.argv[1] is empty); launching a subagent needs the running Pi command line.");
	}
	const cwd = ctx?.cwd ?? process.cwd();
	try {
		accessSync(cwd);
	} catch {
		throw new Error(`Working directory does not exist: ${cwd}\nCannot launch a subagent.`);
	}
	const stem = randomBytes(6).toString("hex");
	const logPath = join(tmpdir(), `sa-${stem}.out`);
	const errPath = join(tmpdir(), `sa-${stem}.err`);
	const nonce = randomBytes(8).toString("hex");
	const outFd = openSync(logPath, "wx", 0o600);
	const errFd = openSync(errPath, "wx", 0o600);
	try {
		const args = ["--print", "--no-session", "--model", model];
		for (const extension of childExtensions()) args.push("-e", extension);
		args.push("--", task);
		const child = spawn("sh", ["-c", SA_WRAPPER, "sa", logPath, errPath, nonce, process.execPath, entry, ...args], {
			cwd,
			env: childEnv(),
			detached: true,
			stdio: "ignore",
		});
		// The armed reply must not lie: spawn failures surface here as errors.
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		child.on("error", () => {});
		child.unref();
		const reg = registry();
		const job: BgJob = {
			kind: "subagent",
			id: `sa-${reg.nextId++}`,
			task,
			model,
			logPath,
			errPath,
			pid: child.pid!,
			nonce,
			startedAt: Date.now(),
			state: "running",
			notified: false,
			stopping: false,
			groupGone: false,
		};
		reg.jobs.set(job.id, job);
		ensurePoller();
		return job;
	} finally {
		closeSync(outFd);
		closeSync(errFd);
	}
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
	const parts = live.map((j) => `${j.id} ${timerField(Date.now() - j.startedAt, jobTotalMs(j))}`);
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
	if (text === "") lines.push(cut === "bytes" ? `Earlier output was cut - full output: ${job.logPath}` : "(no output)");
	else if (cut === "bytes") lines.push(`Output (tail; earlier output cut) - full output: ${job.logPath}`, text);
	else if (cut === "lines") lines.push(`Output, last ${TAIL_LINES} lines - full output: ${job.logPath}`, text);
	else lines.push("Output:", text, `Full output: ${job.logPath}`);
	return lines.join("\n");
}

function subagentCompletionText(job: SubagentJob): string {
	const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10;
	const lines = [
		`Subagent ${job.id} ${outcome(job)}, ran ${seconds}s.`,
		`Task: ${oneLine(job.task)}`,
	];
	if (job.state === "exited" && job.exitCode === 0) {
		const { text, cut } = resultTail(job);
		if (text === "") lines.push(cut ? `Earlier response was cut - full result: ${job.logPath}` : "(no response text)");
		else if (cut) lines.push(`Result (tail; earlier response cut) - full result: ${job.logPath}`, text);
		else lines.push("Result:", text);
		return lines.join("\n");
	}
	const { text, cut } = errTail(job);
	if (text === "") lines.push(cut === "bytes" ? `Earlier diagnostics were cut - full diagnostics: ${job.errPath}` : "(no diagnostics)");
	else if (cut === "bytes") lines.push(`Diagnostics (tail; earlier output cut) - full diagnostics: ${job.errPath}`, text);
	else if (cut === "lines") lines.push(`Diagnostics, last ${TAIL_LINES} lines - full diagnostics: ${job.errPath}`, text);
	else lines.push("Diagnostics:", text);
	lines.push(`Any partial response: ${job.logPath}`);
	return lines.join("\n");
}

function deliver(job: BgJob): void {
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
			// followUp never interrupts a running turn; triggerTurn wakes an idle
			// session. This is the completion carrier, not a steer.
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch {
		// A stale handle must not consume the result: the rebound instance
		// retries on its next tick.
		job.notified = false;
	}
}

const killsInFlight = new Map<string, Promise<string>>();

// ---- wait ----
//
// Waiters live in module scope, never in the registry: a reload kills the
// module copy and its pending tool calls together, and a fresh instance must
// not inherit promises owned by dead ones. Resolution is state-based - every
// tick satisfies any registered waiter whose condition already holds - so a
// job settling outside pollTick (a stop path) can never strand a wait.

type WaitEnd = "settled" | "kill" | "timeout" | "abort";

interface JobWaiter {
	job: BgJob;
	resolve: (end: WaitEnd) => void;
}

interface AllWaiter {
	resolve: (end: WaitEnd, claimed: BgJob[]) => void;
}

const jobWaiters = new Set<JobWaiter>();
const allWaiters = new Set<AllWaiter>();

// Called from pollTick only, between the settle loop and the deliver pass:
// a wait that can be satisfied claims its completion here (notified set), so
// deliver() skips it in the same tick - wait wins, the follow-up never
// duplicates what the wait returns.
function resolveWaiters(): void {
	for (const waiter of jobWaiters) {
		if (isLive(waiter.job)) continue;
		jobWaiters.delete(waiter);
		waiter.job.notified = true;
		waiter.resolve("settled");
	}
	if (allWaiters.size === 0 || liveJobs().length > 0) return;
	const claimed = [...registry().jobs.values()].filter((job) => !isLive(job) && !job.notified);
	for (const job of claimed) job.notified = true;
	for (const waiter of allWaiters) {
		allWaiters.delete(waiter);
		waiter.resolve("settled", claimed);
	}
}

// A settled job whose result the model already has in context: outcome and
// log path only - never a second copy of the tail.
function deliveredOneLiner(job: BgJob): string {
	const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10;
	return `${job.id} ${outcome(job)}, ran ${seconds}s - result already delivered. Log: ${job.logPath}`;
}

// The still-running line: synchronization status only, never an output tail
// - progress inspection stays a deliberate log read. For a subagent the
// useful pointer is the diagnostics file: the result file stays empty until
// the child's final response lands.
function stillRunningLine(job: BgJob): string {
	const elapsed = fmtElapsedMs(Date.now() - job.startedAt);
	const total = jobTotalMs(job);
	return `${job.id} still running, ${total !== undefined ? `${elapsed} / ${fmtTotalMs(total)}` : elapsed}. Log: ${logPointer(job)}`;
}

// Where a "still running" pointer should lead: the bash log, a subagent's
// diagnostics (its result file is empty until completion).
function logPointer(job: BgJob): string {
	return job.kind === "subagent" ? job.errPath : job.logPath;
}

// The all-wait return: every job this session started, headed per job - the
// full completion text for the ones this wait claims, a one-liner for results
// already in context. `claimed` is the authoritative claim set resolveWaiters
// marked, passed only when the wait ended settled; any other end recomputes;
// an empty claim from a timeout/abort leg must never read as "nothing was
// undelivered" while settled-but-undelivered jobs exist.
function composeAllWait(claimed: BgJob[] | undefined): string {
	const settled = [...registry().jobs.values()]
		.filter((job) => !isLive(job))
		.sort((a, b) => a.startedAt - b.startedAt);
	const full = claimed ?? settled.filter((job) => !job.notified);
	for (const job of full) job.notified = true;
	if (full.length === 0) return "No background jobs pending.";
	return settled.map((job) => (full.includes(job) ? `${job.id}\n${completionText(job)}` : deliveredOneLiner(job))).join("\n\n");
}

function abortAllText(): string {
	return ["Wait aborted - jobs untouched, still running:", ...liveJobs().map(stillRunningLine)].join("\n");
}

function settleFromMarker(job: BgJob): string | undefined {
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
		if (reason === "stopped") job.notified = true;
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
	// Waiters claim before the deliver pass: a wait satisfiable this tick
	// marks its job notified here, so deliver() never duplicates what the
	// wait returns - wait wins in the same tick.
	resolveWaiters();
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
	stopPoller();
	ensurePoller();
}

const BACKGROUND_CONTRACT =
	"Set background:true to run a command detached and continue other work: the call returns at once with a job id and a log path, and the result is delivered to you automatically as a follow-up message when the command finishes - do not poll or sleep-wait. wait returns a background job's result in this turn and no follow-up fires for a job it returns; the log is for progress while the job runs. timeout, if set, limits total runtime including time in the background. Stop a running background job with stop.";

const SUBAGENT_CONTRACT =
	"Launch a subagent: a fresh Pi session in this working directory that carries out a task independently. The child starts from the task and ordinary project instructions - never this conversation - with ordinary tools but no subagent tool of its own (no recursive agents). Start is asynchronous: the call returns at once with a job id (sa-N). Its final response is delivered here automatically when it finishes, or returned in-turn by wait; stop terminates a running child. The child model is user-configured, not chosen per call.";

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
				Type.Boolean({ description: "Run detached and deliver the result as an automatic follow-up message when it finishes" }),
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
							"The result will be delivered here automatically when it finishes, or returned in-turn by wait - continue other work instead of polling.",
						].join("\n"),
					},
				],
				details: undefined,
			};
		},
	});
	handle.registerTool({
		name: "stop",
		label: "Stop background job",
		description:
			"Stop a background job (a bash command started with background:true, or a subagent) that this session started, by its job id (bg-N or sa-N). Terminates the job's whole process group and reports the observed outcome; the stop result is the outcome - no completion message follows for a job you stopped.",
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
			if (job.state !== "running" && job.state !== "stopping") {
				const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10;
				const where = job.kind === "subagent" ? `Result: ${job.logPath}` : `Output: ${job.logPath}`;
				return {
					content: [
						{
							type: "text",
							text: `${job.id} already finished: ${outcome(job)}, ran ${seconds}s. ${where}`,
						},
					],
					details: { id: job.id, state: job.state },
				};
			}
			const how = await stopJob(job, "stopped");
			return {
				content: [{ type: "text", text: `${job.id} ${how}.` }],
				details: { id: job.id, state: job.state, outcome: how },
			};
		},
	});
	handle.registerTool({
		name: "wait",
		label: "Wait for background job",
		description:
			"Wait for a background job (a bash command started with background:true, or a subagent) that this session started and get its result in this turn: the completion that would have arrived as a follow-up message is returned by this call instead - no follow-up fires for a job wait returns. Give id (bg-N or sa-N) to wait for one job, or all: true to wait until no background job is still running; jobs whose results were already delivered get a one-line pointer. timeout (seconds) bounds the wait; on expiry each still-running job gets one line with its log path, never an output tail. Aborting the call ends the wait only - the job keeps running.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Job id returned by a background bash call (bg-N) or a subagent call (sa-N)" })),
			all: Type.Optional(Type.Boolean({ description: "Wait until no background job from this session is still running" })),
			timeout: Type.Optional(Type.Number({ description: "Maximum seconds to wait; omitted means no deadline" })),
		}),
		async execute(_toolCallId, params, signal) {
			const input = params as { id?: string; all?: boolean; timeout?: number };
			if (input.id !== undefined && input.all === true) {
				throw new Error("Give either id or all, not both.");
			}
			if (input.id === undefined && input.all !== true) {
				throw new Error("Give id (a bg-N or sa-N job id) or all: true.");
			}
			validateTimeout(input.timeout);
			const deadline = input.timeout !== undefined ? Date.now() + input.timeout * 1000 : undefined;

			if (input.id !== undefined) {
				const job = registry().jobs.get(input.id);
				if (!job) {
					return {
						content: [
							{ type: "text", text: `No background job ${input.id} in this session. Only jobs started here can be waited on.` },
						],
					details: { id: input.id, found: false },
					};
				}
				// Already settled: the full completion text if the follow-up never
				// fired, a one-line pointer if it did (the model has it in
				// context). Synchronous - no tick can deliver in between.
				if (!isLive(job)) {
					if (job.notified) {
						return {
							content: [{ type: "text", text: deliveredOneLiner(job) }],
							details: { id: job.id, state: job.state, delivered: true },
						};
					}
					job.notified = true;
					return {
						content: [{ type: "text", text: completionText(job) }],
						details: { id: job.id, state: job.state, exitCode: job.exitCode ?? null, logPath: job.logPath },
					};
				}
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: `Wait aborted - ${job.id} still running, untouched. Log: ${logPointer(job)}` }],
						details: { id: job.id, aborted: true },
					};
				}
				// Register synchronously - before any await - so a pollTick firing
				// between this call and registration cannot strand the wait.
				const waiter: JobWaiter = { job, resolve: () => {} };
				const settleP = new Promise<WaitEnd>((resolve) => {
					waiter.resolve = resolve;
				});
				jobWaiters.add(waiter);
				const onAbort = (): void => waiter.resolve("abort");
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					let end: WaitEnd = "settled";
					for (;;) {
						// A stop already in flight is awaited through its shared
						// promise, not a second watcher path.
						const kill = killsInFlight.get(job.id);
						if (deadline !== undefined) {
							const remaining = deadline - Date.now();
							if (remaining <= 0) {
								end = "timeout";
								break;
							}
							timer = setTimeout(() => waiter.resolve("timeout"), remaining);
						}
						signal?.addEventListener("abort", onAbort, { once: true });
						const legs: Promise<WaitEnd>[] = [settleP];
						if (kill !== undefined) legs.push(kill.then((): WaitEnd => "kill"));
						end = await Promise.race(legs);
						clearTimeout(timer);
						timer = undefined;
						signal?.removeEventListener("abort", onAbort);
						// A stop can end unresolved (the group survived); the job is
						// still live and the waiter still registered - wait on.
						if (end === "kill" && isLive(job)) continue;
						break;
					}
					// Compose from state, not from the winning leg: a job that
					// settled as the wait ended must not lose its completion.
					if (!isLive(job)) {
						if (end !== "settled" && job.notified) {
							return {
								content: [{ type: "text", text: deliveredOneLiner(job) }],
								details: { id: job.id, state: job.state, delivered: true },
							};
						}
						// The wait claims the completion: resolveWaiters already marked
						// it, or an out-of-band settle is marked here.
						job.notified = true;
						return {
							content: [{ type: "text", text: completionText(job) }],
							details: { id: job.id, state: job.state, exitCode: job.exitCode ?? null, logPath: job.logPath },
						};
					}
					if (end === "timeout") {
						return {
							content: [{ type: "text", text: stillRunningLine(job) }],
							details: { id: job.id, stillRunning: true },
						};
					}
					return {
						content: [{ type: "text", text: `Wait aborted - ${job.id} still running, untouched. Log: ${logPointer(job)}` }],
						details: { id: job.id, aborted: true },
					};
				} finally {
					jobWaiters.delete(waiter);
					if (timer !== undefined) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				}
			}

			// all: true - resolve when no live job remains; settled-but-undelivered
			// jobs contribute their texts, everything else a one-liner.
			if (liveJobs().length === 0) {
				return { content: [{ type: "text", text: composeAllWait(undefined) }], details: { all: true, pending: 0 } };
			}
			if (signal?.aborted) {
				return { content: [{ type: "text", text: abortAllText() }], details: { all: true, aborted: true } };
			}
			let claimed: BgJob[] | undefined;
			const allWaiter: AllWaiter = { resolve: () => {} };
			const allSettleP = new Promise<WaitEnd>((resolve) => {
				let ended = false;
				allWaiter.resolve = (end, jobs) => {
					// First end wins: a late abort firing after resolveWaiters
					// claimed must not overwrite the claim.
					if (ended) return;
					ended = true;
					claimed = jobs;
					resolve(end);
				};
			});
			allWaiters.add(allWaiter);
			const onAllAbort = (): void => allWaiter.resolve("abort", []);
			let allTimer: ReturnType<typeof setTimeout> | undefined;
			try {
				let end: WaitEnd = "settled";
				for (;;) {
					const kills = [
						...new Set(
							liveJobs()
								.map((j) => killsInFlight.get(j.id))
								.filter((k): k is Promise<string> => k !== undefined),
						),
					];
					if (deadline !== undefined) {
						const remaining = deadline - Date.now();
						if (remaining <= 0) {
							end = "timeout";
							break;
						}
						allTimer = setTimeout(() => allWaiter.resolve("timeout", []), remaining);
					}
					signal?.addEventListener("abort", onAllAbort, { once: true });
					const legs: Promise<WaitEnd>[] = [
						allSettleP,
						...kills.map((k) => k.then((): WaitEnd => "kill")),
					];
					end = await Promise.race(legs);
					clearTimeout(allTimer);
					allTimer = undefined;
					signal?.removeEventListener("abort", onAllAbort);
					if (end === "kill" && liveJobs().length > 0) continue;
					break;
				}
				if (liveJobs().length === 0) {
					// Trust resolveWaiters' claim only for a settled end: the
					// timeout/abort legs carry an empty claim, which must not mask
					// undelivered jobs - recompute from state instead.
					return {
						content: [{ type: "text", text: composeAllWait(end === "settled" ? claimed : undefined) }],
						details: { all: true },
					};
				}
				if (end === "timeout") {
					const live = liveJobs();
					return {
						content: [{ type: "text", text: live.map(stillRunningLine).join("\n") }],
						details: { all: true, stillRunning: live.length },
					};
				}
				return { content: [{ type: "text", text: abortAllText() }], details: { all: true, aborted: true } };
			} finally {
				allWaiters.delete(allWaiter);
				if (allTimer !== undefined) clearTimeout(allTimer);
				signal?.removeEventListener("abort", onAllAbort);
			}
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
				if (model === undefined) {
						throw new Error(
							`No subagent model configured. Set ${MODEL_ENV} to a model pattern (anything pi --model accepts) in the environment Pi runs in - there is no fallback to the session model.`,
						);
					}
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
								`The final response will be delivered here automatically when it finishes, or returned in-turn by wait - continue other work instead of polling.`,
								`No intermediate progress: ${job.errPath} collects diagnostics if it fails; the result lands in ${job.logPath} at completion.`,
							].join("\n"),
						},
					],
					details: undefined,
				};
			},
		});
	}
	handle.registerCommand("bg", {
		description: "List background jobs this session started (commands and subagents), with live timers (snapshot card in the transcript; no model context)",
		handler: async () => {
			// The card is a record of the check: custom entries never enter LLM
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
			// replacement instance attaches. Pending waits die with this module
			// copy - dropping the waiter sets keeps its last ticks from claiming
			// a completion (notified) that only a live caller could ever return.
			jobWaiters.clear();
			allWaiters.clear();
			pi = undefined;
			return;
		}
		await stopAllJobs();
		registry().jobs.clear();
		stopPoller();
		ui?.setStatus(STATUS_KEY, undefined);
		ui = undefined;
		pi = undefined;
	});
}
