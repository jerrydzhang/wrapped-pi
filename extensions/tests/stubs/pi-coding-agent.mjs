// Stub of the pi extension SDK surface the extension imports. The fake
// built-in bash records what the extension forwards to it, so delegation is
// pinned without reimplementing pi.

import { homedir } from "node:os";
import { join } from "node:path";

const state = {
	builtinExecute: async () => ({ content: [{ type: "text", text: "builtin ok" }], details: undefined }),
	calls: [],
	definitions: [],
};

export function setBuiltinExecute(fn) {
	state.builtinExecute = fn;
}

export function resetBuiltin() {
	state.builtinExecute = async () => ({ content: [{ type: "text", text: "builtin ok" }], details: undefined });
	state.calls = [];
	state.definitions = [];
}

export function builtinCalls() {
	return state.calls;
}

export function createBashToolDefinition(cwd) {
	const definition = {
		name: "bash",
		label: "bash",
		description: "Execute a bash command in the current working directory. Returns stdout and stderr.",
		promptSnippet: "Execute bash commands (ls, grep, find, etc)",
		promptGuidelines: ["builtin guideline kept by the spread"],
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to execute" },
				timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)", optional: true },
			},
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			state.calls.push({ toolCallId, params, signal, onUpdate, ctx, cwd });
			return state.builtinExecute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
	state.definitions.push(definition);
	return definition;
}

export function getShellConfig() {
	return { shell: "/bin/sh", args: ["-c"] };
}

// Mirrors pi 1.2.0's getAgentDir faithfully (verified against the pinned
// runtime's dist/config.js): PI_CODING_AGENT_DIR with a leading tilde
// expanded, else ~/.pi/agent.
export function getAgentDir() {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		return envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
	}
	return join(homedir(), ".pi", "agent");
}
