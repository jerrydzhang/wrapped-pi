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
	for (const entry of readdirSync(dir)) {
		// Top-level *.test.ts (websearch) is suite code with data fixtures, not production.
		if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
		const text = readFileSync(join(dir, entry), "utf8");
		for (const [index, line] of text.split("\n").entries()) {
			const match = line.match(/[^\x00-\x7F]/);
			if (match) offenders.push(`${entry}:${index + 1}: ${JSON.stringify(match[0])}`);
		}
	}
	assert.deepEqual(offenders, [], "non-ASCII in production sources");
});
