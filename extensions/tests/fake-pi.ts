// Test-side fake of pi's ExtensionAPI plus registry/test helpers.

const REGISTRY_KEY = Symbol.for("bash-background.jobs");

export function fakePi() {
	const tools = new Map();
	const handlers = new Map();
	const sent = [];
	const entries = [];
	const commands = new Map();
	const renderers = new Map();
	const status = [];
	const ui = () => ({
		setStatus: (key, text) => status.push({ key, text }),
		notify: () => {},
		theme: { fg: (_color, text) => text },
	});
	const handle = {
		registerTool: (def) => tools.set(def.name, def),
		on: (event, cb) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(cb);
		},
		sendMessage: (message, options) => {
			sent.push({ message, options });
		},
		appendEntry: (customType, data) => {
			entries.push({ customType, data });
		},
		registerCommand: (name, options) => commands.set(name, options),
		registerEntryRenderer: (customType, renderer) => renderers.set(customType, renderer),
	};
	return {
		handle,
		tools,
		sent,
		entries,
		commands,
		renderers,
		status,
		ui,
		emit: async (event, payload = {}, ctx = undefined) => {
			for (const cb of handlers.get(event) ?? []) await cb(payload, ctx);
		},
		bash: () => tools.get("bash"),
		bashStop: () => tools.get("bash_stop"),
		bashWait: () => tools.get("bash_wait"),
		bgCommand: () => commands.get("bg"),
	};
}

export function testCtx(cwd) {
	return {
		cwd,
		sessionManager: {
			getSessionId: () => "sess-test-1",
			getSessionFile: () => "/tmp/bash-bg-test-session.jsonl",
		},
		model: { provider: "test", id: "test-model" },
		thinkingLevel: "off",
	};
}

export function resetRegistry() {
	const reg = globalThis[REGISTRY_KEY];
	if (reg === undefined) return;
	if (reg.poller !== undefined) clearInterval(reg.poller);
	reg.jobs.clear();
	reg.nextId = 1;
	reg.poller = undefined;
}

export function jobs() {
	const reg = globalThis[REGISTRY_KEY];
	return reg === undefined ? [] : [...reg.jobs.values()];
}

export function groupAlive(pid) {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH" || error.code === "EPERM") return false;
		throw error;
	}
}

export async function waitFor(fn, ms = 10000, step = 50) {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = fn();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, step));
	}
}
