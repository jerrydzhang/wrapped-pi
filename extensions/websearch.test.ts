// Runs with: node --test extensions/websearch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	runWebSearch,
	runWebFetch,
	parseExaTextSections,
	parseZaiSearchPayload,
} from "./websearch.ts";

const EXA_SEARCH_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const EXA_FETCH_URL = "https://mcp.exa.ai/mcp?tools=web_fetch_exa";
const ZAI_SEARCH_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const ZAI_READER_URL = "https://api.z.ai/api/mcp/web_reader/mcp";

function jsonRpc(result: unknown): string {
	return JSON.stringify({ jsonrpc: "2.0", id: 1, result });
}

function sse(result: unknown): string {
	return `id:1\nevent:message\ndata:${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n`;
}

function exaSection(title: string, url: string, body: string, date?: string): string {
	return `Title: ${title}\nURL: ${url}\n${date ? `Published Date: ${date}\n` : ""}Text: ${body}`;
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function depsFrom(route: Route, env: Record<string, string | undefined> = {}, opts: { tmpDir?: string; signal?: AbortSignal } = {}) {
	return {
		fetchImpl: ((url: string | URL | globalThis.Request, init?: RequestInit) =>
			Promise.resolve(route(String(url), init ?? {}))) as typeof fetch,
		env: { ...env },
		tmpDir: opts.tmpDir,
		signal: opts.signal,
	} as any;
}

test("exa text sections parse into titled, dated, excerpted sources with exact URL bytes", async () => {
	const payload = jsonRpc({
		content: [
			{ type: "text", text: exaSection("Saccade Tracker", "https://example.com/saccade", "detail ".repeat(80), "2026-01-05") },
			{ type: "text", text: exaSection("Event Sourcing Notes", "https://example.org/events", "Short one.") },
		],
	});
	const out = await runWebSearch(
		{ query: "saccade tracker", numResults: 5 },
		depsFrom((url) => {
			assert.equal(url, EXA_SEARCH_URL);
			return new Response(payload, { status: 200 });
		}),
	);
	assert.match(out.text, /^2 results via exa-mcp/);
	assert.match(out.text, /\[1\] Saccade Tracker \(2026-01-05\)/);
	assert.match(out.text, /    https:\/\/example\.com\/saccade\n/);
	assert.match(out.text, /…$/m);
	assert.match(out.text, /\[2\] Event Sourcing Notes/);
	assert.match(out.text, /    https:\/\/example\.org\/events/);
	assert.equal(out.details.provider, "exa-mcp");
});

test("the exa search call carries the user query as both query and objective plus clamped numResults", async () => {
	let body: any;
	await runWebSearch(
		{ query: "rust event sourcing", numResults: 99 },
		depsFrom((_url, init) => {
			body = JSON.parse(init.body as string);
			return new Response(
				jsonRpc({ content: [{ type: "text", text: exaSection("T", "https://t.example", "b") }] }),
				{ status: 200 },
			);
		}),
	);
	assert.equal(body.params.name, "web_search_exa");
	assert.equal(body.params.arguments.query, "rust event sourcing");
	assert.equal(body.params.arguments.objective, "rust event sourcing");
	assert.equal(body.params.arguments.numResults, 20);
});

test("structuredContent results are preferred and shaped when the server sends them", async () => {
	const out = await runWebSearch(
		{ query: "q" },
		depsFrom(() =>
			new Response(
				jsonRpc({
					structuredContent: {
						results: [
							{ title: "Structured Hit", url: "https://s.example/one", summary: "a summary" },
							{ url: "https://s.example/two" },
						],
					},
				}),
				{ status: 200 },
			),
		),
	);
	assert.match(out.text, /2 results via exa-mcp/);
	assert.match(out.text, /\[1\] Structured Hit/);
	assert.match(out.text, /\[2\] https:\/\/s\.example\/two/);
});

test("an exa payload with neither structured results nor parsable sections surfaces as identified raw content", async () => {
	const out = await runWebSearch(
		{ query: "q" },
		depsFrom(() =>
			new Response(jsonRpc({ content: [{ type: "text", text: "just prose, no sections" }] }), { status: 200 }),
		),
	);
	assert.match(out.text, /^results via exa-mcp \(raw provider content/);
	assert.match(out.text, /just prose/);
});

test("an sse-framed exa response parses the same as plain json", async () => {
	const out = await runWebSearch(
		{ query: "q" },
		depsFrom(() =>
			new Response(
				sse({ content: [{ type: "text", text: exaSection("SSE Page", "https://sse.example/page", "body") }] }),
				{ status: 200 },
			),
		),
	);
	assert.match(out.text, /1 result via exa-mcp/);
	assert.match(out.text, /\[1\] SSE Page/);
});

test("exa http failure falls back to zai when its key is present and attribution follows the provider", async () => {
	const zaiCalls: string[] = [];
	const out = await runWebSearch(
		{ query: "q" },
		depsFrom(
			(url) => {
				if (url === EXA_SEARCH_URL) return new Response("boom", { status: 500 });
				zaiCalls.push(url);
				if (zaiCalls.length === 1) return new Response("", { status: 200, headers: { "mcp-session-id": "s1" } });
				if (zaiCalls.length === 2) return new Response("", { status: 202 });
				return new Response(jsonRpc({ content: [{ type: "text", text: "zai raw result text" }] }), { status: 200 });
			},
			{ ZAI_API_KEY: "test-key-1234567890" },
		),
	);
	assert.equal(zaiCalls.length, 3);
	assert.match(out.text, /^results via zai \(raw provider content/);
	assert.match(out.text, /zai raw result text/);
});

test("zai argument-shape failure advances to the minimal shape instead of failing the provider", async () => {
	const bodies: any[] = [];
	await runWebSearch(
		{ query: "q" },
		depsFrom(
			(url, init) => {
				if (url === EXA_SEARCH_URL) return new Response("down", { status: 503 });
				bodies.push(JSON.parse(init.body as string));
				if (bodies.length === 1) return new Response("", { status: 200, headers: { "mcp-session-id": "s1" } });
				if (bodies.length === 2) return new Response("", { status: 202 });
				if (bodies.length === 3)
					return new Response(
						jsonRpc({ isError: true, content: [{ type: "text", text: "invalid arguments: unknown field location" }] }),
						{ status: 200 },
					);
				return new Response(jsonRpc({ content: [{ type: "text", text: "second shape worked" }] }), { status: 200 });
			},
			{ ZAI_API_KEY: "test-key-1234567890" },
		),
	);
	assert.equal(bodies.length, 4);
	assert.deepEqual(bodies[2].params.arguments, { search_query: "q", location: "us", content_size: "high" });
	assert.deepEqual(bodies[3].params.arguments, { search_query: "q" });
});

test("exa failure with no zai key reports the exa cause and the unavailable fallback honestly", async () => {
	await assert.rejects(
		runWebSearch(
			{ query: "q" },
			depsFrom(() => new Response("quota gone", { status: 429 })),
		),
		(err: Error) => /web_search failed — exa-mcp: HTTP 429.*zai: unavailable \(ZAI_API_KEY not set\)/.test(err.message),
	);
});

test("total failure names every provider attempt with sanitized causes", async () => {
	let zaiPhase = 0;
	await assert.rejects(
		runWebSearch(
			{ query: "q" },
			depsFrom(
				(url) => {
					if (url === EXA_SEARCH_URL) return new Response("exa broke", { status: 500 });
					zaiPhase += 1;
					if (zaiPhase === 1) return new Response("", { status: 200, headers: { "mcp-session-id": "s1" } });
					if (zaiPhase === 2) return new Response("", { status: 202 });
					return new Response("zai broke", { status: 502 });
				},
				{ ZAI_API_KEY: "test-key-1234567890" },
			),
		),
		(err: Error) =>
			/web_search failed — exa-mcp: HTTP 500: exa broke; zai: HTTP 502: zai broke/.test(err.message) &&
			!err.message.includes("test-key"),
	);
});

test("a credential leaking through provider error text is redacted before surfacing", async () => {
	await assert.rejects(
		runWebSearch(
			{ query: "q" },
			depsFrom(
				(url) => {
					if (url === EXA_SEARCH_URL) return new Response("bad key test-key-1234567890 rejected", { status: 401 });
					return new Response("nope", { status: 500 });
				},
				{ ZAI_API_KEY: "test-key-1234567890" },
			),
		),
		(err: Error) => !err.message.includes("test-key-1234567890") && err.message.includes("[redacted]"),
	);
});

test("caller cancellation during the exa attempt aborts without contacting zai", async () => {
	const controller = new AbortController();
	const calls: string[] = [];
	await assert.rejects(
		runWebSearch(
			{ query: "q" },
			depsFrom(
				async (url) => {
					calls.push(url);
					if (url === EXA_SEARCH_URL) {
						controller.abort();
						throw new DOMException("This operation was aborted", "AbortError");
					}
					return new Response(
						jsonRpc({ content: [{ type: "text", text: exaSection("T", "https://t.example", "b") }] }),
						{ status: 200 },
					);
				},
				{ ZAI_API_KEY: "test-key-1234567890" },
				{ signal: controller.signal },
			),
		),
		(err: any) => err.name === "AbortedError",
	);
	assert.deepEqual(calls, [EXA_SEARCH_URL]);
});

test("an abort arriving before the first attempt cancels without any network contact", async () => {
	const controller = new AbortController();
	controller.abort();
	let contacted = false;
	await assert.rejects(
		runWebSearch(
			{ query: "q" },
			depsFrom(
				() => {
					contacted = true;
					return new Response("{}", { status: 200 });
				},
				{ ZAI_API_KEY: "test-key-1234567890" },
				{ signal: controller.signal },
			),
		),
		(err: any) => err.name === "AbortedError",
	);
	assert.equal(contacted, false);
});

test("numResults defaults to five and slices structured results", async () => {
	let body: any;
	const content = Array.from({ length: 8 }, (_, i) => ({
		type: "text",
		text: exaSection(`R${i}`, `https://e.example/${i}`, `body ${i}`),
	}));
	const payload = jsonRpc({ content });
	const out = await runWebSearch(
		{ query: "q" },
		depsFrom((_url, init) => {
			body = JSON.parse(init.body as string);
			return new Response(payload, { status: 200 });
		}),
	);
	assert.equal(body.params.arguments.numResults, 5);
	assert.match(out.text, /^5 results via exa-mcp/);
});

test("web_fetch returns small content inline with the source URL stated", async () => {
	const out = await runWebFetch(
		{ url: "https://small.example/page" },
		depsFrom((url) => {
			assert.equal(url, EXA_FETCH_URL);
			return new Response(jsonRpc({ content: [{ type: "text", text: "# Page\n\nshort body" }] }), { status: 200 });
		}),
	);
	assert.match(out.text, /^Content from https:\/\/small\.example\/page via exa-mcp\n\n# Page/);
	assert.equal(out.details.chars, "# Page\n\nshort body".length);
	assert.equal(out.details.fullPath, undefined);
});

test("oversized fetch content lands in a temp file with a bounded inline preview and a read pointer", async () => {
	const dir = await mkdtemp(join(tmpdir(), "websearch-test-"));
	try {
		const big = "x".repeat(50_000);
		const out = await runWebFetch(
			{ url: "https://big.example/page" },
			depsFrom(() => new Response(jsonRpc({ content: [{ type: "text", text: big }] }), { status: 200 }), {}, { tmpDir: dir }),
		);
		assert.match(out.text, /Showing first 20000 of 50000 characters\. Full content saved to:\n/);
		const path = out.details.fullPath as string;
		assert.match(path, /big.example-[0-9a-f]{10}-[0-9a-f]{8}\.md$/);
		const stored = await readFile(path, "utf-8");
		assert.equal(stored.length, 50_000);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("web_fetch falls back to the zai reader when exa reports a tool error", async () => {
	let zaiPhase = 0;
	const out = await runWebFetch(
		{ url: "https://fallback.example/page" },
		depsFrom(
			(url) => {
				if (url === EXA_FETCH_URL)
					return new Response(jsonRpc({ isError: true, content: [{ type: "text", text: "blocked" }] }), { status: 200 });
				zaiPhase += 1;
				if (zaiPhase === 1) return new Response("", { status: 200, headers: { "mcp-session-id": "s1" } });
				if (zaiPhase === 2) return new Response("", { status: 202 });
				return new Response(jsonRpc({ content: [{ type: "text", text: "# Reader\n\nzai body" }] }), { status: 200 });
			},
			{ ZAI_API_KEY: "test-key-1234567890" },
		),
	);
	assert.match(out.text, /^Content from https:\/\/fallback\.example\/page via zai\n\n# Reader/);
});

test("web_fetch rejects non-http URLs before any network contact", async () => {
	let contacted = false;
	await assert.rejects(
		runWebFetch(
			{ url: "file:///etc/passwd" },
			depsFrom(() => {
				contacted = true;
				return new Response("{}", { status: 200 });
			}),
		),
		(err: Error) => /requires an http\(s\) URL/.test(err.message),
	);
	assert.equal(contacted, false);
});

test("a second fetch of the same URL writes a new file and never rewrites the earlier pointer's content", async () => {
	const dir = await mkdtemp(join(tmpdir(), "websearch-test-"));
	try {
		const paths: string[] = [];
		for (const body of ["first content A", "second content B"]) {
			const out = await runWebFetch(
				{ url: "https://repeat.example/page", maxChars: 5 },
				depsFrom(
					() => new Response(jsonRpc({ content: [{ type: "text", text: body }] }), { status: 200 }),
					{},
					{ tmpDir: dir },
				),
			);
			paths.push(out.details.fullPath as string);
		}
		assert.notEqual(paths[0], paths[1]);
		assert.equal(await readFile(paths[0], "utf-8"), "first content A");
		assert.equal(await readFile(paths[1], "utf-8"), "second content B");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a caller-legal maxChars cannot push multibyte output past the aggregate bound — it spills with a safe cut", async () => {
	const dir = await mkdtemp(join(tmpdir(), "websearch-test-"));
	try {
		const out = await runWebFetch(
			{ url: "https://emoji.example/page", maxChars: 200_000 },
			depsFrom(
				() => new Response(jsonRpc({ content: [{ type: "text", text: "🏝️".repeat(60_000) }] }), { status: 200 }),
				{},
				{ tmpDir: dir },
			),
		);
		assert.ok(Buffer.byteLength(out.text, "utf8") <= 50 * 1024);
		assert.match(out.text, /\[Output truncated\. Full output: /);
		assert.equal(out.details.outputTruncated, true);
		assert.ok(!out.text.includes("\uFFFD"), "byte cut must not introduce replacement characters");
		assert.doesNotMatch(out.text, /[\uD800-\uDBFF]$/);
		const spilled = await readFile(out.details.fullPath as string, "utf-8");
		assert.ok(Buffer.byteLength(spilled, "utf8") >= 420_000, "spill must hold the full fetched content");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a many-line fetched page returns at most 2000 lines and spills the complete original", async () => {
	const dir = await mkdtemp(join(tmpdir(), "websearch-test-"));
	try {
		const manyLines = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
		const out = await runWebFetch(
			{ url: "https://lines.example/page", maxChars: 200_000 },
			depsFrom(
				() => new Response(jsonRpc({ content: [{ type: "text", text: manyLines }] }), { status: 200 }),
				{},
				{ tmpDir: dir },
			),
		);
		assert.ok(out.text.split("\n").length <= 2000, "final text must respect the line cap");
		assert.ok(Buffer.byteLength(out.text, "utf8") <= 50 * 1024, "final text must respect the byte cap");
		assert.match(out.text, /\[Output truncated\. Full output: /);
		const spilled = (await readFile(out.details.fullPath as string, "utf-8")).split("\n").length;
		assert.ok(spilled >= 3000, "spilled output must hold every original line");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("raw search output also respects the final line and byte caps after its own raw-text cap", async () => {
	const dir = await mkdtemp(join(tmpdir(), "websearch-test-"));
	try {
		const manyLines = Array.from({ length: 3000 }, (_, i) => `line ${i} with some padding text`).join("\n");
		const out = await runWebSearch(
			{ query: "q" },
			depsFrom(
				() => new Response(jsonRpc({ content: [{ type: "text", text: manyLines }] }), { status: 200 }),
				{},
				{ tmpDir: dir },
			),
		);
		assert.ok(out.text.split("\n").length <= 2000, "final text must respect the line cap");
		assert.ok(Buffer.byteLength(out.text, "utf8") <= 50 * 1024, "final text must respect the byte cap");
		assert.ok(out.details.outputTruncated === true || out.details.kind === "raw");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a credential cut by truncation leaves no key fragment in surfaced error text", async () => {
	const pad = "x".repeat(290);
	const fakeKey = "FAKE-SECRET-KEY-0123456789";
	await assert.rejects(
		runWebSearch(
			{ query: "q" },
			depsFrom(
				(url) => {
					if (url === EXA_SEARCH_URL) return new Response(pad + fakeKey + " tail", { status: 500 });
					return new Response("nope", { status: 500 });
				},
				{ ZAI_API_KEY: fakeKey },
			),
		),
		(err: Error) => !err.message.includes(fakeKey) && !err.message.includes("FAKE-SECRE"),
	);
});

test("even very short key values are scrubbed from surfaced error text", async () => {
	await assert.rejects(
		runWebSearch(
			{ query: "q" },
			depsFrom(
				(url) => {
					if (url === EXA_SEARCH_URL) return new Response("bad key kqz rejected", { status: 401 });
					return new Response("nope", { status: 500 });
				},
				{ ZAI_API_KEY: "kqz" },
			),
		),
		(err: Error) => !err.message.includes("kqz") && err.message.includes("[redacted]"),
	);
});

test("one composed deadline signal spans every request of a provider attempt", async () => {
	const signals: AbortSignal[] = [];
	let zaiPhase = 0;
	await runWebSearch(
		{ query: "q" },
		depsFrom(
			(url, init) => {
				if (url === EXA_SEARCH_URL) return new Response("down", { status: 503 });
				signals.push(init.signal as AbortSignal);
				zaiPhase += 1;
				if (zaiPhase === 1) return new Response("", { status: 200, headers: { "mcp-session-id": "s1" } });
				if (zaiPhase === 2) return new Response("", { status: 202 });
				if (zaiPhase === 3)
					return new Response(
						jsonRpc({ isError: true, content: [{ type: "text", text: "invalid arguments: unknown field location" }] }),
						{ status: 200 },
					);
				return new Response(
					jsonRpc({
						content: [{ type: "text", text: JSON.stringify([{ title: "T", link: "https://t.example", content: "c" }]) }],
					}),
					{ status: 200 },
				);
			},
			{ ZAI_API_KEY: "test-key-1234567890" },
		),
	);
	assert.equal(signals.length, 4);
	assert.ok(signals.every((s) => s === signals[0]));
});

test("a cancellation inside the zai notification propagates instead of being swallowed", async () => {
	const controller = new AbortController();
	const calls: string[] = [];
	await assert.rejects(
		runWebSearch(
			{ query: "q" },
			depsFrom(
				(url, init) => {
					calls.push(String(url).split("?")[0]);
					if (url === EXA_SEARCH_URL) return new Response("down", { status: 503 });
					const body = JSON.parse(init.body as string);
					if (body.method === "notifications/initialized") {
						controller.abort();
						return Promise.reject(new DOMException("aborted", "AbortError"));
					}
					if (body.method === "initialize") return new Response("", { status: 200, headers: { "mcp-session-id": "s1" } });
					return new Response("{}", { status: 200 });
				},
				{ ZAI_API_KEY: "test-key-1234567890" },
				{ signal: controller.signal },
			),
		),
		(err: any) => err.name === "AbortedError",
	);
	assert.equal(calls.length, 3);
});

test("a rate-limit tool error fails the provider without retrying under the second shape", async () => {
	const bodies: any[] = [];
	await assert.rejects(
		runWebSearch(
			{ query: "q" },
			depsFrom(
				(url, init) => {
					if (url === EXA_SEARCH_URL) return new Response("down", { status: 503 });
					bodies.push(JSON.parse(init.body as string));
					if (bodies.length === 1) return new Response("", { status: 200, headers: { "mcp-session-id": "s1" } });
					if (bodies.length === 2) return new Response("", { status: 202 });
					return new Response(jsonRpc({ isError: true, content: [{ type: "text", text: "rate limited, slow down" }] }), {
						status: 200,
					});
				},
				{ ZAI_API_KEY: "test-key-1234567890" },
			),
		),
		(err: Error) => /rate limited/.test(err.message),
	);
	assert.equal(bodies.length, 3);
});

test("exa section parsing refuses sections missing a URL rather than inventing sources", () => {
	const parsed = parseExaTextSections(
		"Title: Only A Title\nText: no url here\n\nTitle: Good\nURL: https://ok\nText: fine",
	);
	assert.equal(parsed!.length, 1);
	assert.equal(parsed![0].url, "https://ok");
	assert.equal(parseExaTextSections("no sections at all"), null);
});

test("zai json-in-string search payloads parse into structured results with domain-level links kept verbatim", () => {
	const encoded = JSON.stringify(
		JSON.stringify([
			{ title: "Zai Hit", link: "https://dev.to", content: "some content", refer: "ref_1" },
			{ title: "Second", link: "https://github.com", content: "more" },
		]),
	);
	const outcome = parseZaiSearchPayload(encoded);
	assert.equal(outcome.kind, "structured");
	assert.equal(outcome.results![0].title, "Zai Hit");
	assert.equal(outcome.results![0].url, "https://dev.to");
	assert.equal(outcome.results![1].excerpt, "more");
});

test("zai search payloads that do not round-trip as an array stay raw", () => {
	const outcome = parseZaiSearchPayload("plain prose answer");
	assert.equal(outcome.kind, "raw");
	assert.equal(outcome.rawText, "plain prose answer");
});
