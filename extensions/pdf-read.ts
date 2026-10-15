// Independently authored for pinned Pi 1.2.0; only the default factory is pi-facing.
//
// Extends the read tool with local PDF support: text extraction via pdftotext,
// full-page PNG renders via pdftoppm, page metadata via pdfinfo - all from
// poppler-utils. Non-PDF reads delegate unchanged to the SDK's built-in read
// definition (dynamic import; the release wrapper pins the poppler path via
// WRAPPED_PI_POPPLER_BIN, development falls back to PATH).
import { execFile } from "node:child_process";
import { open, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SNIFF_BYTES = 1024;
const PDF_MAGIC = "%PDF-";

// Bounds (c-61: bound image count/output size, subprocess runtime and text output).
export const MAX_IMAGE_PAGES = 8;
export const DEFAULT_DPI = 130;
const DPI_BACKOFF = [DEFAULT_DPI, 100, 80];
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const PDFINFO_TIMEOUT_MS = 10_000;
const PDFTOTEXT_TIMEOUT_MS = 60_000;
const PDFTOPPM_TIMEOUT_MS = 120_000;
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;
// A page whose extraction yields fewer non-whitespace chars than this is "very thin".
export const THIN_TEXT_CHARS_PER_PAGE = 32;

// Pi's bounded-tool contract at this pin; the local fallback mirrors it for
// bare-node test runs (same arrangement as websearch.ts).
const OUTPUT_MAX_LINES = 2_000;
const OUTPUT_MAX_BYTES = 50 * 1024;

export interface PdfReadParams {
	path: string;
	offset?: number;
	limit?: number;
	pages?: string;
	mode?: "text" | "image";
}

export interface ContentBlock {
	type: "text" | "image";
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface ReadOutcome {
	content: ContentBlock[];
	details: Record<string, unknown>;
	structuredContent: unknown;
}

export interface PopplerRun {
	stdout: string;
	stderr: string;
}

export interface PopplerExecOptions {
	timeoutMs: number;
	signal?: AbortSignal;
	cwd?: string;
}

// program is the resolved executable path; args never pass through a shell.
export type PopplerExec = (
	program: string,
	args: string[],
	options: PopplerExecOptions,
) => Promise<PopplerRun>;

export type BuiltinReadExecute = (
	toolCallId: string,
	params: { path: string; offset?: number; limit?: number },
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: unknown,
) => Promise<{ content: ContentBlock[]; details: unknown; structuredContent?: unknown }>;

export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy?: "lines" | "bytes";
	outputLines: number;
	totalLines: number;
	firstLineExceedsLimit?: boolean;
	maxBytes?: number;
	maxLines?: number;
}

export type TruncateFn = (text: string, options?: { maxBytes?: number; maxLines?: number }) => TruncationResult;

export interface PdfReadDeps {
	exec?: PopplerExec;
	env?: Record<string, string | undefined>;
	tmpRoot?: string;
	// Injected builtin read execute (tests); when absent, the SDK's
	// createReadToolDefinition is loaded dynamically.
	builtinRead?: BuiltinReadExecute | null;
	truncate?: TruncateFn;
	signal?: AbortSignal;
	// Extension tool context, passed through to the builtin read.
	ctx?: { cwd?: string; model?: { input?: string[] } } | undefined;
}

export class PdfReadError extends Error {}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

// ---------------------------------------------------------------------------
// Path resolution and PDF detection
// ---------------------------------------------------------------------------

// Light resolution mirrors the builtin's essential behavior (@-prefix strip,
// ~ expansion, relative-to-cwd); anything it cannot read simply delegates.
export function resolveLocalPath(path: string, ctx?: { cwd?: string }): string {
	let expanded = path.trim();
	if (expanded.startsWith("@")) expanded = expanded.slice(1);
	if (expanded.startsWith("~")) expanded = homedir() + expanded.slice(1);
	return resolvePath(ctx?.cwd ?? process.cwd(), expanded);
}

// True only when the file BEGINS with the %PDF- magic. The match is anchored
// at offset 0 on purpose: a substring search would misroute ordinary files
// that merely mention "%PDF-" near the top (source, docs). Malformed PDFs
// with junk before the header are rare; delegating those to the builtin read
// is the honest fallback.
export async function isPdfFile(absolutePath: string): Promise<boolean> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(absolutePath, "r");
		const info = await handle.stat();
		if (!info.isFile()) return false;
		// Bounded sniff: read exactly the first KiB via the handle - never the
		// whole file (a 128MiB input must not allocate 128MiB to classify).
		const header = Buffer.alloc(SNIFF_BYTES);
		const { bytesRead } = await handle.read(header, 0, SNIFF_BYTES, 0);
		return (
			bytesRead >= PDF_MAGIC.length &&
			header.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC
		);
	} catch {
		return false;
	} finally {
		await handle?.close().catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Page selection
// ---------------------------------------------------------------------------

/** Parse "3", "2-5", "1,4-6" into contiguous [start, end] runs in user order. */
export function parsePageSelection(spec: string): Array<[number, number]> {
	const trimmed = spec.trim();
	if (!trimmed) throw new PdfReadError('pages must look like "3", "2-5" or "1,4-6"');
	const runs: Array<[number, number]> = [];
	for (const part of trimmed.split(",")) {
		const piece = part.trim();
		const range = piece.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
		if (!range) {
			throw new PdfReadError(`invalid page selection "${piece}" - use 1-indexed physical pages like "3", "2-5" or "1,4-6"`);
		}
		const start = Number(range[1]);
		const end = range[2] !== undefined ? Number(range[2]) : start;
		if (start < 1) throw new PdfReadError(`pages are 1-indexed - "${piece}" is not a valid selection`);
		if (end < start) throw new PdfReadError(`invalid range "${piece}" - start must not exceed end`);
		runs.push([start, end]);
	}
	return runs;
}

export function describeRuns(runs: Array<[number, number]>): string {
	return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",");
}

// ---------------------------------------------------------------------------
// Poppler execution
// ---------------------------------------------------------------------------

export function resolvePopplerTool(tool: string, env?: Record<string, string | undefined>): string {
	const binDir = (env ?? process.env).WRAPPED_PI_POPPLER_BIN;
	// Release: absolute store path exported by the wrapper - host PATH is never consulted.
	// Development: bare name resolved from PATH.
	return binDir ? join(binDir, tool) : tool;
}

export function defaultPopplerExec(
	program: string,
	args: string[],
	options: PopplerExecOptions,
): Promise<PopplerRun> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			program,
			args,
			{ timeout: options.timeoutMs, maxBuffer: EXEC_MAX_BUFFER, windowsHide: true },
			(err, stdout, stderr) => {
				if (err) {
					(err as Error & { stderr?: string }).stderr = typeof stderr === "string" ? stderr : stderr.toString();
					reject(err);
				} else {
					resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
				}
			},
		);
		const onAbort = () => child.kill("SIGKILL");
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const settle = (fn: () => void) => {
			options.signal?.removeEventListener("abort", onAbort);
			fn();
		};
		// The callback above already settled the promise; keep listener hygiene.
		child.on("close", () => settle(() => {}));
	});
}

function stderrTail(err: unknown, limit = 300): string {
	const source = err instanceof Error ? `${err.message}\n${(err as Error & { stderr?: string }).stderr ?? ""}` : String(err);
	const tail = source.trim().split("\n").slice(-6).join(" | ");
	return tail.length > limit ? tail.slice(0, limit) + "..." : tail;
}

function mapPopplerError(err: unknown, tool: string, program: string): PdfReadError {
	const code = (err as NodeJS.ErrnoException)?.code;
	if (code === "ENOENT") {
		return new PdfReadError(
			`${tool} not found (looked for "${program}"). The wrapped-pi release build ships poppler-utils in its closure; ` +
				`in development installs it must be on PATH or named by WRAPPED_PI_POPPLER_BIN.`,
		);
	}
	const text = `${(err as Error)?.message ?? ""} ${(err as Error & { stderr?: string })?.stderr ?? ""}`;
	if (/incorrect password|encrypted/i.test(text)) {
		return new PdfReadError("PDF is encrypted - read tool cannot open it. Provide a decrypted copy.");
	}
	if (/may not be a pdf file|couldn't open file|not a pdf|couldn't read xref|couldn't find trailer/i.test(text)) {
		return new PdfReadError(`not a valid PDF, or the file is corrupt (poppler: ${stderrTail(err)})`);
	}
	return new PdfReadError(`${tool} failed: ${stderrTail(err)}`);
}

async function runPoppler(
	tool: string,
	args: string[],
	options: PopplerExecOptions,
	deps: PdfReadDeps,
): Promise<PopplerRun> {
	const exec = deps.exec ?? defaultPopplerExec;
	const program = resolvePopplerTool(tool, deps.env);
	throwIfAborted(deps.signal);
	try {
		return await exec(program, args, options);
	} catch (err) {
		throwIfAborted(deps.signal);
		throw mapPopplerError(err, tool, program);
	}
}

// ---------------------------------------------------------------------------
// Truncation (pi's truncateHead when available; local fallback otherwise)
// ---------------------------------------------------------------------------

function validUtf8Cut(buf: Buffer): Buffer {
	for (let drop = 0; drop < 4 && drop <= buf.length; drop++) {
		const candidate = drop === 0 ? buf : buf.subarray(0, buf.length - drop);
		if (Buffer.from(candidate.toString("utf8"), "utf8").equals(candidate)) return candidate;
	}
	return Buffer.alloc(0);
}

export function localTruncateHead(text: string, options?: { maxBytes?: number; maxLines?: number }): TruncationResult {
	const maxLines = options?.maxLines ?? OUTPUT_MAX_LINES;
	const maxBytes = options?.maxBytes ?? OUTPUT_MAX_BYTES;
	const lines = text.split("\n");
	const totalLines = lines.length;
	let content = text;
	let truncated = false;
	let truncatedBy: "lines" | "bytes" | undefined;
	if (totalLines > maxLines) {
		content = lines.slice(0, maxLines).join("\n");
		truncated = true;
		truncatedBy = "lines";
	}
	const buf = Buffer.from(content, "utf8");
	if (buf.length > maxBytes) {
		content = validUtf8Cut(buf.subarray(0, maxBytes)).toString("utf8");
		truncated = true;
		truncatedBy = "bytes";
	}
	return {
		content,
		truncated,
		truncatedBy,
		outputLines: truncated ? content.split("\n").length : totalLines,
		totalLines,
		firstLineExceedsLimit: false,
		maxBytes,
		maxLines,
	};
}

let piTruncate: Promise<TruncateFn | null> | undefined;
function loadTruncate(): Promise<TruncateFn | null> {
	piTruncate ??= (async () => {
		try {
			const mod: any = await import("@earendil-works/pi-coding-agent");
			return typeof mod.truncateHead === "function" ? mod.truncateHead : null;
		} catch {
			return null;
		}
	})();
	return piTruncate;
}

function formatSize(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)}KB`;
}

// ---------------------------------------------------------------------------
// Text mode
// ---------------------------------------------------------------------------

interface PdfTextPage {
	page: number;
	text: string;
}

async function pdfPageCount(absolutePath: string, deps: PdfReadDeps): Promise<number> {
	const info = await runPoppler("pdfinfo", [absolutePath], { timeoutMs: PDFINFO_TIMEOUT_MS, signal: deps.signal }, deps);
	const match = info.stdout.match(/^Pages:\s+(\d+)\s*$/m);
	if (!match) throw new PdfReadError(`could not determine the page count - the PDF may be corrupt (pdfinfo: ${stderrTail(info.stderr || info.stdout)})`);
	return Number(match[1]);
}

async function extractRun(
	absolutePath: string,
	run: [number, number],
	deps: PdfReadDeps,
): Promise<string> {
	const [first, last] = run;
	const result = await runPoppler(
		"pdftotext",
		["-f", String(first), "-l", String(last), absolutePath, "-"],
		{ timeoutMs: PDFTOTEXT_TIMEOUT_MS, signal: deps.signal },
		deps,
	);
	return result.stdout;
}

function splitRunPages(stdout: string, expectedPages: number, firstPage: number): PdfTextPage[] {
	// pdftotext ends every page with a form feed; the split length is a
	// provenance check - never map text to the wrong physical page silently.
	const chunks = stdout.split("\f");
	if (chunks[chunks.length - 1] === "") chunks.pop();
	if (chunks.length !== expectedPages) {
		throw new PdfReadError(
			`unexpected pdftotext output: ${chunks.length} page boundaries for ${expectedPages} pages (starting at page ${firstPage})`,
		);
	}
	return chunks.map((text, i) => ({ page: firstPage + i, text }));
}

function describeSelection(runs: Array<[number, number]>, pageCount: number): { runs: Array<[number, number]>; desc: string } {
	const runsOrAll = runs ?? [[1, pageCount] as [number, number]];
	return { runs: runsOrAll, desc: describeRuns(runsOrAll) };
}

export async function readPdfText(
	absolutePath: string,
	params: PdfReadParams,
	pageCount: number,
	deps: PdfReadDeps,
): Promise<ReadOutcome> {
	const name = basename(absolutePath);
	const { runs, desc } = describeSelection(
		params.pages !== undefined ? parsePageSelection(params.pages) : undefined,
		pageCount,
	);
	for (const [a, b] of runs) {
		if (b > pageCount) {
			throw new PdfReadError(`pages ${a}-${b} out of range: ${name} has ${pageCount} physical page${pageCount === 1 ? "" : "s"}`);
		}
	}

	const pages: PdfTextPage[] = [];
	for (const run of runs) {
		const stdout = await extractRun(absolutePath, run, deps);
		pages.push(...splitRunPages(stdout, run[1] - run[0] + 1, run[0]));
		throwIfAborted(deps.signal);
	}

	// Thin/absent text flags live in the header so truncation can never hide them.
	const emptyPages = pages.filter((p) => p.text.replace(/\s+/g, "").length === 0).map((p) => p.page);
	const thinPages = pages
		.filter((p) => {
			const chars = p.text.replace(/\s+/g, "").length;
			return chars > 0 && chars < THIN_TEXT_CHARS_PER_PAGE;
		})
		.map((p) => p.page);
	const totalChars = pages.reduce((sum, p) => sum + p.text.replace(/\s+/g, "").length, 0);

	const header: string[] = [`[PDF text: ${name} (${pageCount} physical page${pageCount === 1 ? "" : "s"}) - extracting pages ${desc}]`];
	if (totalChars === 0) {
		header.push(
			`[PDF: no extractable text layer on the selected pages - likely scanned images or pure figures. ` +
				`Use mode:"image" to view the pages visually.]`,
		);
	} else {
		if (emptyPages.length > 0) {
			header.push(
				`[PDF: no extractable text on page${emptyPages.length === 1 ? "" : "s"} ${emptyPages.join(", ")} - ` +
					`consider mode:"image" for those pages]`,
			);
		}
		if (thinPages.length > 0) {
			header.push(
				`[PDF: very thin text on page${thinPages.length === 1 ? "" : "s"} ${thinPages.join(", ")} ` +
					`(< ${THIN_TEXT_CHARS_PER_PAGE} characters) - text extraction is unreliable for figures, math or tables; ` +
					`consider mode:"image"]`,
			);
		}
	}

	let assembled = header.join("\n");
	if (totalChars > 0) {
		// Form-feed page boundaries are preserved verbatim, one \f line per page end.
		const blocks = pages.map((p) => `--- PDF page ${p.page} ---\n${p.text.endsWith("\n") ? p.text : p.text + "\n"}\f`);
		assembled += "\n" + blocks.join("\n");
	}

	// Line-based pagination over the assembled output (header included), native read conventions.
	const allLines = assembled.split("\n");
	const totalLines = allLines.length;
	// Models mean "from the start" with offset 0 (run-3 consistency evidence);
	// native delegation absorbs it, so the PDF path does too - only negatives
	// and non-numbers are malformed.
	if (params.offset !== undefined && (!Number.isFinite(params.offset) || (params.offset as number) < 0)) {
		throw new PdfReadError("offset must be 0 or a positive line number (line 1 is the start)");
	}
	const startLine = params.offset !== undefined ? Math.max(0, Math.floor(params.offset as number) - 1) : 0;
	if (startLine >= totalLines) {
		throw new PdfReadError(`Offset ${params.offset} is beyond end of output (${totalLines} lines total)`);
	}
	let selection: string;
	let userLimitedLines: number | undefined;
	if (params.limit !== undefined) {
		const requested = params.limit as number;
		if (!Number.isFinite(requested) || requested < 0) {
			throw new PdfReadError("limit must be a positive number of lines");
		}
		if (requested >= 1) {
			// limit 0 means "no limit intended" (model evidence) - treated as absent,
			// never as an empty selection.
			userLimitedLines = Math.min(Math.floor(requested), totalLines - startLine);
			selection = allLines.slice(startLine, startLine + userLimitedLines).join("\n");
		} else {
			selection = allLines.slice(startLine).join("\n");
		}
	} else {
		selection = allLines.slice(startLine).join("\n");
	}

	const truncate = deps.truncate ?? (await loadTruncate()) ?? localTruncateHead;
	const truncation = truncate(selection, { maxLines: OUTPUT_MAX_LINES, maxBytes: OUTPUT_MAX_BYTES });
	let outputText: string;
	if (truncation.firstLineExceedsLimit) {
		outputText =
			`[Line ${startLine + 1} exceeds the ${formatSize(truncation.maxBytes ?? OUTPUT_MAX_BYTES)} output limit; ` +
			`narrow the selection with offset]`;
	} else if (truncation.truncated) {
		const endLine = startLine + truncation.outputLines;
		outputText = truncation.content;
		outputText +=
			truncation.truncatedBy === "lines"
				? `\n\n[Showing lines ${startLine + 1}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]`
				: `\n\n[Showing lines ${startLine + 1}-${endLine} of ${totalLines} (${formatSize(truncation.maxBytes ?? OUTPUT_MAX_BYTES)} limit). Use offset=${endLine + 1} to continue.]`;
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalLines) {
		// A user limit that stops before the end gets the native continuation
		// guidance too - remaining lines are never silently dropped.
		const remaining = totalLines - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;
		outputText = `${truncation.content}\n\n[${remaining} more lines in output. Use offset=${nextOffset} to continue.]`;
	} else {
		outputText = truncation.content;
	}

	return {
		content: [{ type: "text", text: outputText }],
		details: {
			pdf: true,
			mode: "text",
			pageCount,
			pages: desc,
			extractedChars: totalChars,
			emptyPages,
			thinPages,
			truncation,
		},
		structuredContent: outputText,
	};
}

// ---------------------------------------------------------------------------
// Image mode
// ---------------------------------------------------------------------------

interface RenderedImage {
	page: number;
	data: string;
	mimeType: "image/png";
	dpi: number;
}

function assertImageEligible(params: PdfReadParams, pageCount: number, name: string): Array<[number, number]> {
	if (params.pages === undefined && pageCount > MAX_IMAGE_PAGES) {
		throw new PdfReadError(
			`${name} has ${pageCount} pages; mode:"image" renders at most ${MAX_IMAGE_PAGES} pages per read. ` +
				`Select pages explicitly, e.g. pages:"1-4".`,
		);
	}
	const runs = params.pages !== undefined ? parsePageSelection(params.pages) : [[1, pageCount] as [number, number]];
	const expandedCount = runs.reduce((sum, [a, b]) => sum + (b - a + 1), 0);
	if (expandedCount > MAX_IMAGE_PAGES) {
		throw new PdfReadError(
			`mode:"image" renders at most ${MAX_IMAGE_PAGES} pages per read (selected ${expandedCount}). ` +
				`Select fewer pages, e.g. pages:"1-4".`,
		);
	}
	for (const [a, b] of runs) {
		if (b > pageCount) {
			throw new PdfReadError(`pages ${a}-${b} out of range: ${name} has ${pageCount} physical page${pageCount === 1 ? "" : "s"}`);
		}
	}
	return runs;
}

function pngFilesFor(dir: string, prefixBase: string): Promise<string[]> {
	return readdir(dir).then((names) =>
		names
			.map((n) => ({ n, m: n.match(new RegExp(`^${prefixBase}-(\\d+)\\.png$`)) }))
			.filter((e): e is { n: string; m: RegExpMatchArray } => e.m !== null)
			.sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
			.map((e) => join(dir, e.n)),
	);
}

async function renderRun(
	absolutePath: string,
	run: [number, number],
	runIndex: number,
	dir: string,
	deps: PdfReadDeps,
): Promise<{ files: Map<number, { path: string; bytes: number; dpi: number }>; skipped: Array<{ page: number; reason: string }> }> {
	const prefixBase = `run${runIndex}`;
	const prefix = join(dir, prefixBase);
	const files = new Map<number, { path: string; bytes: number; dpi: number }>();
	const skipped: Array<{ page: number; reason: string }> = [];

	const [first, last] = run;
	// Single pdftoppm per contiguous run; per-page size checks follow.
	await runPoppler(
		"pdftoppm",
		["-png", "-r", String(DEFAULT_DPI), "-f", String(first), "-l", String(last), absolutePath, prefix],
		{ timeoutMs: PDFTOPPM_TIMEOUT_MS, signal: deps.signal },
		deps,
	);
	for (const file of await pngFilesFor(dir, prefixBase)) {
		const page = Number(basename(file).match(/(\d+)\.png$/)![1]);
		files.set(page, { path: file, bytes: (await stat(file)).size, dpi: DEFAULT_DPI });
	}

	// Per-page byte bound: re-render at lower dpi, then skip with an honest note.
	for (const [page, entry] of [...files]) {
		if (entry.bytes <= MAX_IMAGE_BYTES) continue;
		let done = false;
		for (const dpi of DPI_BACKOFF) {
			if (dpi === DEFAULT_DPI) continue;
			const retryBase = `retry${runIndex}-p${page}`;
			await runPoppler(
				"pdftoppm",
				["-png", "-r", String(dpi), "-f", String(page), "-l", String(page), absolutePath, join(dir, retryBase)],
				{ timeoutMs: PDFTOPPM_TIMEOUT_MS, signal: deps.signal },
				deps,
			);
			const retryFiles = await pngFilesFor(dir, retryBase);
			if (retryFiles.length === 1 && (await stat(retryFiles[0])).size <= MAX_IMAGE_BYTES) {
				files.set(page, { path: retryFiles[0], bytes: (await stat(retryFiles[0])).size, dpi });
				done = true;
				break;
			}
		}
		if (!done) {
			skipped.push({ page, reason: `PNG exceeds ${formatSize(MAX_IMAGE_BYTES)} even at ${DPI_BACKOFF[DPI_BACKOFF.length - 1]} dpi` });
			files.delete(page);
		}
	}
	return { files, skipped };
}

export async function readPdfImages(
	absolutePath: string,
	params: PdfReadParams,
	pageCount: number,
	deps: PdfReadDeps,
): Promise<ReadOutcome> {
	const name = basename(absolutePath);
	const runs = assertImageEligible(params, pageCount, name);

	const dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), "pi-pdf-read-"));
	try {
		const images: RenderedImage[] = [];
		const skipped: Array<{ page: number; reason: string }> = [];
		let runIndex = 0;
		for (const run of runs) {
			const result = await renderRun(absolutePath, run, runIndex++, dir, deps);
			skipped.push(...result.skipped);
			for (const [page, entry] of result.files) {
				images.push({ page, data: (await readFile(entry.path)).toString("base64"), mimeType: "image/png", dpi: entry.dpi });
			}
		}
		images.sort((a, b) => a.page - b.page);

		const nonVision =
			deps.ctx?.model && !deps.ctx.model.input?.includes("image")
				? ["[Current model does not support images. The image will be omitted from this request.]"]
				: [];
		const reduced = images.filter((i) => i.dpi < DEFAULT_DPI);
		const noteLines = [
			`Rendered ${images.length} PDF page${images.length === 1 ? "" : "s"} from ${name} at ${DEFAULT_DPI} dpi (PNG): ` +
				(images.length > 0 ? describeRuns(mergeContiguous(images.map((i) => i.page))) : "none") + ".",
			...reduced.map((i) => `[PDF: page ${i.page} rendered at ${i.dpi} dpi (size bound)]`),
			...skipped.map((s) => `[PDF: page ${s.page} skipped - ${s.reason}]`),
			...nonVision,
		];
		const note = noteLines.join("\n");
		const content: ContentBlock[] = [{ type: "text", text: note }];
		for (const image of images) {
			content.push({ type: "text", text: `PDF page ${image.page}:` });
			content.push({ type: "image", data: image.data, mimeType: "image/png" });
		}
		return {
			content,
			details: {
				pdf: true,
				mode: "image",
				pageCount,
				pages: describeRuns(runs),
				renderedPages: images.map((i) => i.page),
				skippedPages: skipped,
				dpi: DEFAULT_DPI,
			},
			structuredContent: {
				type: "pages",
				note,
				images: images.map((i) => ({ page: i.page, data: i.data, mimeType: "image/png" })),
			},
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function mergeContiguous(pages: number[]): Array<[number, number]> {
	const runs: Array<[number, number]> = [];
	for (const page of pages) {
		const last = runs[runs.length - 1];
		if (last && last[1] === page - 1) last[1] = page;
		else runs.push([page, page]);
	}
	return runs;
}

// ---------------------------------------------------------------------------
// Unified read (PDF branch + builtin delegation)
// ---------------------------------------------------------------------------

let builtinReadPromise: Promise<BuiltinReadExecute | null> | undefined;
function loadBuiltinRead(): Promise<BuiltinReadExecute | null> {
	builtinReadPromise ??= (async () => {
		try {
			const mod: any = await import("@earendil-works/pi-coding-agent");
			if (typeof mod.createReadToolDefinition !== "function") return null;
			const definition = mod.createReadToolDefinition(process.cwd());
			return definition.execute.bind(definition);
		} catch {
			return null;
		}
	})();
	return builtinReadPromise;
}

/**
 * The read tool body: PDFs go through Poppler, everything else delegates to
 * the SDK's built-in read definition unchanged (same params, signal, ctx).
 */
export async function executeRead(
	toolCallId: string,
	params: PdfReadParams,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: { cwd?: string; model?: { input?: string[] } } | undefined,
	deps: Pick<PdfReadDeps, "builtinRead"> = {},
): Promise<{ content: ContentBlock[]; details: unknown; structuredContent?: unknown }> {
	const absolutePath = resolveLocalPath(params.path, ctx);
	if (await isPdfFile(absolutePath)) {
		return runReadPdf(params, { signal, ctx });
	}
	const builtin = deps.builtinRead !== undefined ? deps.builtinRead : await loadBuiltinRead();
	if (!builtin) {
		throw new Error("read is unavailable: the Pi SDK builtin read definition could not be loaded");
	}
	return builtin(
		toolCallId,
		{ path: params.path, offset: params.offset, limit: params.limit },
		signal,
		onUpdate,
		ctx,
	);
}

export async function runReadPdf(params: PdfReadParams, deps: PdfReadDeps): Promise<ReadOutcome> {
	throwIfAborted(deps.signal);
	params = normalizeOptionalFields(params);
	const mode = params.mode ?? "text";
	if (mode !== "text" && mode !== "image") {
		throw new PdfReadError(`invalid mode "${String(params.mode)}" - use "text" (default) or "image"`);
	}
	if (mode === "image" && (params.offset !== undefined || params.limit !== undefined)) {
		throw new PdfReadError('offset/limit are line-based text pagination and do not apply to mode:"image"');
	}
	const absolutePath = resolveLocalPath(params.path, deps.ctx);
	const pageCount = await pdfPageCount(absolutePath, deps);
	if (mode === "image") return readPdfImages(absolutePath, params, pageCount, deps);
	return readPdfText(absolutePath, params, pageCount, deps);
}

// ---------------------------------------------------------------------------
// Optional-field normalization
// ---------------------------------------------------------------------------

// Models sometimes spell "not supplied" for optional fields instead of omitting
// them: null, the STRINGS "null"/"undefined", or "". Real JSON nulls are
// already deleted by pi's argument layer (normalizeOptionalNulls, verified
// against the pinned runtime), but null-ish STRINGS pass schema validation for
// string-typed fields and used to fail the default PDF read on first call
// (review c-82). These exact tokens mean "absent" - anything else (e.g.
// "null-2", "0", "abc") is still validated and rejected on its merits.
const NULLISH_TOKENS = new Set(["null", "undefined"]);

function absentOptional(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value === "string") {
		const trimmed = value.trim().toLowerCase();
		return trimmed === "" || NULLISH_TOKENS.has(trimmed);
	}
	return false;
}

export function normalizeOptionalFields(params: PdfReadParams): PdfReadParams {
	const normalized: PdfReadParams = { path: params.path };
	if (!absentOptional(params.pages)) normalized.pages = String(params.pages);
	if (!absentOptional(params.mode)) normalized.mode = params.mode as "text" | "image";
	if (!absentOptional(params.offset)) normalized.offset = params.offset as number;
	if (!absentOptional(params.limit)) normalized.limit = params.limit as number;
	return normalized;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Parameter and output schemas, parameterized on a typebox-like Type so the
 * shapes stay testable in bare node. The outputSchema union must keep the
 * native read variants - text is a string and a delegated image read returns
 * the native {type:"image",data,mimeType,note} shape - plus the PDF pages
 * shape for image mode.
 */
export function readToolSchemas(Type: any): { parameters: any; outputSchema: any } {
	return {
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
			offset: Type.Optional(
				Type.Number({ description: "Line number to start reading from (1-indexed). Text only. Omit when not needed." }),
			),
			limit: Type.Optional(
				Type.Number({ description: "Maximum number of lines to read. Text only. Omit when not needed." }),
			),
			pages: Type.Optional(
				Type.String({
					description:
						'Only for PDFs: physical pages to read, 1-indexed: "3", "2-5", "1,4-6". Omit for all pages (text) or up to the 8-image bound (image). Never send null - omit instead.',
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("text"), Type.Literal("image")], {
					description: 'Only for PDFs: "image" renders full-page PNGs instead of extracting text. Omit for text files and for text-mode PDF reads.',
				}),
			),
		}),
		outputSchema: Type.Union([
			Type.String(),
			Type.Object({
				type: Type.Literal("image"),
				data: Type.String(),
				mimeType: Type.String(),
				note: Type.String(),
			}),
			Type.Object({
				type: Type.Literal("pages"),
				note: Type.String(),
				images: Type.Array(Type.Object({ page: Type.Number(), data: Type.String(), mimeType: Type.String() })),
			}),
		]),
	};
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const { Type } = await import("typebox");
	let renderers: Record<string, unknown> = {};
	try {
		const { Text } = await import("@earendil-works/pi-tui");
		renderers = makeRenderers(Text);
	} catch {
		// Headless contexts: the tool works, default rendering applies.
	}

	const { parameters, outputSchema } = readToolSchemas(Type);
	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. " +
			"For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. " +
			"When you need the full file, continue with offset until complete. " +
			'Local PDFs (files beginning with %PDF-) are read the same way: mode:"text" (default) extracts the text layer - ' +
			"pages are labeled by physical PDF page number, which is never a printed page label - and mode:\"image\" renders " +
			"full-page PNGs (max 8 per read). Optional pages selects physical pages, e.g. \"3\" or \"2-5,7\".",
		promptSnippet: "Read file contents (including local PDFs)",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters,
		outputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		...renderers,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return executeRead(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}

// ---------------------------------------------------------------------------
// Renderers (native-read presentation; loaded only when pi-tui is importable)
// ---------------------------------------------------------------------------

function makeRenderers(TextCtor: any): Record<string, unknown> {
	function formatCall(args: any, theme: any): string {
		const pathDisplay = String(args?.path ?? "");
		let text = theme.fg("toolTitle", theme.bold("read")) + " " + theme.fg("accent", pathDisplay);
		if (args?.offset != null || args?.limit != null) {
			const start = args?.offset ?? 1;
			const end = args?.limit != null ? start + args.limit - 1 : "";
			text += theme.fg("warning", `:${start}${end ? `-${end}` : ""}`);
		}
		const extras: string[] = [];
		// null-filled optionals mean "not supplied" - never displayed as if meaningful
		const meaningful = (v: any) =>
			v !== undefined && v !== null && !(typeof v === "string" && ["", "null", "undefined"].includes(v.trim().toLowerCase()));
		if (meaningful(args?.pages)) extras.push(`pages ${args.pages}`);
		if (meaningful(args?.mode)) extras.push(`mode:${args.mode}`);
		if (extras.length > 0) text += theme.fg("dim", ` (${extras.join(", ")})`);
		return text;
	}
	return {
		renderCall(args: any, theme: any, context: any) {
			const text = context.lastComponent ?? new TextCtor("", 0, 0);
			text.setText(formatCall(args, theme));
			return text;
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			const text = context.lastComponent ?? new TextCtor("", 0, 0);
			if (!options.expanded && !context.isError) {
				text.setText("");
				return text;
			}
			const details = result?.details as Record<string, any> | undefined;
			const textBlock = Array.isArray(result?.content)
				? result.content.find((b: any) => b.type === "text")?.text ?? ""
				: "";
			const imageCount = Array.isArray(result?.content)
				? result.content.filter((b: any) => b.type === "image").length
				: 0;
			let out: string;
			if (context.isError) {
				out = textBlock.split("\n").slice(0, 6).join("\n");
			} else if (details?.mode === "image") {
				const header = textBlock.split("\n")[0] ?? "";
				out = header + (imageCount > 0 ? `\n${imageCount} page image${imageCount === 1 ? "" : "s"} attached` : "");
			} else {
				const lines = textBlock.split("\n");
				const maxLines = options.expanded ? lines.length : 10;
				const shown = lines.slice(0, maxLines);
				const remaining = lines.length - shown.length;
				out = shown.map((line: string) => theme.fg("toolOutput", line)).join("\n");
				if (remaining > 0) out += theme.fg("muted", `\n... (${remaining} more lines)`);
			}
			const truncation = details?.truncation;
			if (truncation?.truncated) {
				out += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines]`)}`;
			}
			text.setText(out);
			return text;
		},
	};
}
