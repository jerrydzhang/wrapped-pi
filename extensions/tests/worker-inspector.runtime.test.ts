// Actual pinned TUI utilities with a deterministic host, no terminal, model,
// credentials, or network. Live rendering is separately checked through hc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { openWorkerInspector } from "../lib/worker-inspector.ts";

const modules = process.env.PI_TEST_MODULES;
if (modules) register(new URL("./real-tui-hooks.mjs", import.meta.url), { data: { modules } });
const tui = modules ? await import(pathToFileURL(join(modules, "@earendil-works/pi-tui/dist/index.js")).href) : undefined;
const next = () => new Promise((resolve) => setImmediate(resolve));
const options = { skip: !tui, timeout: 10000 };

async function host(initialId = undefined) {
	let component;
	let finish;
	let tick;
	let cleared = 0;
	let renders = 0;
	let rows = [{ id: "sa-1", kind: "subagent", state: "idle", task: "worker", model: "test/model", startedAt: Date.now(), transcript: "wide 中文\n".repeat(60), logPath: "/tmp/events" }];
	const sent = [];
	const stopped = [];
	const notices = [];
	let editor = async () => "hello";
	const timer = { unref() {} };
	const originalSet = globalThis.setInterval;
	const originalClear = globalThis.clearInterval;
	globalThis.setInterval = (fn, ms, ...args) => {
		if (ms !== 1000) return originalSet(fn, ms, ...args);
		tick = fn; return timer;
	};
	globalThis.clearInterval = (handle) => {
		if (handle === timer) cleared++;
		else originalClear(handle);
	};
	const keys = { "tui.select.up": "up", "tui.select.down": "down", "tui.select.pageUp": "pageUp", "tui.select.pageDown": "pageDown", "tui.select.confirm": "enter", "tui.select.cancel": "escape" };
	const theme = { fg: (_name, text) => text, style: (text) => text };
	const ctx = { mode: "tui", ui: {
		notify: (...args) => notices.push(args),
		editor: (...args) => editor(...args),
		confirm: async () => true,
		custom: (factory) => new Promise((resolve) => {
			finish = resolve;
			component = factory({ terminal: { rows: 30 }, requestRender: () => renders++ }, theme,
				{ matches: (data, id) => data === keys[id], getKeys: (id) => [keys[id]] },
				() => { component?.dispose(); resolve(); });
		}),
	} };
	const opened = openWorkerInspector(ctx, {
		initialId, rows: () => rows,
		send: async (id, text) => { sent.push({ id, text }); },
		stop: async (id) => { stopped.push(id); },
	});
	for (let i = 0; !component && i < 50; i++) await next();
	assert.ok(component, JSON.stringify(notices));
	return {
		component, sent, stopped, notices, opened,
		setRows: (value) => { rows = value; },
		setEditor: (fn) => { editor = fn; },
		tick: () => tick(), renders: () => renders,
		cleared: () => cleared,
		async close() {
			component.dispose(); finish(); await opened;
			globalThis.setInterval = originalSet;
			globalThis.clearInterval = originalClear;
		},
	};
}

test("real TUI: inspector renders narrow/wide text, refreshes, composes, stops, and closes", options, async () => {
	const h = await host();
	try {
		h.component.handleInput("enter");
		for (const width of [1, 3, 20, 80]) {
			const lines = h.component.render(width);
			assert.ok(lines.every((line) => tui.visibleWidth(line) <= width), `all lines fit width ${width}`);
		}
		const before = h.renders();
		h.tick();
		assert.ok(h.renders() > before, "refresh tick requests an actual redraw");
		h.component.handleInput("m"); await next();
		assert.deepEqual(h.sent, [{ id: "sa-1", text: "hello" }]);
		h.component.handleInput("x"); await next();
		assert.deepEqual(h.stopped, ["sa-1"]);
		h.setRows([{ id: "sa-1", kind: "subagent", state: "stopped", task: "worker", startedAt: 1, endedAt: 2, transcript: "closed", logPath: "/tmp/events" }]);
		h.tick();
		assert.doesNotMatch(h.component.render(80).join("\n"), /m message|x stop/);
		h.component.handleInput("m"); h.component.handleInput("x"); await next();
		assert.equal(h.sent.length, 1, "closed conversations cannot be messaged");
		assert.equal(h.stopped.length, 1, "closed conversations cannot be stopped twice");
		h.component.handleInput("q"); await h.opened;
		assert.ok(h.cleared() >= 1, "closing clears the refresh timer");
	} finally { await h.close(); }
});

test("real TUI: disposal during composition prevents stale sends and clears the timer", options, async () => {
	const h = await host("sa-1");
	try {
		let answer;
		h.setEditor(() => new Promise((resolve) => { answer = resolve; }));
		h.component.handleInput("m");
		assert.ok(answer);
		h.component.dispose();
		answer("must not send after reload"); await next();
		assert.equal(h.sent.length, 0);
		assert.ok(h.cleared() >= 1);
		assert.deepEqual(h.component.render(80), []);
	} finally { await h.close(); }
});
