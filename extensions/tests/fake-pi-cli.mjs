// Test double for the Pi CLI in subagent tests: it is spawned exactly the way
// spawnSubagent relaunches Pi ([node, entry, --print, --no-session, --model,
// pattern, -e path..., --, task]) and emulates the surface the job machinery
// relies on - stdout is the final response only, stderr is diagnostics, the
// exit status follows, and SIGTERM shuts down gracefully after killing
// detached descendants (what real Pi's print mode does). Behavior is selected
// by the task text so tests stay declarative.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
let model;
const extensions = [];
let task = "";
let sawSeparator = false;
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (!sawSeparator) {
		if (arg === "--") {
			sawSeparator = true;
			continue;
		}
		if (arg === "--model") model = argv[++i];
		else if (arg === "-e" || arg === "--extension") extensions.push(argv[++i]);
		continue;
	}
	task = task === "" ? arg : `${task}\n${arg}`;
}

function facts(record) {
	if (process.env.FAKE_PI_FACTS) {
		appendFileSync(process.env.FAKE_PI_FACTS, `${JSON.stringify(record)}\n`);
	}
}

facts({
	kind: "start",
	argv,
	model,
	extensions,
	task,
	cwd: process.cwd(),
	childMarker: process.env.WRAPPED_PI_CHILD ?? null,
	staleSessionEnv: ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL"].filter(
		(key) => process.env[key] !== undefined,
	),
	extensionsEnv: process.env.WRAPPED_PI_EXTENSIONS ?? null,
});

// SIGTERM must not leave detached descendants behind: kill the sleeper's own
// process group, then exit - the graceful-shutdown shape real Pi print mode
// provides (killTrackedDetachedChildren + dispose before exit).
let descendant;
let descendantKillDelayMs = 0;
process.on("SIGTERM", () => {
	if (descendant?.pid) {
		setTimeout(
			() => {
				try {
					process.kill(-descendant.pid, "SIGKILL");
				} catch {
					// already gone
				}
				process.exit(0);
			},
			descendantKillDelayMs,
		);
	} else {
		process.exit(0);
	}
});

// Exit without losing buffered stream writes (pipes and files flush
// asynchronously; process.exit truncates otherwise).
function finish(code) {
	let pending = 2;
	const done = () => {
		if (--pending === 0) process.exit(code);
	};
	process.stdout.write("", done);
	process.stderr.write("", done);
}

if (task.startsWith("SAY:")) {
	process.stdout.write(task.slice("SAY:".length));
	finish(0);
} else if (task.startsWith("NOISY:")) {
	const rest = task.slice("NOISY:".length);
	const separator = rest.indexOf("|");
	process.stderr.write(rest.slice(separator + 1));
	process.stdout.write(rest.slice(0, separator));
	finish(0);
} else if (task.startsWith("FAIL:")) {
	process.stderr.write(`child failed: ${task.slice("FAIL:".length)}`);
	finish(1);
} else if (task.startsWith("SLOW-SAY:")) {
	const match = /^SLOW-SAY:(\d+(?:\.\d+)?):([\s\S]*)$/.exec(task);
	const seconds = match ? Number(match[1]) : 0;
	const text = match ? match[2] : "";
	setTimeout(() => {
		process.stdout.write(text);
		finish(0);
	}, seconds * 1000);
	// keep the loop alive without busy work
	setInterval(() => {}, 1000);
} else if (task.startsWith("BG-SLEEP-HANG:")) {
	const seconds = Number(task.slice("BG-SLEEP-HANG:".length)) || 30;
	descendant = spawn("sleep", [String(seconds)], { detached: true, stdio: "ignore" });
	descendant.unref();
	facts({ kind: "descendant", pid: descendant.pid });
	// hang like a working agent
	setInterval(() => {}, 1000);
} else if (task.startsWith("BG-TRAP-SLOW-HANG:")) {
	// The c-116 shape: a TERM-immune detached loop, and a child whose shutdown
	// takes about as long as real Pi's (dispose + its own TERM-then-KILL
	// escalation) - long enough that a 2s parent grace kills the child before
	// its cleanup completes.
	const delay = Number(task.slice("BG-TRAP-SLOW-HANG:".length)) || 3000;
	descendant = spawn("sh", ["-c", 'trap "" TERM; while :; do sleep 1; done'], { detached: true, stdio: "ignore" });
	descendant.unref();
	descendantKillDelayMs = delay;
	facts({ kind: "descendant", pid: descendant.pid });
	setInterval(() => {}, 1000);
} else if (task.startsWith("HANG")) {
	setInterval(() => {}, 1000);
} else {
	process.stderr.write(`fake-pi-cli: no protocol matched task: ${task}`);
	finish(2);
}
