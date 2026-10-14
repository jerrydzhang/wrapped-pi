// Runs with: node --test extensions/tests/pdf-read.test.ts
// Bare-node suite: poppler behavior is faked at the exec boundary; real
// Poppler coverage lives in pdf-read.poppler.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	executeRead,
	localTruncateHead,
	normalizeOptionalFields,
	parsePageSelection,
	PdfReadError,
	resolveLocalPath,
	resolvePopplerTool,
	runReadPdf,
	type ContentBlock,
	type PdfReadDeps,
	type PdfReadParams,
	type PopplerExec,
	type TruncationResult,
} from "../pdf-read.ts";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function makeTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `pdf-read-test-${prefix}-`));
}

// --- fake poppler -----------------------------------------------------------

interface ExecCall {
	tool: string;
	args: string[];
	options: { timeoutMs: number; signal?: AbortSignal };
}

type Handler = (args: string[], options: ExecCall["options"]) => Promise<string> | string;

function fakeExec(tools: Record<string, Handler>, missing: string[] = []): { exec: PopplerExec; calls: ExecCall[] } {
	const calls: ExecCall[] = [];
	const exec: PopplerExec = async (program, args, options) => {
		const tool = basename(program);
		calls.push({ tool, args, options });
		if (missing.includes(tool)) {
			const err = new Error(`spawn ${program} ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		}
		const handler = tools[tool];
		if (!handler) throw new Error(`fake poppler: unexpected tool ${tool}`);
		if (options.signal?.aborted) throw new Error("Operation aborted");
		return { stdout: await handler(args, options), stderr: "" };
	};
	return { exec, calls };
}

function fakePdfinfo(pages: number): Handler {
	return () => `Pages:          ${pages}\n`;
}

// pdftotext fake: echoes the CURRENT bytes of the selected pdf path as the
// extraction, one identical \f-terminated chunk per requested page — poppler
// reads current contents, and so does the fake.
function echoingPdftotext(): Handler {
	return (args) => {
		const rangeFirst = Number(args[args.indexOf("-f") + 1]);
		const rangeLast = Number(args[args.indexOf("-l") + 1]);
		// pdftotext argv: [-f, first, -l, last, <pdf path>, -]
		const content = readFileSync(args[4], "utf8");
		const pages: string[] = [];
		for (let p = rangeFirst; p <= rangeLast; p++) pages.push(`${content}\n`);
		return pages.map((t) => `${t}\f`).join("");
	};
}

function pngBytes(size: number): Buffer {
	const body = Buffer.alloc(Math.max(0, size - PNG_MAGIC.length), 0x61);
	return Buffer.concat([PNG_MAGIC, body]);
}

// pdftoppm fake: writes prefix-<page>.png for each requested page, honoring -r
// so tests can script per-dpi sizes.
function fakePdftoppm(sizeForDpi: (dpi: number) => number | "reject"): Handler {
	return async (args) => {
		const dpi = Number(args[args.indexOf("-r") + 1]);
		const first = Number(args[args.indexOf("-f") + 1]);
		const last = Number(args[args.indexOf("-l") + 1]);
		const prefix = args[args.length - 1];
		const decision = sizeForDpi(dpi);
		if (decision === "reject") throw new Error("pdftoppm exploded");
		for (let p = first; p <= last; p++) {
			await writeFile(`${prefix}-${p}.png`, pngBytes(decision));
		}
		return "";
	};
}

function passthroughTruncate(text: string): TruncationResult {
	return {
		content: text,
		truncated: false,
		outputLines: text.split("\n").length,
		totalLines: text.split("\n").length,
	};
}

interface DepsOptions {
	pages?: number;
	pdftotext?: Handler;
	pdftoppm?: Handler;
	missing?: string[];
	env?: Record<string, string | undefined>;
	truncate?: PdfReadDeps["truncate"];
	ctx?: PdfReadDeps["ctx"];
	signal?: AbortSignal;
	tmpRoot?: string;
}

function makeDeps(opts: DepsOptions = {}): { deps: PdfReadDeps; calls: ExecCall[] } {
	const { exec, calls } = fakeExec(
		{
			pdfinfo: fakePdfinfo(opts.pages ?? 3),
			pdftotext: opts.pdftotext ?? echoingPdftotext(),
			pdftoppm: opts.pdftoppm ?? fakePdftoppm(() => 512),
		},
		opts.missing ?? [],
	);
	const deps: PdfReadDeps = {
		exec,
		env: opts.env ?? {},
		truncate: opts.truncate ?? passthroughTruncate,
		...(opts.signal !== undefined ? { signal: opts.signal } : {}),
		...(opts.ctx !== undefined ? { ctx: opts.ctx } : {}),
		...(opts.tmpRoot !== undefined ? { tmpRoot: opts.tmpRoot } : {}),
	};
	return { deps, calls };
}

// --- page selection parsing -------------------------------------------------

test("parsePageSelection accepts singles, ranges and lists", () => {
	assert.deepEqual(parsePageSelection("3"), [[3, 3]]);
	assert.deepEqual(parsePageSelection("2-5"), [[2, 5]]);
	assert.deepEqual(parsePageSelection("1,4-6"), [[1, 1], [4, 6]]);
	assert.deepEqual(parsePageSelection(" 2 - 4 , 7 "), [[2, 4], [7, 7]]);
});

test("parsePageSelection rejects invalid selections", () => {
	for (const bad of ["", "0", "2-1", "a", "1,", "1--2", "-3"]) {
		assert.throws(() => parsePageSelection(bad), PdfReadError, `expected rejection of "${bad}"`);
	}
});

test("parsePageSelection explains 1-indexing on zero", () => {
	assert.throws(() => parsePageSelection("0"), /1-indexed/);
});

// --- poppler resolution -----------------------------------------------------

test("resolvePopplerTool pins the exported bin dir, falls back to PATH", () => {
	assert.equal(
		resolvePopplerTool("pdftotext", { WRAPPED_PI_POPPLER_BIN: "/nix/store/x-poppler/bin" }),
		"/nix/store/x-poppler/bin/pdftotext",
	);
	assert.equal(resolvePopplerTool("pdftotext", {}), "pdftotext");
});

// --- delegation -------------------------------------------------------------

test("non-PDF reads delegate unchanged to the builtin with original params and ctx", async () => {
	const dir = await makeTempDir("deleg");
	const file = join(dir, "notes.txt");
	await writeFile(file, "plain text");
	const builtinCalls: Array<{ params: unknown; ctx: unknown; toolCallId: string }> = [];
	const builtinResult = { content: [{ type: "text", text: "builtin text" }], details: { builtin: true } };
	const ctx = { cwd: dir, model: { input: ["text"] } };
	const outcome = await executeRead("call-1", { path: file, offset: 2, limit: 5 }, undefined, undefined, ctx, {
		builtinRead: async (toolCallId, params, signal, onUpdate, passedCtx) => {
			builtinCalls.push({ params, ctx: passedCtx, toolCallId });
			assert.equal(signal, undefined);
			assert.equal(onUpdate, undefined);
			return builtinResult;
		},
	});
	assert.equal(builtinCalls.length, 1);
	assert.equal(builtinCalls[0].toolCallId, "call-1");
	assert.deepEqual(builtinCalls[0].params, { path: file, offset: 2, limit: 5 });
	assert.equal(builtinCalls[0].ctx, ctx);
	assert.equal(outcome, builtinResult); // identity passthrough — unchanged
	await rm(dir, { recursive: true, force: true });
});

test("unreadable and missing paths delegate so native error conventions hold", async () => {
	const dir = await makeTempDir("deleg-missing");
	const missing = join(dir, "nope.txt");
	let delegated = 0;
	await assert.rejects(
		executeRead("c", { path: missing }, undefined, undefined, undefined, {
			builtinRead: async () => {
				delegated++;
				throw new Error("ENOENT: no such file, native shape");
			},
		}),
		/native shape/,
	);
	assert.equal(delegated, 1);
	await rm(dir, { recursive: true, force: true });
});

test("PDF detection is by content, not extension", async () => {
	const dir = await makeTempDir("sniff");
	const realPdf = join(dir, "real.pdf");
	await writeFile(realPdf, Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 0x30)]));
	const lying = join(dir, "lying.pdf");
	await writeFile(lying, "just text, no magic bytes anywhere in here at all");

	const { deps } = makeDeps({ pages: 1, pdftotext: () => "hello\f" });
	// real.pdf: %PDF- within the first KB → poppler path
	const pdfOutcome = await runReadPdf({ path: realPdf }, { ...deps, ctx: { cwd: dir } });
	assert.match((pdfOutcome.content[0] as { text: string }).text, /hello/);
	// lying.pdf: no magic → delegation, despite the .pdf extension
	let delegated = 0;
	await executeRead("c", { path: lying }, undefined, undefined, { cwd: dir }, {
		builtinRead: async () => {
			delegated++;
			return { content: [{ type: "text", text: "delegated" }], details: undefined };
		},
	});
	assert.equal(delegated, 1);
	await rm(dir, { recursive: true, force: true });
});

// --- text mode --------------------------------------------------------------

test("text mode labels physical pages, preserves form feeds, provenance holds", async () => {
	const dir = await makeTempDir("text");
	const pdf = join(dir, "paper.pdf");
	await writeFile(pdf, "doc-bytes");
	const { deps, calls } = makeDeps({
		pages: 3,
		pdftotext: () => "alpha page one\n\fbeta page two\n\fgamma page three\n\f",
	});
	const outcome = await runReadPdf({ path: pdf }, { ...deps, ctx: { cwd: dir } });
	const text = (outcome.content[0] as { text: string }).text;
	assert.match(text, /^\[PDF text: paper\.pdf \(3 physical pages\) — extracting pages 1-3\]/);
	assert.match(text, /--- PDF page 1 ---\nalpha page one/);
	assert.match(text, /--- PDF page 2 ---\nbeta page two/);
	assert.match(text, /--- PDF page 3 ---\ngamma page three/);
	// one \f per page, preserved verbatim
	assert.equal((text.match(/\f/g) ?? []).length, 3);
	// provenance: every label is immediately followed by that page's text
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^--- PDF page (\d+) ---$/);
		if (m) assert.ok(lines[i + 1].length > 0, `page ${m[1]} label not followed by its text`);
	}
	assert.ok((outcome.details as { extractedChars: number }).extractedChars > 0);
	assert.equal(outcome.structuredContent, text);
	// safe argv: one pdftotext for the whole doc, exact args
	const pdftotextCalls = calls.filter((c) => c.tool === "pdftotext");
	assert.equal(pdftotextCalls.length, 1);
	assert.deepEqual(pdftotextCalls[0].args, ["-f", "1", "-l", "3", pdf, "-"]);
	await rm(dir, { recursive: true, force: true });
});

test("text mode with pages selection extracts exactly those pages", async () => {
	const dir = await makeTempDir("sel");
	const pdf = join(dir, "sel.pdf");
	await writeFile(pdf, "doc-bytes");
	const { deps, calls } = makeDeps({ pages: 5, pdftotext: () => "two\f" });
	const outcome = await runReadPdf({ path: pdf, pages: "2" }, { ...deps, ctx: { cwd: dir } });
	const text = (outcome.content[0] as { text: string }).text;
	assert.match(text, /extracting pages 2\]/);
	assert.doesNotMatch(text, /PDF page 1 ---/);
	assert.match(text, /--- PDF page 2 ---\ntwo/);
	assert.deepEqual(calls.find((c) => c.tool === "pdftotext")!.args, ["-f", "2", "-l", "2", pdf, "-"]);
	await rm(dir, { recursive: true, force: true });
});

test("text mode rejects out-of-range pages with the physical page count", async () => {
	const dir = await makeTempDir("range");
	const pdf = join(dir, "r.pdf");
	await writeFile(pdf, "x");
	const { deps } = makeDeps({ pages: 4 });
	await assert.rejects(runReadPdf({ path: pdf, pages: "3-9" }, { ...deps, ctx: { cwd: dir } }), /has 4 physical pages/);
	await rm(dir, { recursive: true, force: true });
});

test("offset/limit paginate the assembled output line-wise with native continuation", async () => {
	const dir = await makeTempDir("pag");
	const pdf = join(dir, "p.pdf");
	await writeFile(pdf, "x");
	const { deps } = makeDeps({ pages: 3, pdftotext: () => "l1\nl2\n\fl3\n\fl4\n\f" });
	const full = await runReadPdf({ path: pdf }, { ...deps, ctx: { cwd: dir } });
	const fullText = (full.content[0] as { text: string }).text;
	const total = fullText.split("\n").length;

	// A user limit that stops early must carry the native continuation footer.
	const paged = await runReadPdf({ path: pdf, offset: 2, limit: 3 }, { ...deps, ctx: { cwd: dir } });
	const pagedText = (paged.content[0] as { text: string }).text;
	const remaining = total - 4;
	assert.equal(
		pagedText,
		fullText.split("\n").slice(1, 4).join("\n") +
			`\n\n[${remaining} more lines in output. Use offset=5 to continue.]`,
	);

	// A limit reaching the end of the output must NOT carry a footer.
	const toEnd = await runReadPdf({ path: pdf, offset: 2, limit: total - 1 }, { ...deps, ctx: { cwd: dir } });
	assert.equal((toEnd.content[0] as { text: string }).text, fullText.split("\n").slice(1).join("\n"));

	// A limit past the end clamps without inventing lines.
	const over = await runReadPdf({ path: pdf, limit: total + 50 }, { ...deps, ctx: { cwd: dir } });
	assert.equal((over.content[0] as { text: string }).text, fullText);

	await assert.rejects(
		runReadPdf({ path: pdf, offset: total + 10 }, { ...deps, ctx: { cwd: dir } }),
		/beyond end of output/,
	);
	await rm(dir, { recursive: true, force: true });
});

test("truncation produces native-style continuation footers", async () => {
	const dir = await makeTempDir("trunc");
	const pdf = join(dir, "t.pdf");
	await writeFile(pdf, "x");
	const scripted: TruncationResult = {
		content: "first lines",
		truncated: true,
		truncatedBy: "lines",
		outputLines: 10,
		totalLines: 500,
	};
	const { deps } = makeDeps({ pages: 3, pdftotext: () => "x\f y\f z\f", truncate: () => scripted });
	const outcome = await runReadPdf({ path: pdf }, { ...deps, ctx: { cwd: dir } });
	assert.match((outcome.content[0] as { text: string }).text, /\[Showing lines 1-10 of \d+\. Use offset=11 to continue\.\]/);

	const bytesTruncation: TruncationResult = { ...scripted, truncatedBy: "bytes" };
	const outcome2 = await runReadPdf({ path: pdf }, { ...deps, truncate: () => bytesTruncation, ctx: { cwd: dir } });
	assert.match(
		(outcome2.content[0] as { text: string }).text,
		/\[Showing lines 1-10 of \d+ \(50\.0KB limit\)\. Use offset=11 to continue\.\]/,
	);
	await rm(dir, { recursive: true, force: true });
});

test("absent and very thin text is flagged with the image-mode suggestion in the header", async () => {
	const dir = await makeTempDir("thin");
	const pdf = join(dir, "scan.pdf");
	await writeFile(pdf, "x");
	const { deps } = makeDeps({ pages: 3, pdftotext: () => "\f x \f\f" });
	const outcome = await runReadPdf({ path: pdf }, { ...deps, ctx: { cwd: dir } });
	const text = (outcome.content[0] as { text: string }).text;
	assert.match(text, /no extractable text on pages 1, 3.*mode:"image"/s);
	const details = outcome.details as { emptyPages: number[]; thinPages: number[] };
	assert.deepEqual(details.emptyPages, [1, 3]);
	assert.deepEqual(details.thinPages, [2]);

	const { deps: deps2 } = makeDeps({ pages: 2, pdftotext: () => "\f\f" });
	const empty = await runReadPdf({ path: pdf }, { ...deps2, ctx: { cwd: dir } });
	const emptyText = (empty.content[0] as { text: string }).text;
	assert.match(emptyText, /no extractable text layer.*mode:"image"/s);
	assert.doesNotMatch(emptyText, /--- PDF page 1 ---/);
	await rm(dir, { recursive: true, force: true });
});

test("same path, changed contents: every invocation reads current bytes", async () => {
	const dir = await makeTempDir("change");
	const pdf = join(dir, "paper.pdf");
	await writeFile(pdf, "version-one marker");
	const { deps } = makeDeps({ pages: 1 });
	const first = await runReadPdf({ path: pdf }, { ...deps, ctx: { cwd: dir } });
	assert.match((first.content[0] as { text: string }).text, /version-one marker/);
	await writeFile(pdf, "version-two marker");
	const second = await runReadPdf({ path: pdf }, { ...deps, ctx: { cwd: dir } });
	const secondText = (second.content[0] as { text: string }).text;
	assert.match(secondText, /version-two marker/);
	assert.doesNotMatch(secondText, /version-one marker/);
	await rm(dir, { recursive: true, force: true });
});

// --- image mode -------------------------------------------------------------

test("image mode bounds: pages required above the cap, selections validated", async () => {
	const dir = await makeTempDir("bound");
	const pdf = join(dir, "big.pdf");
	await writeFile(pdf, "x");
	const { deps } = makeDeps({ pages: 12 });
	await assert.rejects(
		runReadPdf({ path: pdf, mode: "image" }, { ...deps, ctx: { cwd: dir } }),
		/at most 8 pages per read.*pages:"1-4"/s,
	);
	await assert.rejects(
		runReadPdf({ path: pdf, pages: "1-9", mode: "image" }, { ...deps, ctx: { cwd: dir } }),
		/at most 8 pages per read/,
	);
	await assert.rejects(
		runReadPdf({ path: pdf, pages: "11-12", mode: "image", offset: 1 }, { ...deps, ctx: { cwd: dir } }),
		/offset\/limit are line-based text pagination/,
	);
	await rm(dir, { recursive: true, force: true });
});

test("image mode renders bounded PNGs with interleaved page labels", async () => {
	const dir = await makeTempDir("img");
	const pdf = join(dir, "img.pdf");
	await writeFile(pdf, "x");
	const tmpRoot = await makeTempDir("imgtmp");
	const { deps } = makeDeps({ pages: 2, pdftoppm: fakePdftoppm(() => 1024), tmpRoot });
	const outcome = await runReadPdf({ path: pdf, pages: "1-2", mode: "image" }, { ...deps, ctx: { cwd: dir } });
	const kinds = outcome.content.map((b: ContentBlock) => b.type);
	assert.deepEqual(kinds, ["text", "text", "image", "text", "image"]);
	for (const img of outcome.content.filter((b: ContentBlock) => b.type === "image")) {
		const bytes = Buffer.from(img.data!, "base64");
		assert.equal(PNG_MAGIC.compare(bytes.subarray(0, 8)), 0);
		assert.equal(img.mimeType, "image/png");
	}
	const header = (outcome.content[0] as { text: string }).text;
	assert.match(header, /Rendered 2 PDF pages from img\.pdf at 130 dpi \(PNG\): 1-2\./);
	assert.deepEqual((outcome.details as { renderedPages: number[] }).renderedPages, [1, 2]);
	const structured = outcome.structuredContent as { type: string; images: Array<{ page: number }> };
	assert.equal(structured.type, "pages");
	assert.deepEqual(structured.images.map((i) => i.page), [1, 2]);
	// temp render files are cleaned up
	assert.equal((await readdir(tmpRoot)).length, 0);
	await rm(dir, { recursive: true, force: true });
	await rm(tmpRoot, { recursive: true, force: true });
});

test("oversized renders back off dpi, then skip with an honest note", async () => {
	const dir = await makeTempDir("over");
	const pdf = join(dir, "heavy.pdf");
	await writeFile(pdf, "x");
	const tmpRoot = await makeTempDir("overtmp");
	const { deps, calls } = makeDeps({
		pages: 3,
		pdftoppm: fakePdftoppm((dpi) => (dpi >= 130 ? 4 * 1024 * 1024 : 1024)),
		tmpRoot,
	});
	const outcome = await runReadPdf({ path: pdf, mode: "image" }, { ...deps, ctx: { cwd: dir } });
	const header = (outcome.content[0] as { text: string }).text;
	assert.match(header, /page 1 rendered at 100 dpi \(size bound\)/);
	assert.deepEqual((outcome.details as { renderedPages: number[] }).renderedPages, [1, 2, 3]);
	// the retry targeted each single page at the lower dpi
	const retries = calls.filter((c) => c.tool === "pdftoppm" && c.args.includes("100"));
	assert.equal(retries.length, 3);
	for (const retry of retries) {
		assert.equal(retry.args[retry.args.indexOf("-f") + 1], retry.args[retry.args.indexOf("-l") + 1]);
	}
	assert.equal((await readdir(tmpRoot)).length, 0);
	await rm(dir, { recursive: true, force: true });
	await rm(tmpRoot, { recursive: true, force: true });
});

test("renders past every dpi bound are skipped, never silently oversized", async () => {
	const dir = await makeTempDir("skip");
	const pdf = join(dir, "huge.pdf");
	await writeFile(pdf, "x");
	const tmpRoot = await makeTempDir("skiptmp");
	const { deps } = makeDeps({ pages: 2, pdftoppm: fakePdftoppm(() => 5 * 1024 * 1024), tmpRoot });
	const outcome = await runReadPdf({ path: pdf, pages: "1-2", mode: "image" }, { ...deps, ctx: { cwd: dir } });
	const header = (outcome.content[0] as { text: string }).text;
	assert.match(header, /Rendered 0 PDF pages from huge\.pdf at 130 dpi \(PNG\): none\./);
	assert.match(header, /page 1 skipped — PNG exceeds .* even at 80 dpi/);
	assert.equal(outcome.content.filter((b: ContentBlock) => b.type === "image").length, 0);
	assert.equal((await readdir(tmpRoot)).length, 0);
	await rm(dir, { recursive: true, force: true });
	await rm(tmpRoot, { recursive: true, force: true });
});

test("image mode appends the non-vision note, following native read conventions", async () => {
	const dir = await makeTempDir("vision");
	const pdf = join(dir, "v.pdf");
	await writeFile(pdf, "x");
	const tmpRoot = await makeTempDir("visiotmp");
	const { deps } = makeDeps({ pages: 1, pdftoppm: fakePdftoppm(() => 512), tmpRoot });
	const outcome = await runReadPdf(
		{ path: pdf, pages: "1", mode: "image" },
		{ ...deps, ctx: { cwd: dir, model: { input: ["text"] } } },
	);
	const header = (outcome.content[0] as { text: string }).text;
	assert.match(header, /Current model does not support images\. The image will be omitted from this request\./);
	// native convention keeps the image blocks; assembly drops them
	assert.equal(outcome.content.filter((b: ContentBlock) => b.type === "image").length, 1);
	await rm(dir, { recursive: true, force: true });
	await rm(tmpRoot, { recursive: true, force: true });
});

// --- failures and cleanup ---------------------------------------------------

test("missing poppler executable produces actionable guidance", async () => {
	const dir = await makeTempDir("enoent");
	const pdf = join(dir, "e.pdf");
	await writeFile(pdf, "x");
	const { deps } = makeDeps({ pages: 1, missing: ["pdfinfo"] });
	await assert.rejects(runReadPdf({ path: pdf }, { ...deps, ctx: { cwd: dir } }), /pdfinfo not found.*WRAPPED_PI_POPPLER_BIN|PATH/s);
	await rm(dir, { recursive: true, force: true });
});

test("encrypted and corrupt PDFs map to useful errors", async () => {
	const dir = await makeTempDir("bad");
	const pdf = join(dir, "enc.pdf");
	await writeFile(pdf, "x");
	const encryptedExec = fakeExec({
		pdfinfo: fakePdfinfo(3),
		pdftotext: () => {
			const err = new Error("Command failed") as Error & { stderr?: string };
			err.stderr = "Syntax Error: Couldn't parse document\nIncorrect password";
			throw err;
		},
	});
	await assert.rejects(runReadPdf({ path: pdf }, { exec: encryptedExec.exec, env: {}, ctx: { cwd: dir } }), /PDF is encrypted/);

	const noPagesExec = fakeExec({ pdfinfo: () => "Creator: weird\n" });
	await assert.rejects(
		runReadPdf({ path: pdf }, { exec: noPagesExec.exec, env: {}, ctx: { cwd: dir } }),
		/could not determine the page count.*corrupt/s,
	);

	const notPdfExec = fakeExec({
		pdfinfo: () => {
			const err = new Error("Command failed") as Error & { stderr?: string };
			err.stderr = "May not be a PDF file (continuing anyway)";
			throw err;
		},
	});
	await assert.rejects(
		runReadPdf({ path: pdf }, { exec: notPdfExec.exec, env: {}, ctx: { cwd: dir } }),
		/not a valid PDF, or the file is corrupt/,
	);
	await rm(dir, { recursive: true, force: true });
});

test("pdftotext failure surfaces the mapped error with stderr tail", async () => {
	const dir = await makeTempDir("fail");
	const pdf = join(dir, "f.pdf");
	await writeFile(pdf, "x");
	const { deps } = makeDeps({
		pages: 2,
		pdftotext: () => {
			const err = new Error("Command failed: pdftotext") as Error & { stderr?: string };
			err.stderr = "Syntax Warning: something odd\nSyntax Error: broken xref";
			throw err;
		},
	});
	await assert.rejects(runReadPdf({ path: pdf }, { ...deps, ctx: { cwd: dir } }), /pdftotext failed:.*broken xref/s);
	await rm(dir, { recursive: true, force: true });
});

test("render temp files are cleaned up even when rendering fails mid-run", async () => {
	const dir = await makeTempDir("clean");
	const pdf = join(dir, "c.pdf");
	await writeFile(pdf, "x");
	const tmpRoot = await makeTempDir("cleantmp");
	const { deps } = makeDeps({ pages: 2, pdftoppm: fakePdftoppm(() => "reject"), tmpRoot });
	await assert.rejects(runReadPdf({ path: pdf, pages: "1-2", mode: "image" }, { ...deps, ctx: { cwd: dir } }), /pdftoppm failed/);
	assert.equal((await readdir(tmpRoot)).length, 0);
	await rm(dir, { recursive: true, force: true });
	await rm(tmpRoot, { recursive: true, force: true });
});

test("mismatched form-feed count is an honest error, never silent mislabeling", async () => {
	const dir = await makeTempDir("mismatch");
	const pdf = join(dir, "m.pdf");
	await writeFile(pdf, "x");
	const { deps } = makeDeps({ pages: 3, pdftotext: () => "only one boundary\n\f" });
	await assert.rejects(
		runReadPdf({ path: pdf }, { ...deps, ctx: { cwd: dir } }),
		/unexpected pdftotext output: 1 page boundaries for 3 pages/,
	);
	await rm(dir, { recursive: true, force: true });
});

test("aborted reads fail fast as Operation aborted", async () => {
	const dir = await makeTempDir("abort");
	const pdf = join(dir, "a.pdf");
	await writeFile(pdf, "x");
	const controller = new AbortController();
	controller.abort();
	const { deps } = makeDeps({ pages: 1, signal: controller.signal });
	await assert.rejects(runReadPdf({ path: pdf }, { ...deps, ctx: { cwd: dir } }), /Operation aborted/);
	await rm(dir, { recursive: true, force: true });
});

test("poppler subprocesses carry bounded runtimes", async () => {
	const dir = await makeTempDir("timeouts");
	const pdf = join(dir, "to.pdf");
	await writeFile(pdf, "x");
	const tmpRoot = await makeTempDir("totmp");
	const { deps, calls } = makeDeps({ pages: 2, pdftoppm: fakePdftoppm(() => 100), tmpRoot });
	await runReadPdf({ path: pdf, pages: "1", mode: "image" }, { ...deps, ctx: { cwd: dir } });
	await runReadPdf({ path: pdf }, { ...deps, ctx: { cwd: dir } }); // text mode exercises pdftotext
	const timeouts = new Map(calls.map((c) => [c.tool, c.options.timeoutMs]));
	assert.equal(timeouts.get("pdfinfo"), 10_000);
	assert.equal(timeouts.get("pdftotext"), 60_000);
	assert.equal(timeouts.get("pdftoppm"), 120_000);
	await rm(dir, { recursive: true, force: true });
	await rm(tmpRoot, { recursive: true, force: true });
});

// --- local truncation fallback ----------------------------------------------

test("localTruncateHead mirrors the bounded-tool contract", () => {
	const short = "a\nb\nc";
	const ok = localTruncateHead(short);
	assert.equal(ok.truncated, false);
	assert.equal(ok.content, short);

	const manyLines = Array.from({ length: 3000 }, (_, i) => `line-${i}`).join("\n");
	const lineCut = localTruncateHead(manyLines);
	assert.equal(lineCut.truncated, true);
	assert.equal(lineCut.truncatedBy, "lines");
	assert.equal(lineCut.content.split("\n").length, 2000);

	const longBytes = "é".repeat(40_000); // 2 bytes each in UTF-8
	const byteCut = localTruncateHead(longBytes);
	assert.equal(byteCut.truncated, true);
	assert.equal(byteCut.truncatedBy, "bytes");
	assert.ok(Buffer.byteLength(byteCut.content, "utf8") <= 50 * 1024);
	// cut falls between code points, never inside one
	assert.equal(Buffer.byteLength(byteCut.content, "utf8"), Buffer.byteLength(byteCut.content));
});

// --- regressions: null-ish optionals mean "not supplied" (review c-82) ---

test("default whole-PDF read succeeds when a model null-fills optional fields", async () => {
	const dir = await makeTempDir("nullish");
	const pdf = join(dir, "n.pdf");
	await writeFile(pdf, "doc-bytes");
	const forms: Array<Partial<PdfReadParams>> = [
		{ pages: "null", mode: "null", offset: "null", limit: "null" },
		{ pages: null, mode: null, offset: null, limit: null },
		{ pages: "", mode: "", offset: "", limit: "" },
		{ pages: "  NULL  ", mode: " Undefined ", offset: "undefined", limit: "NULL" },
	];
	for (const extra of forms) {
	const { deps } = makeDeps({ pages: 3, pdftotext: () => "whole doc\fwhole doc\fwhole doc\f" });
		const outcome = await runReadPdf({ path: pdf, ...extra } as PdfReadParams, { ...deps, ctx: { cwd: dir } });
		const text = (outcome.content[0] as { text: string }).text;
		assert.match(text, /extracting pages 1-3\]/, `form ${JSON.stringify(extra)} must read the whole document`);
		assert.match(text, /whole doc/);
		assert.doesNotMatch(text, /invalid page selection|must be a 1-indexed|must be a positive number/);
	}
	await rm(dir, { recursive: true, force: true });
});

test("garbage optional values still fail specifically — no blanket acceptance", async () => {
	const dir = await makeTempDir("garbage");
	const pdf = join(dir, "g.pdf");
	await writeFile(pdf, "x");
	const { deps } = makeDeps({ pages: 3, pdftotext: () => "x\fx\fx\f" });
	await assert.rejects(runReadPdf({ path: pdf, pages: "null-2" }, { ...deps, ctx: { cwd: dir } }), /invalid page selection "null-2"/);
	await assert.rejects(runReadPdf({ path: pdf, pages: "0" }, { ...deps, ctx: { cwd: dir } }), /1-indexed/);
	await assert.rejects(runReadPdf({ path: pdf, pages: "abc" }, { ...deps, ctx: { cwd: dir } }), /invalid page selection "abc"/);
	await assert.rejects(runReadPdf({ path: pdf, mode: "bogus" }, { ...deps, ctx: { cwd: dir } }), /invalid mode "bogus"/);
	await assert.rejects(runReadPdf({ path: pdf, offset: "abc" }, { ...deps, ctx: { cwd: dir } }), /offset must be 0 or a positive line number/);
	await assert.rejects(runReadPdf({ path: pdf, limit: "abc" }, { ...deps, ctx: { cwd: dir } }), /limit must be a positive number/);
	await assert.rejects(runReadPdf({ path: pdf, pages: "9" }, { ...deps, ctx: { cwd: dir } }), /has 3 physical pages/);
	await rm(dir, { recursive: true, force: true });
});

test("model boundary conventions are absorbed: offset 0 means start, limit 0 means no limit", async () => {
	const dir = await makeTempDir("zero");
	const pdf = join(dir, "z.pdf");
	await writeFile(pdf, "doc-bytes");
	const { deps } = makeDeps({ pages: 3, pdftotext: () => "z1\nz2\nz3\n\fz4\n\fz5\n\f" });
	// offset 0 = "from the start" (consistency-run 3 evidence), never an error
	const fromStart = await runReadPdf({ path: pdf, offset: 0 }, { ...deps, ctx: { cwd: dir } });
	assert.match((fromStart.content[0] as { text: string }).text, /extracting pages 1-3\]/);
	// limit 0 = "no limit intended", never an empty selection
	const noLimit = await runReadPdf({ path: pdf, limit: 0 }, { ...deps, ctx: { cwd: dir } });
	const noLimitText = (noLimit.content[0] as { text: string }).text;
	assert.match(noLimitText, /z5/);
	assert.doesNotMatch(noLimitText, /more lines in output/);
	// negatives remain malformed
	await assert.rejects(runReadPdf({ path: pdf, offset: -1 }, { ...deps, ctx: { cwd: dir } }), /offset must be 0 or a positive/);
	await assert.rejects(runReadPdf({ path: pdf, limit: -2 }, { ...deps, ctx: { cwd: dir } }), /limit must be a positive/);
	await rm(dir, { recursive: true, force: true });
});

test("delegation receives clean original params even when null-ish extras are present", async () => {
	const dir = await makeTempDir("deleg-nullish");
	const file = join(dir, "notes.md");
	await writeFile(file, "# just text\n");
	let received: unknown;
	await executeRead("c", { path: file, pages: "null", mode: "" }, undefined, undefined, { cwd: dir }, {
		builtinRead: async (_id, params) => {
			received = params;
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	});
	// non-PDF behavior is untouched: the native read gets exactly its own fields
	assert.deepEqual(received, { path: file, offset: undefined, limit: undefined });
	await rm(dir, { recursive: true, force: true });
});

test("normalizeOptionalFields keeps garbage for specific validation, drops only null-ish tokens", () => {
	assert.deepEqual(normalizeOptionalFields({ path: "/f.pdf", pages: "null", mode: "" }), { path: "/f.pdf" });
	assert.deepEqual(normalizeOptionalFields({ path: "/f.pdf", pages: "2-5", mode: "image", offset: 3, limit: 10 }), {
		path: "/f.pdf",
		pages: "2-5",
		mode: "image",
		offset: 3,
		limit: 10,
	});
	// non-nullish garbage survives normalization for specific rejection downstream
	assert.deepEqual(normalizeOptionalFields({ path: "/f.pdf", pages: "null-2" }), { path: "/f.pdf", pages: "null-2" });
	// path itself is never dropped
	assert.deepEqual(normalizeOptionalFields({ path: "/f.pdf" }), { path: "/f.pdf" });
});

// --- path resolution ----------------------------------------------------------

test("resolveLocalPath strips @, expands ~, resolves against ctx cwd", () => {
	assert.equal(resolveLocalPath("rel/file.pdf", { cwd: "/w" }), "/w/rel/file.pdf");
	assert.equal(resolveLocalPath("@rel/file.pdf", { cwd: "/w" }), "/w/rel/file.pdf");
	assert.equal(resolveLocalPath("/abs/f.pdf"), "/abs/f.pdf");
	assert.equal(resolveLocalPath("~/f.pdf", { cwd: "/w" }), join(homedir(), "f.pdf"));
});

// --- regressions: anchored, bounded PDF detection (review c-72 findings 1+2) ---

import { readFileSync as sniffReadFileSync } from "node:fs";
import { truncate as truncateFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isPdfFile, readToolSchemas } from "../pdf-read.ts";

const extensionSourcePath = fileURLToPath(new URL("../pdf-read.ts", import.meta.url));
const extensionDocsPath = fileURLToPath(new URL("../pdf-read.md", import.meta.url));

// The extension source and docs both MENTION %PDF- within their first KiB
// (the PDF_MAGIC constant / prose). Substring detection misrouted both to
// Poppler; anchored detection must delegate them.
test("files that merely mention %PDF- near the top are not PDFs", async () => {
	for (const path of [extensionSourcePath, extensionDocsPath]) {
		const head = sniffReadFileSync(path).subarray(0, 1024);
		assert.ok(head.includes("%PDF-"), `fixture precondition: ${path} mentions %PDF- in its first KiB`);
		assert.equal(await isPdfFile(path), false, `${path} must not be classified as a PDF`);
	}
	const dir = await makeTempDir("prose");
	const prose = join(dir, "notes.md");
	await writeFile(prose, "# Notes\n\nThe header magic looks like %PDF-1.7 in the docs.\n");
	assert.equal(await isPdfFile(prose), false);
	await rm(dir, { recursive: true, force: true });
});

test("executeRead delegates the extension source itself", async () => {
	let delegated = 0;
	const outcome = await executeRead("c", { path: extensionSourcePath }, undefined, undefined, undefined, {
		builtinRead: async () => {
			delegated++;
			return { content: [{ type: "text", text: "delegated source" }], details: undefined };
		},
	});
	assert.equal(delegated, 1);
	assert.match((outcome.content[0] as { text: string }).text, /delegated source/);
});

test("a real PDF must still be detected: magic anchored at offset 0", async () => {
	const dir = await makeTempDir("anchor");
	const pdf = join(dir, "real.pdf");
	await writeFile(pdf, Buffer.concat([Buffer.from("%PDF-1.6\n"), Buffer.alloc(64, 0x20)]));
	assert.equal(await isPdfFile(pdf), true);
	// junk before the header is NOT a PDF claim — delegated (documented trade-off)
	const junky = join(dir, "junky.pdf");
	await writeFile(junky, Buffer.concat([Buffer.from("leading junk bytes\n"), Buffer.from("%PDF-1.6\n"), Buffer.alloc(64, 0x20)]));
	assert.equal(await isPdfFile(junky), false);
	// truncated header and empty file are not PDFs
	const short = join(dir, "short.pdf");
	await writeFile(short, "%PD");
	assert.equal(await isPdfFile(short), false);
	const empty = join(dir, "empty.pdf");
	await writeFile(empty, "");
	assert.equal(await isPdfFile(empty), false);
	await rm(dir, { recursive: true, force: true });
});

test("the sniff reads a bounded prefix, never the whole file", async () => {
	const dir = await makeTempDir("sparse");
	const sparse = join(dir, "huge.txt");
	await writeFile(sparse, "plain text header, definitely not a pdf at all");
	await truncateFile(sparse, 128 * 1024 * 1024); // sparse extension to 128MiB
	const before = process.memoryUsage().arrayBuffers;
	const result = await isPdfFile(sparse);
	const after = process.memoryUsage().arrayBuffers;
	assert.equal(result, false);
	const growth = after - before;
	// the old full-file read allocated ~128MiB here; the bounded read stays KiB-scale
	assert.ok(growth < 8 * 1024 * 1024, `sniff allocated ${(growth / 1048576).toFixed(1)}MiB for a 128MiB file`);
	await rm(dir, { recursive: true, force: true });
});

// --- regression: outputSchema keeps the native delegated image variant (finding 3) ---

const RecorderType: any = {
	Object: (properties: any, options?: any) => ({ kind: "object", properties, ...options }),
	String: (options?: any) => ({ kind: "string", ...options }),
	Number: (options?: any) => ({ kind: "number", ...options }),
	Literal: (value: any) => ({ kind: "literal", const: value }),
	Union: (schemas: any[]) => ({ kind: "union", anyOf: schemas }),
	Array: (items: any) => ({ kind: "array", items }),
	Optional: (schema: any) => ({ ...schema, optional: true }),
};

test("outputSchema union keeps the native image variant, text string, and pages shape", () => {
	const { outputSchema } = readToolSchemas(RecorderType);
	assert.equal(outputSchema.kind, "union");
	const variants = outputSchema.anyOf;
	assert.equal(variants.length, 3);
	assert.deepEqual(variants[0], { kind: "string" });
	const image = variants[1];
	assert.equal(image.kind, "object");
	assert.equal(image.properties.type.const, "image"); // native read's single-image structured result
	for (const key of ["data", "mimeType", "note"]) {
		assert.equal(image.properties[key].kind, "string", `image variant must declare ${key}`);
	}
	const pages = variants[2];
	assert.equal(pages.properties.type.const, "pages");
	assert.equal(pages.properties.images.kind, "array");
});

// keep the import surface honest
void sniffReadFileSync;
