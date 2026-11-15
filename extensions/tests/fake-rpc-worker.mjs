// Test double for `pi --mode rpc`, used only by worker-rpc tests. It speaks
// the same wire contract Pi does: strict LF-only JSONL on stdio (StringDecoder,
// never readline, so U+2028/U+2029 inside strings stay inside records),
// responses echoing the request id, a parse-failure response for malformed
// stdin commands, and an orderly exit 0 on stdin EOF. Deterministic fault
// injection is selected by command type. No real Pi, no network, no
// credentials: the only secret-looking env value exists to prove the parent
// never logs the environment.
import { StringDecoder } from "node:string_decoder";

const decoder = new StringDecoder("utf8");
let buffer = "";
let writesInFlight = 0;
let shuttingDown = false;

function writeLine(text, onFlushed) {
	writesInFlight += 1;
	process.stdout.write(text, () => {
		writesInFlight -= 1;
		if (onFlushed) onFlushed();
		if (shuttingDown && writesInFlight === 0) process.exit(0);
	});
}

function respond(id, command, success, extra = {}) {
	writeLine(`${JSON.stringify({ type: "response", id, command, success, ...extra })}\n`);
}

function parseFailure(line) {
	writeLine(
		`${JSON.stringify({
			type: "response",
			command: "parse",
			success: false,
			error: `Failed to parse command: ${line.slice(0, 80)}`,
		})}\n`,
	);
}

function handleCommand(cmd) {
	switch (cmd.type) {
		case "echo":
			respond(cmd.id, "echo", true, { data: { payload: cmd.payload ?? null, sawId: cmd.id } });
			return;
		case "ok":
			// Success without a data field: the client must resolve undefined.
			respond(cmd.id, "ok", true);
			return;
		case "fail":
			respond(cmd.id, "fail", false, { error: cmd.error ?? "fixture failure" });
			return;
		case "slow":
			setTimeout(() => respond(cmd.id, "slow", true, { data: { waitedMs: cmd.ms ?? 0 } }), cmd.ms ?? 0);
			return;
		case "silent":
			// Never responds: for client timeout and exit-cancellation tests.
			return;
		case "emit":
			writeLine(`${JSON.stringify(cmd.record)}${cmd.crlf ? "\r\n" : "\n"}`);
			return;
		case "emit_split": {
			// Drip the record out in fixed byte chunks so multibyte UTF-8
			// sequences are split mid-character across stream chunks.
			const bytes = Buffer.from(`${JSON.stringify({ type: "split_event", payload: cmd.payload ?? "" })}\n`, "utf8");
			const size = cmd.chunkSize ?? 2;
			const delayMs = cmd.delayMs ?? 2;
			let offset = 0;
			const step = () => {
				if (offset >= bytes.length) return;
				const end = Math.min(offset + size, bytes.length);
				process.stdout.write(bytes.subarray(offset, end), () => setTimeout(step, delayMs));
				offset = end;
			};
			step();
			return;
		}
		case "garbage":
			writeLine(`${cmd.text ?? "definitely not json"}\n`);
			return;
		case "blank":
			writeLine("\n");
			return;
		case "huge": {
			// An oversized frame with no trailing LF: the client's bound must
			// trip on buffering alone. Writes are paced by pipe backpressure and
			// accounted in writesInFlight so a client-side stdin close cannot
			// truncate the stream before the bound has tripped.
			const total = cmd.bytes ?? 8 * 1024 * 1024 + 16;
			const block = Buffer.alloc(64 * 1024, 0x78);
			let left = total;
			writesInFlight += 1;
			const done = () => {
				writesInFlight -= 1;
				if (shuttingDown && writesInFlight === 0) process.exit(0);
			};
			const writeMore = () => {
				while (left > 0) {
					const take = Math.min(left, block.length);
					left -= take;
					const chunkToWrite = block.subarray(0, take);
					if (left === 0) {
						process.stdout.write(chunkToWrite, done);
						return;
					}
					if (!process.stdout.write(chunkToWrite)) {
						process.stdout.once("drain", writeMore);
						return;
					}
				}
			};
			writeMore();
			return;
		}
		case "trailer":
			// A final frame with no LF before exit: the client must report the
			// truncated frame instead of dropping it.
			writeLine('{"type":"mid_frame_event"');
			setTimeout(() => process.exit(0), 20);
			return;
		case "stderr_noise":
			process.stderr.write(`${cmd.text ?? "fixture diagnostic"}\n`);
			return;
		case "env_check":
			// Proves env passthrough without emitting any value: marker is the
			// benign flag, secretSeen only whether the key existed.
			respond(cmd.id, "env_check", true, {
				data: { marker: process.env.WORKER_FIXTURE ?? null, secretSeen: process.env.WORKER_TEST_SECRET ? true : false },
			});
			return;
		case "exit_now":
			process.exit(cmd.code ?? 0);
			return; // not reached
		case "bounce":
		case "extension_ui_response":
			// Echo fire-and-forget records back as events, so tests can assert
			// exactly what reached the child's stdin.
			writeLine(`${JSON.stringify({ type: "bounced", received: cmd })}\n`);
			return;
		default:
			respond(cmd.id ?? null, String(cmd.type ?? "unknown"), false, { error: "unknown fixture command" });
	}
}

function handleLine(line) {
	let cmd;
	try {
		cmd = JSON.parse(line);
	} catch {
		parseFailure(line);
		return;
	}
	if (cmd === null || typeof cmd !== "object" || Array.isArray(cmd)) {
		parseFailure(line);
		return;
	}
	handleCommand(cmd);
}

process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	let newline;
	while ((newline = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	}
});

// Orderly shutdown on stdin EOF, the same contract Pi's RPC mode honors:
// finish in-flight stdout writes, then exit 0.
process.stdin.on("end", () => {
	buffer += decoder.end();
	if (buffer.trim() !== "") handleLine(buffer.trim());
	shuttingDown = true;
	if (writesInFlight === 0) process.exit(0);
});
