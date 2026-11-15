import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

// Standing law: extension-authored strings that can reach the model or the
// terminal are ASCII-only, and production sources are ASCII end to end —
// the simplest greppable rule, no comment-stripping heuristics. Exemptions:
// test fixtures may carry non-ASCII DATA (multibyte passthrough is behavior
// under test: ★, é, 🏝️ in the suites), and passthrough data at runtime
// (command output, provider excerpts, PDF text) is surfaced, never sanitized.
test("production extension sources are ASCII-only", () => {
	const dir = new URL("..", import.meta.url).pathname;
	const offenders: string[] = [];
	function inspect(folder: string, prefix = ""): void {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			const name = prefix + entry.name;
			if (entry.isDirectory()) {
				if (entry.name !== "tests") inspect(join(folder, entry.name), `${name}/`);
				continue;
			}
			if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
			const text = readFileSync(join(folder, entry.name), "utf8");
			for (const [index, line] of text.split("\n").entries()) {
				const match = line.match(/[^\x00-\x7F]/);
				if (match) offenders.push(`${name}:${index + 1}: ${JSON.stringify(match[0])}`);
			}
		}
	}
	inspect(dir);
	assert.deepEqual(offenders, [], "non-ASCII in production sources");
});
