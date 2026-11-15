// Real pinned Pi agent loop + this extension's wait definition. No provider,
// credentials, or session files: deterministic fake model responses only.
// Run with the bash-only stub loader to load the extension; the actual agent
// loop and schema validation are imported by absolute path, never stubbed.
// PI_TEST_MODULES points to <pi>/lib/pi/node_modules (set by the Nix check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import bashBackground from "../bash-background.ts";
import { fakePi, resetRegistry, testCtx, jobs, waitFor } from "./fake-pi.ts";

const modules = process.env.PI_TEST_MODULES;
const runtime = modules
	? await import(pathToFileURL(join(modules, "@earendil-works/pi-agent-core/dist/index.js")).href)
	: undefined;
const ai = modules
	? await import(pathToFileURL(join(modules, "@earendil-works/pi-ai/dist/compat.js")).href)
	: undefined;

function response(content, stopReason = "stop") {
	return {
		role: "assistant", content, api: "openai-responses", provider: "openai", model: "mock",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason, timestamp: Date.now(),
	};
}

function setup(extraTools = []) {
	resetRegistry();
	const app = fakePi();
	bashBackground(app.handle);
	let calls = 0;
	const contexts = [];
	const agent = new runtime.Agent({
		initialState: { tools: [app.wait(), ...extraTools] },
		streamFn: (_model, context) => {
			contexts.push(structuredClone(context.messages));
			const index = calls++;
			const stream = ai.createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = index === 0
					? response([
						{ type: "toolCall", id: "yield-1", name: "wait", arguments: {} },
						...extraTools.map((tool) => ({ type: "toolCall", id: `${tool.name}-1`, name: tool.name, arguments: {} })),
					], "toolUse")
					: response([{ type: "text", text: "received" }]);
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		},
	});
	return { app, agent, contexts, calls: () => calls };
}

const options = { skip: !runtime, timeout: 15000 };

test("real agent: wait yields with zero jobs and no automatic extra model call", options, async () => {
	const { agent, calls } = setup();
	await agent.prompt("Yield now");
	assert.equal(calls(), 1);
	assert.equal(agent.state.isStreaming, false);
	assert.equal(agent.state.messages.at(-1).toolName, "wait");
	await agent.prompt("Human can speak immediately");
	assert.equal(calls(), 2);
	assert.equal(agent.state.messages.at(-1).content[0].text, "received");
});

test("real agent: steering queued at the wait boundary is not stranded", options, async () => {
	const { agent, contexts, calls } = setup();
	agent.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "wait") {
			agent.steer({ role: "user", content: "human steering at boundary", timestamp: Date.now() });
		}
	});
	await agent.prompt("Yield");
	assert.equal(calls(), 2);
	assert.ok(contexts[1].some((message) => message.content === "human steering at boundary"));
	assert.equal(agent.state.isStreaming, false);
});

test("real agent: explicit follow-ups retain end-of-run scheduling through wait", options, async () => {
	const { agent, contexts, calls } = setup();
	agent.subscribe((event) => {
		if (event.type === "tool_execution_start" && event.toolName === "wait") {
			agent.followUp({ role: "user", content: "explicit follow-up", timestamp: Date.now() });
		}
	});
	await agent.prompt("Yield");
	assert.equal(calls(), 2);
	assert.ok(contexts[1].some((message) => message.content === "explicit follow-up"));
});

test("real agent: a completion queued while yielding is consumed exactly once", options, async () => {
	const { app, agent, contexts, calls } = setup();
	app.handle.sendMessage = (message) => {
		app.sent.push({ message });
		agent.steer({ role: "user", content: message.content, timestamp: Date.now() });
	};
	await app.bash().execute("start", { command: "printf boundary-completion", background: true }, undefined, undefined, testCtx("/tmp"));
	// Construct the normally sub-tick settled/undelivered boundary deterministically.
	const job = jobs()[0];
	job.state = "exited";
	job.exitCode = 0;
	job.endedAt = Date.now();
	try {
		await agent.prompt("Yield");
		assert.equal(calls(), 2);
		assert.equal(app.sent.length, 1);
		assert.ok(contexts[1].some((message) => typeof message.content === "string" && message.content.includes("Background command bg-1")));
	} finally {
		await app.emit("session_shutdown", { reason: "quit" });
	}
});

test("real agent: wait leaves jobs alive; a later completion can wake the idle parent", options, async () => {
	const { app, agent, contexts, calls } = setup();
	const keep = setInterval(() => {}, 100);
	let wake;
	app.handle.sendMessage = (message) => {
		app.sent.push({ message });
		wake = agent.prompt(message.content);
	};
	try {
		await app.bash().execute("start", { command: "sleep 0.2; printf idle-completion", background: true }, undefined, undefined, testCtx("/tmp"));
		await agent.prompt("Yield");
		assert.equal(calls(), 1);
		assert.equal(jobs()[0].state, "running");
		await waitFor(() => wake !== undefined);
		await wake;
		assert.equal(calls(), 2);
		assert.equal(app.sent.length, 1);
		assert.match(JSON.stringify(contexts[1]), /idle-completion/);
	} finally {
		clearInterval(keep);
		await app.emit("session_shutdown", { reason: "quit" });
	}
});

test("real agent: mixing wait with another tool does not terminate that tool's continuation", options, async () => {
	let otherRan = false;
	const { agent, calls } = setup([{
		name: "other", label: "other", description: "A normal tool",
		parameters: { type: "object", properties: {} },
		async execute() { otherRan = true; return { content: [{ type: "text", text: "done" }], details: {} }; },
	}]);
	await agent.prompt("Mixed batch");
	assert.equal(otherRan, true);
	assert.equal(calls(), 2);
});
