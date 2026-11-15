// Real child-process tests for the WorkerRpc transport
// (extensions/lib/worker-rpc.ts) against a tiny deterministic fixture
// (fake-rpc-worker.mjs) standing in for `pi --mode rpc`. No real Pi, no
// network, no credentials: the only secret-looking string exists to prove the
// transport never logs the environment. Coverage: strict LF framing (split
// UTF-8, U+2028/U+2029, CRLF), id correlation (generated, caller-supplied,
// out-of-order), errors/timeouts/exits, callback rebinding without duplicate
// listeners, oversized/malformed/truncated records, startup failure with fd
// hygiene, exclusive private log files, orderly stdin close, and the global
// reload registry.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRpc } from "../lib/worker-rpc.ts";
import type { WorkerRpcOptions } from "../lib/worker-rpc.ts";

const FIXTURE = fileURLToPath(new URL("./fake-rpc-worker.mjs", import.meta.url));
const SECRET = "worker-rpc-test-secret-never-log-7f3a91";
const FDS_DIR = "/proc/self/fd";
// Either honest reason a write or request can fail right after a shutdown
// request: the stdin close landed, or the child already exited.
const SHUT_DOWN = /stdin is closed|worker exited/;

const live: WorkerRpc[] = [];
const dirs: string[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
		await sleep(10);
	}
}

interface Harness {
	worker: WorkerRpc;
	records: any[];
	exits: Array<{ code: number | null; signal: string | null }>;
	dir: string;
	logPath: string;
	errPath: string;
}

async function startFixture(overrides: Partial<WorkerRpcOptions> = {}): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "worker-rpc-test-"));
	dirs.push(dir);
	const logPath = join(dir, "events.jsonl");
	const errPath = join(dir, "diagnostics.log");
	const records: any[] = [];
	const exits: Harness["exits"] = [];
	const worker = await WorkerRpc.start({
		executable: process.execPath,
		args: [FIXTURE],
		cwd: dir,
		env: { WORKER_TEST_SECRET: SECRET, WORKER_FIXTURE: "1" },
		logPath,
		errPath,
		onRecord: (record) => records.push(record),
		onExit: (code, signal) => exits.push({ code, signal }),
		...overrides,
	});
	live.push(worker);
	return { worker, records, exits, dir, logPath, errPath };
}

async function shutdown(harness: Harness): Promise<void> {
	const worker = harness.worker;
	if (worker.exited) return;
	worker.closeInput();
	try {
		await waitFor(() => worker.exited, "worker exit after closeInput");
	} catch {
		try {
			process.kill(worker.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
		await waitFor(() => worker.exited, "worker exit after SIGKILL");
	}
}

test("request backlog is bounded, and circular inputs never consume pending slots", async () => {
	const harness = await startFixture();
	try {
		const cyclic: any = { type: "echo" }; cyclic.self = cyclic;
		for (let i = 0; i < 70; i++) await assert.rejects(harness.worker.request(cyclic), /circular/i);
		assert.equal((await harness.worker.request({ type: "echo", payload: "still usable" })).payload, "still usable");
		const pending = Array.from({ length: 64 }, () => harness.worker.request({ type: "silent" }).catch((error) => error));
		await assert.rejects(harness.worker.request({ type: "echo" }), /backlog is full/);
		harness.worker.closeInput();
		await Promise.all(pending);
	} finally { await shutdown(harness); }
});

test("start spawns a detached child with private exclusive 0600 logs", async () => {
	const harness = await startFixture();
	try {
		const { worker } = harness;
		assert.ok(worker.pid > 0, "spawned child has a pid");
		// detached: the child leads its own process group.
		let ownGroup = false;
		try {
			process.kill(-worker.pid, 0);
			ownGroup = true;
		} catch {
			ownGroup = false;
		}
		assert.ok(ownGroup, "child is its own process group leader");
		for (const path of [harness.logPath, harness.errPath]) {
			const mode = statSync(path).mode & 0o777;
			assert.equal(mode, 0o600, `${path} is private`);
		}
	} finally {
		await shutdown(harness);
	}
});

test("request resolves response data and the full stdout JSON reaches the log", async () => {
	const harness = await startFixture();
	try {
		const data = await harness.worker.request({ type: "echo", payload: "ping" });
		assert.equal(data.payload, "ping");
		assert.match(data.sawId, /^wr-\d+-\d+$/, "generated correlation id echoed by the fixture");
		await waitFor(() => readFileSync(harness.logPath, "utf8").includes('"type":"response"'), "response logged");
		assert.ok(
			readFileSync(harness.logPath, "utf8").includes('"payload":"ping"'),
			"the complete record JSON is on disk",
		);
	} finally {
		await shutdown(harness);
	}
});

test("caller-supplied ids are honored; a duplicate in-flight id is rejected", async () => {
	const harness = await startFixture();
	try {
		const data = await harness.worker.request({ type: "echo", id: "custom-1", payload: "x" });
		assert.equal(data.sawId, "custom-1");
		const slow = harness.worker.request({ type: "slow", id: "custom-2", ms: 80 });
		await assert.rejects(() => harness.worker.request({ type: "slow", id: "custom-2", ms: 80 }), /already in flight/);
		assert.equal((await slow).waitedMs, 80);
	} finally {
		await shutdown(harness);
	}
});

test("CRLF-terminated records are tolerated", async () => {
	const harness = await startFixture();
	try {
		await harness.worker.writeRecord({ type: "emit", record: { type: "crlf_event", n: 1 }, crlf: true });
		await waitFor(() => harness.records.some((record) => record.type === "crlf_event"), "crlf record delivered");
		assert.equal(harness.records.find((record) => record.type === "crlf_event")?.n, 1);
	} finally {
		await shutdown(harness);
	}
});

test("UTF-8 multibyte sequences split across chunks frame as one record", async () => {
	const harness = await startFixture();
	try {
		const payload = "a中😀é tail";
		// 2-byte chunks cut the 3- and 4-byte characters mid-sequence.
		await harness.worker.writeRecord({ type: "emit_split", payload, chunkSize: 2, delayMs: 2 });
		await waitFor(() => harness.records.some((record) => record.type === "split_event"), "split record delivered");
		assert.equal(harness.records.find((record) => record.type === "split_event")?.payload, payload);
		const data = await harness.worker.request({ type: "echo", payload: "after" });
		assert.equal(data.payload, "after", "stream stays healthy after split chunks");
	} finally {
		await shutdown(harness);
	}
});

test("U+2028 and U+2029 inside strings are content, not record boundaries", async () => {
	const harness = await startFixture();
	try {
		const text = "a\u2028b\u2029c";
		await harness.worker.writeRecord({ type: "emit", record: { type: "sep_event", text } });
		await waitFor(() => harness.records.some((record) => record.type === "sep_event"), "separator record delivered");
		assert.equal(harness.records.filter((record) => record.type === "sep_event").length, 1, "exactly one record, not split");
		assert.equal(harness.records.find((record) => record.type === "sep_event")?.text, text);
		assert.ok(readFileSync(harness.logPath, "utf8").includes("\u2028"), "raw separators logged");
		const data = await harness.worker.request({ type: "echo", payload: "still alive" });
		assert.equal(data.payload, "still alive");
	} finally {
		await shutdown(harness);
	}
});

test("out-of-order replies correlate to their own callers", async () => {
	const harness = await startFixture();
	try {
		const order: string[] = [];
		const first = harness.worker
			.request({ type: "slow", ms: 120 })
			.then((data) => {
				order.push("first");
				return data;
			});
		const second = harness.worker
			.request({ type: "slow", ms: 20 })
			.then((data) => {
				order.push("second");
				return data;
			});
		const [firstData, secondData] = await Promise.all([first, second]);
		assert.deepEqual(order, ["second", "first"], "the later call resolved first");
		assert.equal(firstData.waitedMs, 120);
		assert.equal(secondData.waitedMs, 20);
	} finally {
		await shutdown(harness);
	}
});

test("unsuccessful responses reject with the reported error; data-less successes resolve undefined", async () => {
	const harness = await startFixture();
	try {
		await assert.rejects(
			() => harness.worker.request({ type: "fail", error: "model not found: nope" }),
			/model not found: nope/,
		);
		assert.equal(await harness.worker.request({ type: "ok" }), undefined);
	} finally {
		await shutdown(harness);
	}
});

test("timeouts fire; invalid timeout values are rejected without sending", async () => {
	const harness = await startFixture();
	try {
		const started = Date.now();
		await assert.rejects(() => harness.worker.request({ type: "silent" }, 100), /timeout after 100ms/);
		const elapsed = Date.now() - started;
		assert.ok(elapsed >= 90, "timeout honored the requested duration");
		assert.ok(elapsed < 2000, "timeout fired promptly, not at the 15s default");
		const bad: unknown[] = [0, -1, NaN, Infinity, -Infinity, 2_147_483_648, "500"];
		for (const value of bad) {
			await assert.rejects(
				() => harness.worker.request({ type: "echo", payload: "x" }, value as number),
				/timeoutMs must be a positive finite number/,
			);
		}
	} finally {
		await shutdown(harness);
	}
});

test("child exit rejects pending calls, clears timers, and reports the exit once", async () => {
	const harness = await startFixture();
	try {
		// The pending call carries a 15s default timer that must never fire:
		// exit rejects it within milliseconds.
		const pending = harness.worker.request({ type: "silent" });
		const stopper = harness.worker.request({ type: "exit_now", code: 3 });
		const started = Date.now();
		await assert.rejects(() => pending, /worker exited \(code=3 signal=null\)/);
		await assert.rejects(() => stopper, /worker exited/);
		assert.ok(Date.now() - started < 5000, "pending calls rejected by the exit, not by their timers");
		assert.equal(harness.worker.exited, true);
		assert.equal(harness.worker.exitCode, 3);
		assert.equal(harness.worker.signal, null);
		await waitFor(() => harness.exits.length === 1, "onExit fired");
		assert.deepEqual(harness.exits, [{ code: 3, signal: null }], "onExit fired exactly once");
		await assert.rejects(() => harness.worker.request({ type: "echo", payload: "x" }), /worker exited/);
		await assert.rejects(() => harness.worker.writeRecord({ type: "extension_ui_response", id: "u" }), /worker exited/);
	} finally {
		await shutdown(harness);
	}
});

test("external SIGKILL reports a signal exit and rejects pending calls", async () => {
	const harness = await startFixture();
	try {
		const pending = harness.worker.request({ type: "silent" });
		// Let the pending write flush first, so the kill is answered by the exit
		// event (code/signal) rather than by an EPIPE on a write still in flight.
		await sleep(30);
		process.kill(harness.worker.pid, "SIGKILL");
		await assert.rejects(() => pending, /worker exited \(code=null signal=SIGKILL\)/);
		await waitFor(() => harness.exits.length === 1, "onExit fired");
		assert.deepEqual(harness.exits, [{ code: null, signal: "SIGKILL" }]);
		assert.equal(harness.worker.exitCode, null);
		assert.equal(harness.worker.signal, "SIGKILL");
	} finally {
		await shutdown(harness);
	}
});

test("startup failure rejects and leaves no file descriptors behind", async () => {
	const dir = mkdtempSync(join(tmpdir(), "worker-rpc-test-"));
	dirs.push(dir);
	const logPath = join(dir, "events.jsonl");
	const errPath = join(dir, "diagnostics.log");
	await assert.rejects(
		() =>
			WorkerRpc.start({
				executable: join(dir, "does-not-exist"),
				args: [],
				cwd: dir,
				env: {},
				logPath,
				errPath,
			}),
		/spawn failed/,
	);
	if (existsSync(FDS_DIR)) {
		// Node's own failed-spawn internals linger until GC (verified with a
		// bare spawn()), so the deterministic check is what the transport owns:
		// no open descriptor may still reference its two log files.
		const targets = readdirSync(FDS_DIR).map((name) => {
			try {
				return readlinkSync(join(FDS_DIR, name));
			} catch {
				return "";
			}
		});
		assert.ok(!targets.includes(logPath), "stdout log descriptor closed after the failed start");
		assert.ok(!targets.includes(errPath), "stderr log descriptor closed after the failed start");
	}
	assert.ok(existsSync(logPath), "the exclusive log files had been created before the spawn attempt");
});

test("exclusive log creation refuses a second worker on the same paths and closes its descriptors", async () => {
	const harness = await startFixture();
	try {
		const canCountFds = existsSync(FDS_DIR);
		const before = canCountFds ? readdirSync(FDS_DIR).length : -1;
		await assert.rejects(
			() =>
				WorkerRpc.start({
					executable: process.execPath,
					args: [FIXTURE],
					cwd: harness.dir,
					env: {},
					logPath: harness.logPath,
					errPath: harness.errPath,
				}),
			/cannot create stdout log/,
		);
		// Now only the stderr path is taken: the fresh log fd must be closed
		// again by the failure branch (the nested close path).
		await assert.rejects(
			() =>
				WorkerRpc.start({
					executable: process.execPath,
					args: [FIXTURE],
					cwd: harness.dir,
					env: {},
					logPath: join(harness.dir, "second.jsonl"),
					errPath: harness.errPath,
				}),
			/cannot create stderr log/,
		);
		if (canCountFds) {
			assert.equal(readdirSync(FDS_DIR).length, before, "no descriptor leaked from either refused start");
		}
	} finally {
		await shutdown(harness);
	}
});

test("malformed JSON records signal worker_protocol_error and close stdin", async () => {
	const harness = await startFixture();
	try {
		await harness.worker.writeRecord({ type: "garbage", text: '{"type":"response", oops' });
		await waitFor(
			() => harness.records.some((record) => record.type === "worker_protocol_error"),
			"protocol error for invalid JSON",
		);
		assert.match(
			harness.records.find((record) => record.type === "worker_protocol_error")?.error ?? "",
			/invalid JSON record/,
		);
		await waitFor(() => harness.worker.exited, "fixture exit after stdin close");
		assert.equal(harness.worker.exitCode, 0, "the child shut down orderly on stdin EOF");
		await assert.rejects(() => harness.worker.request({ type: "echo", payload: "x" }), SHUT_DOWN);
	} finally {
		await shutdown(harness);
	}
});

test("blank-line records are protocol errors, not silently dropped", async () => {
	const harness = await startFixture();
	try {
		await harness.worker.writeRecord({ type: "blank" });
		await waitFor(
			() => harness.records.some((record) => record.type === "worker_protocol_error"),
			"protocol error for blank line",
		);
		assert.match(harness.records.find((record) => record.type === "worker_protocol_error")?.error ?? "", /blank line/);
		await waitFor(() => harness.worker.exited, "fixture exit after stdin close");
		assert.equal(harness.worker.exitCode, 0);
	} finally {
		await shutdown(harness);
	}
});

test("oversized frames trip the bound, close stdin, and stay bounded in memory", async () => {
	const harness = await startFixture();
	try {
		// 8 MiB + 16 bytes with no LF anywhere: the bound must trip on
		// buffering alone, and the transport must stay alive afterwards.
		await harness.worker.writeRecord({ type: "huge" });
		await waitFor(
			() => harness.records.some((record) => record.type === "worker_protocol_error"),
			"protocol error on oversized frame",
		);
		assert.match(
			harness.records.find((record) => record.type === "worker_protocol_error")?.error ?? "",
			/oversized frame/,
		);
		await waitFor(() => harness.worker.exited, "fixture exit after stdin close");
		assert.equal(harness.worker.exitCode, 0);
	} finally {
		await shutdown(harness);
	}
});

test("a truncated final frame at EOF is logged and reported", async () => {
	const harness = await startFixture();
	try {
		await harness.worker.writeRecord({ type: "trailer" });
		await waitFor(
			() => harness.records.some((record) => record.type === "worker_protocol_error"),
			"mid-frame protocol error",
		);
		assert.match(harness.records.find((record) => record.type === "worker_protocol_error")?.error ?? "", /mid-frame/);
		await waitFor(() => harness.worker.exited, "fixture exit");
		assert.equal(harness.worker.exitCode, 0);
	} finally {
		await shutdown(harness);
	}
});

test("callbacks rebind without duplicate listeners; stdout drains through an unbound gap", async () => {
	const harness = await startFixture();
	try {
		const second: any[] = [];
		const third: any[] = [];
		const afterGap: any[] = [];
		await harness.worker.writeRecord({ type: "emit", record: { type: "tick", n: 1 } });
		await waitFor(() => harness.records.some((record) => record.n === 1), "first record on the original callback");

		// Rebinding is one property write - never a second stream listener.
		harness.worker.onRecord = (record) => second.push(record);
		await harness.worker.writeRecord({ type: "emit", record: { type: "tick", n: 2 } });
		await waitFor(() => second.some((record) => record.n === 2), "record on the rebound callback");
		harness.worker.onRecord = (record) => third.push(record);
		await harness.worker.writeRecord({ type: "emit", record: { type: "tick", n: 3 } });
		await waitFor(() => third.some((record) => record.n === 3), "record on the latest callback");
		assert.equal(harness.records.filter((record) => record.type === "tick").length, 1, "original callback saw nothing new");
		assert.equal(second.length, 1, "no duplicates after repeated rebinding");

		// The reload gap: unbound callback, yet stdout keeps draining, requests
		// keep correlating, and the full record still reaches the log.
		harness.worker.onRecord = undefined;
		const correlated = harness.worker.request({ type: "echo", payload: "gap" });
		await harness.worker.writeRecord({ type: "emit", record: { type: "tick", n: 4 } });
		assert.equal((await correlated).payload, "gap", "requests resolve through the unbound gap");
		// The echo response can outrun the emit event; wait for the log, which
		// writeSync fills synchronously at parse time.
		await waitFor(() => readFileSync(harness.logPath, "utf8").includes('"n":4'), "gap record drained and logged");
		assert.equal(third.length, 1, "records emitted while unbound are dropped, not replayed");

		harness.worker.onRecord = (record) => afterGap.push(record);
		await harness.worker.writeRecord({ type: "emit", record: { type: "tick", n: 5 } });
		await waitFor(() => afterGap.some((record) => record.n === 5), "delivery resumes after rebinding");
	} finally {
		await shutdown(harness);
	}
});

test("onExit rebinds before exit; the old handler is not called", async () => {
	const harness = await startFixture();
	try {
		const mine: Array<{ code: number | null; signal: string | null }> = [];
		harness.worker.onExit = (code, signal) => mine.push({ code, signal });
		harness.worker.closeInput();
		await waitFor(() => harness.worker.exited, "orderly exit");
		assert.deepEqual(mine, [{ code: 0, signal: null }]);
		assert.deepEqual(harness.exits, [], "the original handler is not called after rebinding");
	} finally {
		await shutdown(harness);
	}
});

test("writeRecord delivers records such as extension_ui responses to the child", async () => {
	const harness = await startFixture();
	try {
		await harness.worker.writeRecord({ type: "extension_ui_response", id: "ui-1", value: "Allow" });
		await waitFor(() => harness.records.some((record) => record.type === "bounced"), "fixture bounced the record back");
		const bounced = harness.records.find((record) => record.type === "bounced");
		assert.equal(bounced?.received?.id, "ui-1");
		assert.equal(bounced?.received?.value, "Allow");
	} finally {
		await shutdown(harness);
	}
});

test("closeInput ends stdin; the child exits 0 and later writes are rejected", async () => {
	const harness = await startFixture();
	try {
		harness.worker.closeInput();
		harness.worker.closeInput(); // idempotent
		await assert.rejects(() => harness.worker.request({ type: "echo", payload: "x" }), SHUT_DOWN);
		await assert.rejects(() => harness.worker.writeRecord({ type: "bounce", marker: 1 }), SHUT_DOWN);
		await waitFor(() => harness.worker.exited, "orderly exit after stdin EOF");
		assert.equal(harness.worker.exitCode, 0);
		assert.equal(harness.worker.signal, null);
		assert.deepEqual(harness.exits, [{ code: 0, signal: null }]);
	} finally {
		await shutdown(harness);
	}
});

test("child stderr lands in the private diagnostics file and is never parsed", async () => {
	const harness = await startFixture();
	try {
		await harness.worker.writeRecord({ type: "stderr_noise", text: "STDERR-MARKER-123" });
		await waitFor(() => readFileSync(harness.errPath, "utf8").includes("STDERR-MARKER-123"), "stderr captured");
		assert.equal(
			harness.records.filter((record) => record.type === "worker_protocol_error").length,
			0,
			"stderr was not parsed as protocol",
		);
		assert.ok(
			!readFileSync(harness.logPath, "utf8").includes("STDERR-MARKER-123"),
			"stderr stays out of the stdout event log",
		);
		const data = await harness.worker.request({ type: "echo", payload: "healthy" });
		assert.equal(data.payload, "healthy");
	} finally {
		await shutdown(harness);
	}
});

test("the environment is passed through but never inspected or logged", async () => {
	const harness = await startFixture();
	try {
		const check = await harness.worker.request({ type: "env_check" });
		assert.equal(check.marker, "1", "env reached the child verbatim");
		assert.equal(check.secretSeen, true);
		await harness.worker.writeRecord({ type: "stderr_noise", text: "env-check-noise" });
		await waitFor(() => readFileSync(harness.errPath, "utf8").includes("env-check-noise"), "both logs populated");
		const log = readFileSync(harness.logPath, "utf8");
		const err = readFileSync(harness.errPath, "utf8");
		assert.ok(!log.includes(SECRET), "stdout log free of env values");
		assert.ok(!err.includes(SECRET), "diagnostics log free of env values");
	} finally {
		await shutdown(harness);
	}
});

test("live workers are held in a globalThis registry keyed by pid and released at exit", async () => {
	const harness = await startFixture();
	try {
		assert.equal(WorkerRpc.get(harness.worker.pid), harness.worker, "registry holds the same instance");
		harness.worker.closeInput();
		await waitFor(() => harness.worker.exited, "exit");
		assert.equal(WorkerRpc.get(harness.worker.pid), undefined, "registry entry released at exit");
	} finally {
		await shutdown(harness);
	}
});

test("throwing observers cannot crash the transport or the exit path", async () => {
	const harness = await startFixture({
		onRecord: () => {
			throw new Error("observer boom");
		},
	});
	try {
		// Correlated responses skip the observer entirely and still resolve.
		const data = await harness.worker.request({ type: "echo", payload: "resilient" });
		assert.equal(data.payload, "resilient");
		// Events dispatch to the throwing observer without breaking the stream.
		await harness.worker.writeRecord({ type: "emit", record: { type: "tick", n: 1 } });
		const good: any[] = [];
		harness.worker.onRecord = (record) => good.push(record);
		await harness.worker.writeRecord({ type: "emit", record: { type: "tick", n: 2 } });
		await waitFor(() => good.some((record) => record.n === 2), "delivery continues after an observer threw");
		// A throwing onExit must not break exit finalization or registry cleanup.
		harness.worker.onExit = () => {
			throw new Error("exit observer boom");
		};
		harness.worker.closeInput();
		await waitFor(() => harness.worker.exited, "exit finalized despite throwing onExit");
		assert.equal(WorkerRpc.get(harness.worker.pid), undefined, "registry cleaned up despite throwing onExit");
	} finally {
		await shutdown(harness);
	}
});

after(async () => {
	for (const worker of live.splice(0)) {
		if (!worker.exited) {
			worker.closeInput();
			try {
				await waitFor(() => worker.exited, "sweep exit", 2000);
			} catch {
				try {
					process.kill(worker.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
	}
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});
