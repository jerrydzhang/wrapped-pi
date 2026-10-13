// Independently authored for pinned Pi 0.87.0; only the default factory is pi-facing.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 20;
const EXCERPT_CHARS = 240;
const DEFAULT_FETCH_CHARS = 20_000;
const MAX_FETCH_CHARS = 200_000;
const PROVIDER_TIMEOUT_MS = 30_000;
const RAW_TEXT_CAP = 20_000;
// Public bounded-tool contract at this pin (extensions.md): DEFAULT_MAX_BYTES
// 50KB, DEFAULT_MAX_LINES 2000, whichever hit first — honored via pi's own
// truncateHead when running inside pi; the local fallback exists only for
// bare-node test runs.
const OUTPUT_BYTE_CAP = 50 * 1024;
const OUTPUT_LINE_CAP = 2_000;

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const ZAI_SEARCH_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const ZAI_READER_URL = "https://api.z.ai/api/mcp/web_reader/mcp";

export interface SearchParams {
	query: string;
	numResults?: number;
}

export interface FetchParams {
	url: string;
	maxChars?: number;
}

export interface WebSearchDeps {
	fetchImpl?: typeof fetch;
	env?: Record<string, string | undefined>;
	tmpDir?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ToolOutcome {
	text: string;
	details: Record<string, unknown>;
}

interface ParsedResult {
	title: string;
	url: string;
	publishedDate?: string;
	excerpt?: string;
}

class AbortedError extends Error {
	constructor() {
		super("Cancelled");
		this.name = "AbortedError";
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AbortedError();
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
 const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Keep credential bytes out of any text we surface; never prints.
function scrub(text: string, secrets: (string | undefined)[]): string {
	let out = text;
	for (const s of secrets) {
		if (s && out.includes(s)) out = out.split(s).join("[redacted]");
	}
	return out;
}

/** UTF-8-safe: the cut falls between code points, never inside one. */
function validUtf8Cut(buf: Buffer): Buffer {
	for (let drop = 0; drop < 4 && drop <= buf.length; drop++) {
		const candidate = drop === 0 ? buf : buf.subarray(0, buf.length - drop);
		if (Buffer.from(candidate.toString("utf8"), "utf8").equals(candidate)) return candidate;
	}
	return Buffer.alloc(0);
}

// Bare-node stand-in for pi's truncateHead: identical keep-first semantics,
// byte cut at a valid code point boundary.
function localTruncateHead(text: string, maxLines: number, maxBytes: number): { content: string } {
	let content = text;
	if (content.split("\n").length > maxLines) content = content.split("\n").slice(0, maxLines).join("\n");
	const buf = Buffer.from(content, "utf8");
	if (buf.length > maxBytes) content = validUtf8Cut(buf.subarray(0, maxBytes)).toString("utf8");
	return { content };
}

async function loadPiTruncation(): Promise<any | null> {
	try {
		return await import("@earendil-works/pi-coding-agent");
	} catch {
		return null;
	}
}

// Scrub before truncate: truncation could otherwise cut a secret so only its tail survives.
function sanitizeDetail(text: string, secrets: (string | undefined)[]): string {
	return truncate(scrub(text, secrets), 300).text;
}

function exceedsOutputBounds(text: string): boolean {
	return Buffer.byteLength(text, "utf8") > OUTPUT_BYTE_CAP || text.split("\n").length > OUTPUT_LINE_CAP;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
	return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

async function exaMcpCall(
	tool: string,
	args: Record<string, unknown>,
	deps: WebSearchDeps,
): Promise<Record<string, any>> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const signal = boundedSignal(deps.signal, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
	const url = `${EXA_MCP_URL}?tools=${tool}`;
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
		signal,
	});
	const raw = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${raw}`);
	}
	// The endpoint answers either plain JSON or SSE; both carry one JSON body.
	const data = extractJsonRpcPayload(raw);
	if (!data) throw new Error("unparseable MCP response (no JSON-RPC body)");
	if (data.error) throw new Error(`MCP error: ${JSON.stringify(data.error)}`);
	const result = data.result;
	if (!result || typeof result !== "object") throw new Error("MCP response missing result");
	if (result.isError === true) {
		const text = mcpTextBlocks(result).join(" ").trim();
		throw new Error(text || "MCP tool reported an error");
	}
	return result;
}

/** Pull the JSON-RPC object out of a raw JSON or SSE response body. */
function extractJsonRpcPayload(raw: string): Record<string, any> | null {
	const trimmed = raw.trim();
	if (trimmed.startsWith("{")) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return null;
		}
	}
	// Request ids vary per call (1 = initialize, 2 = tools/call), so id equality is not a usable filter.
	let found: Record<string, any> | null = null;
	for (const line of trimmed.split("\n")) {
		const m = line.match(/^data:\s*(\{.*\})\s*$/);
		if (!m) continue;
		try {
			const parsed = JSON.parse(m[1]);
			if (parsed.jsonrpc === "2.0" && (parsed.result !== undefined || parsed.error !== undefined)) found = parsed;
		} catch {
			}
	}
	return found;
}

function mcpTextBlocks(result: Record<string, any>): string[] {
	const content = result.content;
	if (!Array.isArray(content)) return [];
	return content
		.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text as string);
}

// Sections without both title and URL are never promoted to sources.
export function parseExaTextSections(text: string): ParsedResult[] | null {
	const sections = text
		.replace(/\r\n?/g, "\n")
		.split(/\n{2,}(?=Title:)/)
		.map((s) => s.trim())
		.filter((s) => s.startsWith("Title:"));
	const results: ParsedResult[] = [];
	for (const section of sections) {
		const field = (name: string): string | undefined => {
			const m = section.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
			return m ? m[1].trim() : undefined;
		};
		const title = field("Title");
		const url = field("URL");
		if (!title || !url) continue;
		const body = section.split(/^Text:\s*/m)[1];
		results.push({
			title,
			url,
			publishedDate: field("Published Date"),
			excerpt: body ? body.trim() : undefined,
		});
	}
	return results.length > 0 ? results : null;
}

interface ExaOutcome {
	kind: "structured" | "raw";
	results?: ParsedResult[];
	rawText?: string;
}

function normalizeExaSearch(result: Record<string, any>): ExaOutcome {
	const structured = result.structuredContent;
	if (structured && Array.isArray(structured.results)) {
		const results: ParsedResult[] = [];
		for (const r of structured.results) {
			if (r && typeof r.url === "string" && r.url) {
				results.push({
					title: typeof r.title === "string" && r.title ? r.title : r.url,
					url: r.url,
					publishedDate: typeof r.publishedDate === "string" ? r.publishedDate : undefined,
					excerpt:
						typeof r.summary === "string"
							? r.summary
							: typeof r.text === "string"
								? r.text
								: Array.isArray(r.highlights)
									? r.highlights.join(" ")
									: undefined,
				});
			}
		}
		if (results.length > 0) return { kind: "structured", results };
	}
	const text = mcpTextBlocks(result).join("\n\n");
	const parsed = parseExaTextSections(text);
	if (parsed) return { kind: "structured", results: parsed };
	if (text.trim()) return { kind: "raw", rawText: text };
	throw new Error("Exa returned no parsable results or text");
}

async function exaSearch(params: SearchParams, deps: WebSearchDeps): Promise<ExaOutcome> {
	const numResults = clampInt(params.numResults, 1, MAX_NUM_RESULTS, DEFAULT_NUM_RESULTS);
	// The Exa schema requires `objective`; the supplied query is the deterministic adaptation — no second model authors it.
	const result = await exaMcpCall("web_search_exa", { query: params.query, objective: params.query, numResults }, deps);
	return normalizeExaSearch(result);
}

async function exaFetch(url: string, deps: WebSearchDeps): Promise<string> {
	const result = await exaMcpCall(
		"web_fetch_exa",
		{ urls: [url], maxCharacters: MAX_FETCH_CHARS },
		deps,
	);
	const text = mcpTextBlocks(result).join("\n\n").trim();
	if (!text) throw new Error("Exa fetch returned no content");
	return text;
}

async function zaiSession(url: string, key: string, deps: WebSearchDeps, attemptSignal: AbortSignal): Promise<string> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "saccade-websearch", version: "0.1.0" },
			},
		}),
		signal: attemptSignal,
	});
	if (!response.ok) throw new Error(`initialize HTTP ${response.status}`);
	const sessionId = response.headers.get("mcp-session-id");
	if (!sessionId) throw new Error("no mcp-session-id on initialize response");
	// The notification is skippable protocol-politeness, but a cancellation inside it must not be swallowed into a follow-up call.
	try {
		await fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				Authorization: `Bearer ${key}`,
				"mcp-session-id": sessionId,
			},
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
			signal: attemptSignal,
		});
	} catch (err) {
		if ((err as any)?.name === "AbortError" || (err as any)?.name === "TimeoutError" || deps.signal?.aborted) throw err;
	}
	return sessionId;
}

async function zaiToolCall(
	baseUrl: string,
	toolName: string,
	args: Record<string, unknown>,
	key: string,
	sessionId: string,
	deps: WebSearchDeps,
	attemptSignal: AbortSignal,
): Promise<Record<string, any>> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const response = await fetchImpl(baseUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${key}`,
			"mcp-session-id": sessionId,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: toolName, arguments: args },
		}),
		signal: attemptSignal,
	});
	const raw = await response.text();
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw}`);
	const data = extractJsonRpcPayload(raw);
	if (!data) throw new Error("unparseable MCP response (no JSON-RPC body)");
	if (data.error) throw new Error(`MCP error: ${JSON.stringify(data.error)}`);
	const result = data.result;
	if (!result || typeof result !== "object") throw new Error("MCP response missing result");
	if (result.isError === true) {
		const text = mcpTextBlocks(result).join(" ").trim();
		throw new Error(text || "MCP tool reported an error");
	}
	return result;
}

// Retry needs positive invalid-argument evidence; rate limits and auth faults must fail the provider, never repeat under a new shape.
const SHAPE_ERROR_RE =
	/invalid (argument|parameter|param)|unknown (argument|parameter|field|tool)|unrecognized|unexpected (field|argument|property)|schema validation/i;

function isShapeError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	const parsed = msg.match(/MCP error: (\{.*\})/);
	if (parsed) {
		try {
			const code = JSON.parse(parsed[1])?.code;
			return code === -32602 || code === -32601;
		} catch {
			return false;
		}
	}
	return SHAPE_ERROR_RE.test(msg);
}

async function zaiSearch(
	query: string,
	numResults: number | undefined,
	key: string,
	deps: WebSearchDeps,
): Promise<ExaOutcome> {
	// One composed signal spans the whole attempt — per-call timeouts would multiply the promised budget.
	const attemptSignal = boundedSignal(deps.signal, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
	const sessionId = await zaiSession(ZAI_SEARCH_URL, key, deps, attemptSignal);
	// The verified schema shape is primary; only positively identified argument-shape failure advances.
	const shapes: Record<string, unknown>[] = [
		{ search_query: query, location: "us", content_size: "high" },
		{ search_query: query },
	];
	let lastError: unknown;
	for (const args of shapes) {
		try {
			const result = await zaiToolCall(ZAI_SEARCH_URL, "web_search_prime", args, key, sessionId, deps, attemptSignal);
			const text = mcpTextBlocks(result).join("\n\n").trim();
			if (!text) throw new Error("ZAI search returned no content");
			return parseZaiSearchPayload(text);
		} catch (err) {
			lastError = err;
			if (!isShapeError(err)) throw err;
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ZAI answers are a JSON array (often JSON-encoded in the text block) of {title, link, content}; kept verbatim, domain-level links included.
export function parseZaiSearchPayload(text: string): ExaOutcome {
	try {
		let value: any = JSON.parse(text);
		if (typeof value === "string") value = JSON.parse(value);
		if (Array.isArray(value)) {
			const results: ParsedResult[] = [];
			for (const item of value) {
				if (item && typeof item === "object" && typeof item.title === "string" && typeof item.link === "string") {
					results.push({
						title: item.title,
						url: item.link,
						excerpt: typeof item.content === "string" ? item.content : undefined,
					});
				}
			}
			if (results.length > 0) return { kind: "structured", results };
		}
	} catch {
	}
	return { kind: "raw", rawText: text };
}

async function zaiFetch(url: string, key: string, deps: WebSearchDeps): Promise<string> {
	const attemptSignal = boundedSignal(deps.signal, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
	const sessionId = await zaiSession(ZAI_READER_URL, key, deps, attemptSignal);
	const result = await zaiToolCall(
		ZAI_READER_URL,
		"webReader",
		{ url, return_format: "markdown" },
		key,
		sessionId,
		deps,
		attemptSignal,
	);
	const text = mcpTextBlocks(result).join("\n\n").trim();
	if (!text) throw new Error("ZAI reader returned no content");
	return unwrapZaiReaderPayload(text);
}

// The reader wraps the page in a JSON string even in markdown mode.
function unwrapZaiReaderPayload(text: string): string {
	try {
		let value: any = JSON.parse(text);
		if (typeof value === "string") value = JSON.parse(value);
		if (value && typeof value === "object" && typeof value.content === "string" && value.content.trim()) {
			return value.content;
		}
	} catch {
		// not JSON — return as-is
	}
	return text;
}

function secretsOf(env: Record<string, string | undefined>): string[] {
	return [env.ZAI_API_KEY];
}

async function runWithFallback(
	deps: WebSearchDeps,
	runExa: () => Promise<ToolOutcome>,
	runZai: () => Promise<ToolOutcome>,
	toolName: string,
): Promise<ToolOutcome> {
	const env = deps.env ?? process.env;
	const secrets = secretsOf(env);
	const attempts: string[] = [];
	try {
		return await runExa();
	} catch (err) {
		throwIfAborted(deps.signal);
		attempts.push(`exa-mcp: ${sanitizeDetail(err instanceof Error ? err.message : String(err), secrets)}`);
	}
	const key = env.ZAI_API_KEY;
	if (!key) {
		throw new Error(`${toolName} failed — ${attempts.join("; ")}; zai: unavailable (ZAI_API_KEY not set)`);
	}
	try {
		return await runZai();
	} catch (err) {
		// Cancellation arriving during fallback is not a provider failure — it must surface as cancellation, never trigger the next provider.
		throwIfAborted(deps.signal);
		attempts.push(`zai: ${sanitizeDetail(err instanceof Error ? err.message : String(err), secrets)}`);
	}
	throw new Error(`${toolName} failed — ${attempts.join("; ")}`);
}

export async function runWebSearch(params: SearchParams, deps: WebSearchDeps = {}): Promise<ToolOutcome> {
	throwIfAborted(deps.signal);
	const numResults = clampInt(params.numResults, 1, MAX_NUM_RESULTS, DEFAULT_NUM_RESULTS);
	const outcome = await runWithFallback(
		deps,
		async () => formatSearchOutcome("exa-mcp", await exaSearch(params, deps), numResults),
		async () => {
			const key = (deps.env ?? process.env).ZAI_API_KEY!;
			const outcome = await zaiSearch(params.query, numResults, key, deps);
			return formatSearchOutcome("zai", outcome, numResults);
		},
		"web_search",
	);
	return boundToolOutcome(outcome, deps);
}

function formatSearchOutcome(provider: string, outcome: ExaOutcome, numResults: number): ToolOutcome {
	if (outcome.kind === "structured") {
		const results = outcome.results!.slice(0, numResults);
		const lines: string[] = [`${results.length} result${results.length === 1 ? "" : "s"} via ${provider}`, ""];
		if (provider === "zai") lines.push(`(zai links are domain-level, exactly as the provider returns them)`, "");
		results.forEach((r, i) => {
			const date = r.publishedDate ? ` (${r.publishedDate})` : "";
			lines.push(`[${i + 1}] ${r.title}${date}`);
			lines.push(`    ${r.url}`);
			if (r.excerpt) {
				const excerpt = truncate(r.excerpt.replace(/\s+/g, " ").trim(), EXCERPT_CHARS);
				lines.push(`    ${excerpt.text}${excerpt.truncated ? "…" : ""}`);
			}
			lines.push("");
		});
		return {
			text: lines.join("\n").trimEnd(),
			details: { provider, resultCount: results.length, truncatedTo: numResults },
		};
	}
	const capped = truncate(outcome.rawText!, RAW_TEXT_CAP);
	return {
		text:
			`results via ${provider} (raw provider content; source structure not confidently parseable — URLs appear inline)\n\n` +
			capped.text +
			(capped.truncated ? `\n\n[truncated at ${RAW_TEXT_CAP} characters]` : ""),
		details: { provider, kind: "raw" },
	};
}

export async function runWebFetch(params: FetchParams, deps: WebSearchDeps = {}): Promise<ToolOutcome> {
	throwIfAborted(deps.signal);
	if (!params.url || !/^https?:\/\//i.test(params.url)) {
		throw new Error("web_fetch requires an http(s) URL");
	}
	const maxChars = clampInt(params.maxChars, 1, MAX_FETCH_CHARS, DEFAULT_FETCH_CHARS);
	const outcome = await runWithFallback(
		deps,
		async (): Promise<ToolOutcome> => {
			const content = await exaFetch(params.url, deps);
			return formatFetchOutcome(params.url, "exa-mcp", content, maxChars, deps);
		},
		async (): Promise<ToolOutcome> => {
			const key = (deps.env ?? process.env).ZAI_API_KEY!;
			const content = await zaiFetch(params.url, key, deps);
			return formatFetchOutcome(params.url, "zai", content, maxChars, deps);
		},
		"web_fetch",
	);
	return boundToolOutcome(outcome, deps);
}

async function formatFetchOutcome(
	url: string,
	provider: string,
	content: string,
	maxChars: number,
	deps: WebSearchDeps,
): Promise<ToolOutcome> {
	const header = `Content from ${url} via ${provider}\n\n`;
	const capped = truncate(content, maxChars);
	if (!capped.truncated) {
		return { text: header + content, details: { provider, url, chars: content.length } };
	}
	// Content at MAX_FETCH_CHARS may be provider-truncated — never claim it is the complete page.
	const extractionCapped = content.length >= MAX_FETCH_CHARS;
	const path = await persistOutputFile(url, content, deps);
	return {
		text:
			header +
			`Showing first ${maxChars} of ${content.length} characters. ` +
			(extractionCapped
				? `Provider extraction hit the ${MAX_FETCH_CHARS}-character cap; saved output may be incomplete:\n${path}\n`
				: `Full content saved to:\n${path}\n`) +
			`(read it with the read tool using offset/limit)\n\n---\n\n` +
			capped.text,
		details: { provider, url, chars: content.length, inlineChars: maxChars, fullPath: path, extractionCapped },
	};
}

// One immutable file per invocation: a later fetch must never rewrite content an earlier result points at.
async function persistOutputFile(url: string, content: string, deps: WebSearchDeps): Promise<string> {
	const { mkdir, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createHash, randomBytes } = await import("node:crypto");
	const dir = deps.tmpDir ?? join(tmpdir(), "saccade-websearch");
	await mkdir(dir, { recursive: true });
	let host = "page";
	try {
		host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "_") || "page";
	} catch {
	}
	const hash = createHash("sha1").update(url).digest("hex").slice(0, 10);
	const nonce = randomBytes(4).toString("hex");
	const path = join(dir, `${host}-${hash}-${nonce}.md`);
	await writeFile(path, content, "utf-8");
	return path;
}

// Final aggregate bound for every tool surface: even caller-legal maxChars or
// many small results can exceed what a tool result should carry inline. The
// footer is part of the final text, so the cut reserves room for it.
async function boundToolOutcome(outcome: ToolOutcome, deps: WebSearchDeps): Promise<ToolOutcome> {
	if (!exceedsOutputBounds(outcome.text)) return outcome;
	const path = await persistOutputFile("output", outcome.text, deps);
	const footer = `\n\n[Output truncated. Full output: ${path}]`;
	const pi = await loadPiTruncation();
	const maxBytes = (pi?.DEFAULT_MAX_BYTES ?? OUTPUT_BYTE_CAP) as number;
	const maxLines = (pi?.DEFAULT_MAX_LINES ?? OUTPUT_LINE_CAP) as number;
	const truncation = pi
		? pi.truncateHead(outcome.text, { maxBytes: maxBytes - Buffer.byteLength(footer, "utf8"), maxLines: maxLines - 2 })
		: localTruncateHead(outcome.text, maxLines - 2, maxBytes - Buffer.byteLength(footer, "utf8"));
	return {
		text: truncation.content + footer,
		details: { ...outcome.details, outputTruncated: true, fullPath: path },
	};
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const { Type } = await import("typebox");
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			`Search the web and return source titles, URLs and excerpts with provider attribution. ` +
			`Providers: keyless Exa MCP first, ZAI fallback when ZAI_API_KEY is set. ` +
			`numResults: results per query (default ${DEFAULT_NUM_RESULTS}, max ${MAX_NUM_RESULTS}). ` +
			`Excerpts are capped at ${EXCERPT_CHARS} characters; pass recency/site operators inside the query text itself ` +
			`(forwarded verbatim, backend filtering not guaranteed). One bounded attempt per provider, ${PROVIDER_TIMEOUT_MS / 1000}s timeout each.`,
		promptSnippet:
			"Use for current web information; returns sourced titles/URLs/excerpts, not full pages — follow up with web_fetch on promising URLs.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query; recency/site operators may be included verbatim." }),
			numResults: Type.Optional(
				Type.Number({ description: `Results per query (default ${DEFAULT_NUM_RESULTS}, max ${MAX_NUM_RESULTS}).` }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				const outcome = await runWebSearch(
					{ query: params.query, numResults: params.numResults },
					{ signal },
				);
				return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
			} catch (err) {
				if (err instanceof AbortedError || (err as any)?.name === "AbortError") {
					return { content: [{ type: "text" as const, text: "Cancelled" }], details: { cancelled: true } };
				}
				throw err;
			}
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			`Fetch a URL and return its readable content (markdown where the provider supplies it) with the source URL stated. ` +
			`Providers: keyless Exa MCP first, ZAI reader fallback when ZAI_API_KEY is set. ` +
			`maxChars: inline character bound (default ${DEFAULT_FETCH_CHARS}, max ${MAX_FETCH_CHARS}); larger content is ` +
			`written to a temporary file whose path is returned for ordinary reads. Extraction is capped at ${MAX_FETCH_CHARS} characters. ` +
			`JavaScript-heavy pages may fail — the error says which provider and why.`,
		promptSnippet:
			"Use to read a specific page found via web_search; oversized content lands in a temp file you can read with offset/limit.",
		parameters: Type.Object({
			url: Type.String({ description: "The http(s) URL to fetch." }),
			maxChars: Type.Optional(
				Type.Number({
					description: `Inline character bound (default ${DEFAULT_FETCH_CHARS}, max ${MAX_FETCH_CHARS}); larger content goes to a temp file.`,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			try {
				const outcome = await runWebFetch({ url: params.url, maxChars: params.maxChars }, { signal });
				return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
			} catch (err) {
				if (err instanceof AbortedError || (err as any)?.name === "AbortError") {
					return { content: [{ type: "text" as const, text: "Cancelled" }], details: { cancelled: true } };
				}
				throw err;
			}
		},
	});
}
