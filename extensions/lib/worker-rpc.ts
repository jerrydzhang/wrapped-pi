// Reusable subprocess transport for Pi's RPC protocol: one long-lived child
// speaking strict LF-only JSONL on stdio (pinned Pi docs: rpc.md,
// rpc-commands.md, json.md, rpc-extension-ui.md). The transport owns framing,
// id correlation, timeouts, backpressure-honoring writes, and the private
// stdout/stderr log files; it deliberately does not know what a prompt or a
// session is - callers send commands and read records.
//
// Reload contract: pi reloads extensions with moduleCache: false, so module
// state dies on /reload. Every live worker is rooted in a globalThis registry
// keyed by pid (Symbol.for, shared across module instances), so one process
// and its stdio survive a parent /reload: stdout keeps draining, pending
// requests keep correlating, and nothing stalls in the gap between the old
// module dying and the new one rebinding. onRecord/onExit are plain settable
// properties read at dispatch time, so rebinding never attaches a second
// listener - the child's stdout has exactly one listener, attached once at
// spawn. A surviving worker is retrieved with WorkerRpc.get(pid); instances
// from a pre-reload module stay fully functional (duck-typed), so holders of
// old references can simply rebind and carry on.
//
// Deliberate limits: start() only spawns (readiness is the caller's get_state
// request), there is no restart/supervise/watch logic anywhere, and protocol
// errors close stdin rather than kill - escalating to stop is the parent's
// job. The environment passed in options.env is forwarded verbatim and never
// inspected, merged, or logged.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface WorkerRpcOptions {
	executable: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	logPath: string;
	errPath: string;
	onRecord?: (record: any) => void;
	onExit?: (code: number | null, signal: string | null) => void;
}

interface PendingCall {
	resolve: (data: any) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

// In-memory frame bound: a child streaming more than this without an LF is
// not speaking the protocol; fail honestly instead of buffering without limit.
const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PENDING = 64;
// setTimeout cannot schedule beyond 2^31 - 1 ms; anything larger is invalid.
const MAX_TIMEOUT_MS = 2_147_483_647;

// Shared across module instances (pi reloads extensions with moduleCache:
// false), this is what lets one process and its stdio outlive a /reload.
const WORKERS_KEY = Symbol.for("wrapped-pi.worker-rpc.workers");

function workerRegistry(): Map<number, WorkerRpc> {
	const holder = globalThis as typeof globalThis & { [WORKERS_KEY]?: Map<number, WorkerRpc> };
	return (holder[WORKERS_KEY] ??= new Map<number, WorkerRpc>());
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class WorkerRpc {
	/** Live worker for a pid, surviving module reloads; undefined once exited. */
	static get(pid: number): WorkerRpc | undefined {
		return workerRegistry().get(pid);
	}

	static async start(options: WorkerRpcOptions): Promise<WorkerRpc> {
		if (!isPlainObject(options)) throw new TypeError("WorkerRpc.start: options must be an object");
		if (typeof options.executable !== "string" || options.executable === "") {
			throw new TypeError("WorkerRpc.start: executable must be a non-empty string");
		}
		if (!Array.isArray(options.args) || options.args.some((arg) => typeof arg !== "string")) {
			throw new TypeError("WorkerRpc.start: args must be an array of strings");
		}
		if (typeof options.cwd !== "string" || options.cwd === "") {
			throw new TypeError("WorkerRpc.start: cwd must be a non-empty string");
		}
		if (!isPlainObject(options.env)) {
			throw new TypeError("WorkerRpc.start: env must be an environment object");
		}
		if (typeof options.logPath !== "string" || options.logPath === "") {
			throw new TypeError("WorkerRpc.start: logPath must be a non-empty string");
		}
		if (typeof options.errPath !== "string" || options.errPath === "") {
			throw new TypeError("WorkerRpc.start: errPath must be a non-empty string");
		}

		// Private exclusive creates (0600, fail if the path exists): the stdout
		// event log and the child's stderr diagnostics. Opened before the spawn
		// so not a single stdout byte is lost; closed again on every failure
		// branch below.
		let logFd: number;
		try {
			logFd = openSync(options.logPath, "ax", 0o600);
		} catch (error) {
			throw new Error(`WorkerRpc.start: cannot create stdout log ${options.logPath}: ${errorMessage(error)}`);
		}
		let errFd: number;
		try {
			errFd = openSync(options.errPath, "ax", 0o600);
		} catch (error) {
			closeSync(logFd);
			throw new Error(`WorkerRpc.start: cannot create stderr log ${options.errPath}: ${errorMessage(error)}`);
		}

		let worker: WorkerRpc;
		try {
			worker = new WorkerRpc(options, logFd, errFd);
		} catch (error) {
			closeSync(logFd);
			closeSync(errFd);
			throw error;
		}
		try {
			// start() is only the spawn contract: wait for the fork/exec ack (or
			// its failure), never for readiness - that is the caller's get_state.
			await worker.#awaitSpawnAck();
		} catch (error) {
			worker.#disposeAfterFailedStart();
			throw error;
		}
		if (worker.pid <= 0) {
			worker.#disposeAfterFailedStart();
			throw new Error("WorkerRpc.start: spawn succeeded without a pid");
		}
		// A child that exits immediately did spawn; it lands in the registry only
		// while it is alive, and its exit flows through onExit as usual.
		if (!worker.exited) workerRegistry().set(worker.pid, worker);
		return worker;
	}

	#child: ChildProcess;
	#pid: number;
	#errPath: string;
	#logFd: number;
	#errFd: number;
	#decoder = new StringDecoder("utf8");
	#buffer = "";
	#pending = new Map<string, PendingCall>();
	#nextId = 0;
	#writeChain: Promise<void> = Promise.resolve();
	#queuedWrites = 0;
	#exited = false;
	#exitCode: number | null = null;
	#signal: string | null = null;
	#finalized = false;
	#inputClosed = false;
	#discarding = false;
	#filesClosed = false;
	#lastError: string | undefined;

	onRecord: ((record: any) => void) | undefined;
	onExit: ((code: number | null, signal: string | null) => void) | undefined;

	private constructor(options: WorkerRpcOptions, logFd: number, errFd: number) {
		this.#logFd = logFd;
		this.#errFd = errFd;
		this.#errPath = options.errPath;
		this.onRecord = options.onRecord;
		this.onExit = options.onExit;

		// Direct detached spawn: no shell interprets anything, and the child is
		// its own process group leader, outliving this module instance.
		const child = spawn(options.executable, options.args, {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child = child;
		this.#pid = typeof child.pid === "number" ? child.pid : 0;

		child.on("error", (error: Error) => {
			// Spawn or kill failures: pending calls can never be answered. A real
			// exit event, when it follows, still reports the true code and signal.
			this.#lastError = errorMessage(error);
			this.#rejectAllPending(new Error(`worker process error: ${this.#lastError}; stderr diagnostics: ${this.#errPath}`));
		});
		child.stdin?.on("error", (error: Error) => {
			this.#rejectAllPending(new Error(`worker stdin failed: ${errorMessage(error)}; stderr diagnostics: ${this.#errPath}`));
		});
		// Exactly one stdout reader for the life of the process, attached once
		// here - callback rebinding never touches these listeners, and the drain
		// continues even while no observer is bound (the reload gap).
		child.stdout?.on("data", (chunk: Buffer | string) => this.#feed(chunk));
		child.stdout?.on("error", (error: Error) => {
			this.#lastError = `stdout stream: ${errorMessage(error)}`;
			this.#rejectAllPending(new Error(`worker stdout failed: ${this.#lastError}; stderr diagnostics: ${this.#errPath}`));
		});
		child.stdout?.once("end", () => this.#flushAtEof());
		// stderr is diagnostics only: captured to its private file, never parsed
		// as protocol data (a stream error here loses diagnostics, nothing else).
		child.stderr?.on("data", (chunk: Buffer | string) => this.#appendErr(chunk));
		child.stderr?.on("error", () => {});
		child.once("exit", (code: number | null, signal: string | null) => this.#finalizeExit(code, signal));
		// 'close' fires after all stdio streams flushed - the only safe moment
		// to release the log files.
		child.once("close", () => this.#closeFiles());
	}

	get pid(): number {
		return this.#pid;
	}
	get exited(): boolean {
		return this.#exited;
	}
	get exitCode(): number | null {
		return this.#exitCode;
	}
	get signal(): string | null {
		return this.#signal;
	}

	/**
	 * Send one command record, correlate its response by id, and resolve with
	 * the response's `data` (undefined when the success response carries none).
	 * Rejects on `success: false` (with the reported error), on timeout, and on
	 * exit or a dead pipe. The id is generated when the command has none; a
	 * caller-supplied string id is honored (bash-style event correlation).
	 */
	async request(command: Record<string, unknown>, timeoutMs?: number): Promise<any> {
		if (!isPlainObject(command)) {
			throw new TypeError("WorkerRpc.request: command must be a plain JSON object");
		}
		const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
			throw new TypeError(
				`WorkerRpc.request: timeoutMs must be a positive finite number (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
			);
		}
		if (this.#exited) throw this.#exitStateError();
		if (this.#inputClosed) {
			throw new Error("worker stdin is closed; the parent asked for orderly shutdown and no response can arrive");
		}
		const explicitId = (command as { id?: unknown }).id;
		const id = typeof explicitId === "string" && explicitId !== "" ? explicitId : `wr-${this.#pid}-${++this.#nextId}`;
		if (this.#pending.has(id)) throw new Error(`WorkerRpc.request: id already in flight: ${id}`);
		if (this.#pending.size >= MAX_PENDING) throw new Error("Worker RPC request backlog is full; wait for existing submissions or stop the worker.");
		// Serialize before registering the timer: malformed/cyclic command data
		// must not leave an unreachable pending entry behind.
		const payload = `${JSON.stringify({ ...command, id })}\n`;
		return new Promise<any>((resolve, reject) => {
			const entry: PendingCall = {
				resolve,
				reject,
				timer: setTimeout(() => {
					this.#pending.delete(id);
					reject(new Error(`timeout after ${timeout}ms waiting for response to ${String(command.type ?? "record")} (id ${id})`));
				}, timeout),
			};
			this.#pending.set(id, entry);
			this.#enqueueWrite(payload).catch((error: Error) => {
				if (this.#pending.get(id) !== entry) return;
				this.#pending.delete(id);
				clearTimeout(entry.timer);
				entry.reject(error);
			});
		});
	}

	/**
	 * Write one record to the child's stdin (extension_ui_response and any
	 * other fire-and-forget record), resolving once the pipe accepted it.
	 */
	async writeRecord(record: Record<string, unknown>): Promise<void> {
		if (!isPlainObject(record)) {
			throw new TypeError("WorkerRpc.writeRecord: record must be a plain JSON object");
		}
		// JSON.stringify can throw on circular structures; that and a dead pipe
		// reject the promise - writeRecord never fires-and-forgets its failures.
		return this.#enqueueWrite(`${JSON.stringify(record)}\n`);
	}

	/** Close stdin: the child's orderly-shutdown signal (Pi exits on stdin EOF). */
	closeInput(): void {
		if (this.#inputClosed) return;
		this.#inputClosed = true;
		const stdin = this.#child.stdin;
		if (stdin && stdin.writable) {
			try {
				stdin.end();
			} catch {
				// The pipe is already gone; the exit path reports reality.
			}
		}
	}

	#awaitSpawnAck(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (ok: boolean, error: Error | null) => {
				if (settled) return;
				settled = true;
				this.#child.off("spawn", onSpawn);
				this.#child.off("error", onError);
				this.#child.off("exit", onExit);
				if (ok) resolve();
				else reject(error);
			};
			const onSpawn = () => settle(true, null);
			// An instant exit still proves the spawn worked; its reporting belongs
			// to onExit and pending rejection, not to start().
			const onExit = () => settle(true, null);
			const onError = () =>
				settle(false, new Error(`worker spawn failed: ${this.#lastError ?? "unknown error"}; stderr diagnostics: ${this.#errPath}`));
			this.#child.once("spawn", onSpawn);
			this.#child.once("error", onError);
			this.#child.once("exit", onExit);
		});
	}

	#disposeAfterFailedStart(): void {
		// The spawn never happened: nothing is running, nothing to kill. Release
		// the log files this start had claimed so exclusive paths do not wedge.
		this.#closeFiles();
	}

	#enqueueWrite(payload: string): Promise<void> {
		if (this.#queuedWrites >= MAX_PENDING) return Promise.reject(new Error("Worker RPC write backlog is full."));
		this.#queuedWrites++;
		const attempt = () =>
			new Promise<void>((resolve, reject) => {
				const stdin = this.#child.stdin;
				if (this.#exited || this.#inputClosed || !stdin || !stdin.writable) {
					reject(
						this.#exited
							? this.#exitStateError()
							: new Error(this.#inputClosed ? "worker stdin is closed" : "worker stdin is not writable"),
					);
					return;
				}
				try {
					// One outstanding write at a time: the next record leaves only
					// after this one's callback fired, which honors the pipe's
					// backpressure instead of queueing unbounded in user space.
					stdin.write(payload, (error) => {
						if (error) reject(new Error(`worker stdin write failed: ${errorMessage(error)}`));
						else resolve();
					});
				} catch (error) {
					reject(new Error(`worker stdin write failed: ${errorMessage(error)}`));
				}
			});
		// Serialized chain; a failed link rejects its own caller and the chain
		// stays resolved so later writes still get their own honest rejection.
		const queued = this.#writeChain.then(attempt, attempt).finally(() => { this.#queuedWrites--; });
		this.#writeChain = queued.catch(() => {});
		return queued;
	}

	#feed(chunk: Buffer | string): void {
		// Preserve the complete byte stream, including malformed/oversized
		// frames, before applying the bounded in-memory protocol parser.
		this.#appendLog(chunk);
		// Incremental UTF-8 framing: StringDecoder carries split multibyte
		// sequences across chunks; LF is the only record boundary (readline
		// would also split on U+2028/U+2029, valid inside JSON strings).
		this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
		for (;;) {
			if (this.#discarding) {
				// After an oversized frame: drop bytes up to the next LF so a child
				// that keeps shouting cannot grow this buffer without bound, then
				// resume honest parsing.
				const resync = this.#buffer.indexOf("\n");
				if (resync === -1) {
					if (this.#buffer.length > MAX_FRAME_CHARS) this.#buffer = "";
					return;
				}
				this.#buffer = this.#buffer.slice(resync + 1);
				this.#discarding = false;
				continue;
			}
			const newline = this.#buffer.indexOf("\n");
			if (newline === -1) {
				if (this.#buffer.length > MAX_FRAME_CHARS) {
					this.#buffer = "";
					this.#discarding = true;
					this.#protocolError(`oversized frame: more than ${MAX_FRAME_CHARS} characters without LF; not speaking the RPC protocol`);
				}
				return;
			}
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.length > MAX_FRAME_CHARS) {
				this.#protocolError(`oversized frame: more than ${MAX_FRAME_CHARS} characters`);
				continue;
			}
			// Strict JSONL: strip an optional preceding CR (CRLF tolerated).
			this.#handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
	}

	#flushAtEof(): void {
		const tail = this.#buffer + this.#decoder.end();
		this.#buffer = "";
		if (this.#discarding || tail.length === 0) return;
		// Full child stdout reaches the log, then the truncated frame is
		// reported instead of silently swallowed.
		this.#protocolError(`stream ended mid-frame: ${tail.length} characters without a final LF`);
	}

	#handleLine(line: string): void {
		if (line.trim() === "") {
			this.#protocolError("empty record: a blank line is not a JSON object");
			return;
		}
		let record: any;
		try {
			record = JSON.parse(line);
		} catch {
			// JSON.parse messages may quote the raw line. Keep unexpected child
			// stdout out of the parent report; the private log preserves evidence.
			this.#protocolError("invalid JSON record; see the private event log");
			return;
		}
		if (!isPlainObject(record)) {
			this.#protocolError(`record is not a JSON object (got ${Array.isArray(record) ? "array" : typeof record})`);
			return;
		}
		if (record.type === "response" && typeof record.id === "string") {
			const entry = this.#pending.get(record.id);
			if (entry) {
				this.#pending.delete(record.id);
				clearTimeout(entry.timer);
				if (record.success === true) entry.resolve(record.data);
				else {
					const detail =
						typeof record.error === "string" && record.error !== ""
							? record.error
							: `command ${String(record.command ?? "unknown")} failed`;
					entry.reject(new Error(detail));
				}
				return;
			}
			// Unmatched response ids fall through to the observer below.
		}
		this.#dispatch(record);
	}

	#dispatch(record: any): void {
		// An observer that throws must never take the transport - or this
		// process - down; the next record still gets delivered.
		try {
			this.onRecord?.(record);
		} catch {
			// Observer failure is the observer's problem.
		}
	}

	#protocolError(message: string): void {
		// Protocol errors reach the observer as a record and close stdin; the
		// child's orderly EOF shutdown follows, and the parent escalates to stop
		// if it does not exit.
		this.#dispatch({ type: "worker_protocol_error", error: message });
		this.closeInput();
	}

	#appendLog(text: Buffer | string): void {
		try {
			this.#writeAll(this.#logFd, text);
		} catch (error) {
			// Log loss is reported, never fatal: the protocol stream continues.
			this.#dispatch({ type: "worker_protocol_error", error: `worker log write failed: ${errorMessage(error)}` });
		}
	}

	#appendErr(chunk: Buffer | string): void {
		try {
			this.#writeAll(this.#errFd, chunk);
		} catch (error) {
			this.#dispatch({ type: "worker_protocol_error", error: `worker stderr write failed: ${errorMessage(error)}` });
		}
	}

	#writeAll(fd: number, data: Buffer | string): void {
		const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		let offset = 0;
		while (offset < buffer.length) {
			offset += writeSync(fd, buffer, offset, buffer.length - offset);
		}
	}

	#exitStateError(): Error {
		return new Error(
			`worker exited (code=${this.#exitCode} signal=${this.#signal})${this.#lastError ? ` after ${this.#lastError}` : ""}; stderr diagnostics: ${this.#errPath}`,
		);
	}

	#rejectAllPending(error: Error): void {
		for (const entry of this.#pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.#pending.clear();
	}

	#finalizeExit(code: number | null, signal: string | null): void {
		if (this.#finalized) return;
		this.#finalized = true;
		this.#exited = true;
		this.#exitCode = code;
		this.#signal = signal;
		workerRegistry().delete(this.#pid);
		this.#rejectAllPending(this.#exitStateError());
		try {
			this.onExit?.(code, signal);
		} catch {
			// An observer that throws must not break the exit path.
		}
	}

	#closeFiles(): void {
		if (this.#filesClosed) return;
		this.#filesClosed = true;
		for (const fd of [this.#logFd, this.#errFd]) {
			try {
				closeSync(fd);
			} catch {
				// Already closed on a failure branch.
			}
		}
	}
}
