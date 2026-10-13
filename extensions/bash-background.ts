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
const TAIL_BYTES = 4096;
const TAIL_LINES = 20;
const MAX_TIMEOUT_MS = 2_147_483_647;
const SESSION_ENV_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"] as const;

// The wrapper appends a nonce-tagged exit line: a reloaded instance holds no
// ChildProcess, it recovers the exit code from the log.
const WRAPPER = [
	"cmd=$1; nonce=$2; shift 2",
	'"$@" "$cmd"; code=$?',
	`printf "\\n${MARKER}:%s:%s\\n" "$nonce" "$code"`,
].join("\n");

type JobState = "running" | "stopping" | "exited" | "unknown" | "stopped";

// Plain data only: a reloaded instance takes jobs over from marker reads, so
// nothing process-bound or session-bound may live here.
interface BgJob {
	id: string;
	command: string;
	logPath: string;
	pid: number;
	nonce: string;
	startedAt: number;
	deadlineAt?: number;
	state: JobState;
	stopReason?: "stopped" | "timeout";
	/** Set when a stop escalation ended unresolved; the command may live on. */
	stopFailed?: "survived" | "denied";
	exitCode?: number;
	endedAt?: number;
	notified: boolean;
	stopping: boolean;
	groupGone: boolean;
}

interface Registry {
	jobs: Map<string, BgJob>;
	nextId: number;
	poller?: ReturnType<typeof setInterval>;
}

// On globalThis because pi reloads extensions with moduleCache: false — module
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

// EPERM on a probe means the target exists but cannot be signalled —
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

// Bounded reads only: a log can grow without limit.
function readTail(job: BgJob, bytes: number): { text: string; size: number } {
	try {
		const fd = openSync(job.logPath, "r");
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

function oneLine(command: string): string {
	const line = command.replace(/\s*\n\s*/g, " ");
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

// The card caps tighter than oneLine: a snapshot row stays one line on any
// reasonable pane instead of wrapping.
function cardCommand(command: string): string {
	const line = oneLine(command);
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
	return job.deadlineAt !== undefined ? job.deadlineAt - job.startedAt : undefined;
}

function liveJobs(): BgJob[] {
	return [...registry().jobs.values()]
		.filter((j) => j.state === "running" || j.state === "stopping")
		.sort((a, b) => a.startedAt - b.startedAt);
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
		const base = job.exitCode === 0 ? "exited with code 0" : `failed: exited with code ${job.exitCode}`;
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
	const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10;
	const { text, cut } = outputTail(job);
	const lines = [
		`Background command ${job.id} ${outcome(job)}, ran ${seconds}s.`,
		`Command: ${oneLine(job.command)}`,
	];
	if (text === "") lines.push(cut === "bytes" ? `Earlier output was cut — full output: ${job.logPath}` : "(no output)");
	else if (cut === "bytes") lines.push(`Output (tail; earlier output cut) — full output: ${job.logPath}`, text);
	else if (cut === "lines") lines.push(`Output, last ${TAIL_LINES} lines — full output: ${job.logPath}`, text);
	else lines.push("Output:", text, `Full output: ${job.logPath}`);
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
// settlement was actually observed — an unkillable group stays running.
async function stopJob(job: BgJob, reason: "stopped" | "timeout"): Promise<string> {
	const existing = killsInFlight.get(job.id);
	if (existing) return existing;
	const run = (async (): Promise<string> => {
		job.stopping = true;
		job.stopReason = reason;
		// Set before the kill so an explicitly stopped command can never
		// deliver afterwards; the stop result itself carries the outcome. A
		// deadline stop keeps delivering — with its cause preserved.
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
		for (let waited = 0; !stopped && !denied && waited < STOP_GRACE_MS; waited += STOP_POLL_STEP_MS) {
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
		if (job.deadlineAt !== undefined && !job.stopFailed && Date.now() >= job.deadlineAt) {
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
	stopPoller();
	ensurePoller();
}

const BACKGROUND_CONTRACT =
	"Set background:true to run a command detached and continue other work: the call returns at once with a job id and a log path, and the result is delivered to you automatically as a follow-up message when the command finishes — do not poll or sleep-wait; read the log anytime for progress (reading never consumes the result). timeout, if set, limits total runtime including time in the background. Stop a running background command with bash_stop.";

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
							`Output streams to ${job.logPath} — read it anytime for progress; reading never consumes the result.`,
							job.deadlineAt !== undefined ? `Deadline: ${input.timeout}s total runtime.` : "No deadline.",
							"The result will be delivered here automatically when it finishes — continue other work instead of polling.",
						].join("\n"),
					},
				],
				details: undefined,
			};
		},
	});
	handle.registerTool({
		name: "bash_stop",
		label: "Stop background command",
		description:
			"Stop a background command (bash with background:true) that this session started, by its job id (bg-N). Terminates the command's whole process group and reports the observed outcome; the stop result is the outcome — no completion message follows for a command you stopped.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id returned by a background bash call, e.g. bg-1" }),
		}),
		async execute(_toolCallId, params) {
			const job = registry().jobs.get(params.id);
			if (!job) {
				return {
					content: [{ type: "text", text: `No background command ${params.id} in this session. Only commands started here can be stopped.` }],
					details: { id: params.id, found: false },
				};
			}
			if (job.state !== "running" && job.state !== "stopping") {
				const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 100) / 10;
				return {
					content: [
						{
							type: "text",
							text: `${job.id} already finished: ${outcome(job)}, ran ${seconds}s. Output: ${job.logPath}`,
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
	handle.registerCommand("bg", {
		description: "List background commands this session started, with live timers (snapshot card in the transcript; no model context)",
		handler: async () => {
			// The card is a record of the check: custom entries never enter LLM
			// context, and the snapshot stays honest in scrollback and on disk.
			pi?.appendEntry("bash-bg-status", {
				at: new Date().toISOString(),
				jobs: liveJobs().map((j) => ({
					id: j.id,
					elapsedMs: Date.now() - j.startedAt,
					timeoutMs: jobTotalMs(j),
					command: cardCommand(j.command),
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
		const lines = [theme.fg("dim", `background jobs — checked ${time}`)];
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
			// replacement instance attaches.
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
