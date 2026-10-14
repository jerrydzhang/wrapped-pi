// Runs with: node --test extensions/tests/pdf-read.poppler.test.ts
// Real Poppler against probe PDFs generated in a temp dir at run time —
// no papers are tracked in the repo and nothing is uploaded. Skips
// gracefully when poppler-utils is not on PATH (nix flake check runs it
// with poppler_utils in nativeBuildInputs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { executeRead, runReadPdf, type ContentBlock } from "../pdf-read.ts";

const execFile = promisify(execFileCb);

async function popplerAvailable(): Promise<boolean> {
	try {
		await execFile("pdfinfo", ["-v"]);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

const havePoppler = await popplerAvailable();

function escapePdfText(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// Minimal xref-correct single-font PDF: one page per entry, each line drawn
// with Helvetica at 12pt. ASCII only.
export function buildPdf(pages: string[]): Buffer {
	const objects: (string | undefined)[] = [];
	const pageIds = pages.map((_, i) => 4 + i * 2);
	const contentIds = pages.map((_, i) => 5 + i * 2);
	objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
	objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
	objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
	pages.forEach((text, i) => {
		const lines = text.split("\n");
		const stream = lines
			.map((line, li) => `BT /F1 12 Tf 72 ${720 - li * 16} Td (${escapePdfText(line)}) Tj ET`)
			.join("\n");
		objects[pageIds[i]] =
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
		objects[contentIds[i]] = `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`;
	});
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	const maxId = objects.length - 1;
	for (let id = 1; id <= maxId; id++) {
		if (!objects[id]) continue;
		offsets[id] = Buffer.byteLength(out, "latin1");
		out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
	}
	const xrefPos = Buffer.byteLength(out, "latin1");
	let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
	for (let id = 1; id <= maxId; id++) {
		xref += objects[id] !== undefined ? `${String(offsets[id]).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
	}
	out += xref + `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

function textOf(outcome: { content: ContentBlock[] }): string {
	return (outcome.content[0] as { text: string }).text;
}

if (!havePoppler) {
	test("poppler integration (skipped: poppler-utils not on PATH)", { skip: true }, () => {});
} else {
	// --- regressions for review findings 1 and 4 (anchored detection, limit footer) ---

	test("anchored detection: the extension source mentions %PDF- yet delegates", async () => {
		// executeRead (the real PDF-branch decision) on the extension's own source —
		// substring sniffing misrouted this file to Poppler.
		const sourcePath = fileURLToPath(new URL("../pdf-read.ts", import.meta.url));
		const head = (await readFile(sourcePath)).subarray(0, 1024);
		assert.ok(head.includes("%PDF-"), "fixture precondition: source mentions %PDF- in its first KiB");
		let delegated = 0;
		const outcome = await executeRead("c", { path: sourcePath }, undefined, undefined, undefined, {
			builtinRead: async () => {
				delegated++;
				return { content: [{ type: "text", text: "delegated to builtin" }], details: undefined };
			},
		});
		assert.equal(delegated, 1);
		assert.match((outcome.content[0] as { text: string }).text, /delegated to builtin/);

		// ...while a real generated PDF still routes to Poppler.
		const dir = await mkdtemp(join(tmpdir(), "pdf-poppler-"));
		const pdf = join(dir, "real.pdf");
		await writeFile(pdf, buildPdf(["this one is a genuine pdf"]));
		const outcomePdf = await executeRead("c", { path: pdf }, undefined, undefined, { cwd: dir }, {
			builtinRead: async () => {
				throw new Error("must not delegate a real PDF");
			},
		});
		assert.match((outcomePdf.content[0] as { text: string }).text, /genuine pdf/);
		await rm(dir, { recursive: true, force: true });
	});

	test("real Poppler: explicit limit carries the native continuation footer", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdf-poppler-"));
		const pdf = join(dir, "probe.pdf");
		await writeFile(pdf, buildPdf([
			"page one full of words",
			"page two full of words",
			"page three full of words",
		]));
		const full = await runReadPdf({ path: pdf }, { ctx: { cwd: dir } });
		const total = textOf(full).split("\n").length;
		const limited = await runReadPdf({ path: pdf, limit: 4 }, { ctx: { cwd: dir } });
		const limitedText = textOf(limited);
		assert.ok(limitedText.split("\n").length < total);
		assert.match(
			limitedText,
			new RegExp(`\\[${total - 4} more lines in output\\. Use offset=5 to continue\\.\\]`),
		);
		// and a limit reaching the end stays footer-free
		const toEnd = await runReadPdf({ path: pdf, limit: total }, { ctx: { cwd: dir } });
		assert.doesNotMatch(textOf(toEnd), /more lines in output/);
		await rm(dir, { recursive: true, force: true });
	});
	test("real Poppler: whole-document text extraction with provenance and form feeds", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdf-poppler-"));
		const pdf = join(dir, "probe.pdf");
		await writeFile(pdf, buildPdf([
			"Probe page one: alpha beta gamma",
			"Probe page two: delta epsilon",
			"Probe page three: zeta eta theta",
		]));
		const outcome = await runReadPdf({ path: pdf }, { ctx: { cwd: dir } });
		const text = textOf(outcome);
		assert.match(text, /^\[PDF text: probe\.pdf \(3 physical pages\) — extracting pages 1-3\]/);
		assert.match(text, /--- PDF page 1 ---\n.*alpha beta gamma/);
		assert.match(text, /--- PDF page 2 ---\n.*delta epsilon/);
		assert.match(text, /--- PDF page 3 ---\n.*zeta eta theta/);
		assert.equal((text.match(/\f/g) ?? []).length, 3);
		const details = outcome.details as { pageCount: number; extractedChars: number };
		assert.equal(details.pageCount, 3);
		assert.ok(details.extractedChars > 30);
		await rm(dir, { recursive: true, force: true });
	});

	test("real Poppler: page selection extracts exactly the requested physical pages", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdf-poppler-"));
		const pdf = join(dir, "probe.pdf");
		await writeFile(pdf, buildPdf([
			"one unique ostrich",
			"two unique tigers",
			"three unique urchins",
			"four unique vultures",
		]));
		const outcome = await runReadPdf({ path: pdf, pages: "2-3" }, { ctx: { cwd: dir } });
		const text = textOf(outcome);
		assert.match(text, /extracting pages 2-3\]/);
		assert.match(text, /two unique tigers/);
		assert.match(text, /three unique urchins/);
		assert.doesNotMatch(text, /ostrich|vultures/);
		assert.doesNotMatch(text, /PDF page 1 ---/);
		await rm(dir, { recursive: true, force: true });
	});

	test("real Poppler: out-of-range and zero page selections are rejected", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdf-poppler-"));
		const pdf = join(dir, "probe.pdf");
		await writeFile(pdf, buildPdf(["only page"]));
		await assert.rejects(runReadPdf({ path: pdf, pages: "5" }, { ctx: { cwd: dir } }), /has 1 physical page/);
		await assert.rejects(runReadPdf({ path: pdf, pages: "0" }, { ctx: { cwd: dir } }), /1-indexed/);
		await rm(dir, { recursive: true, force: true });
	});

	test("real Poppler: empty text layer is flagged with the image-mode suggestion", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdf-poppler-"));
		const pdf = join(dir, "scanlike.pdf");
		// page 1 empty, page 2 has real text, page 3 empty
		await writeFile(pdf, buildPdf(["", "visible words here", ""]));
		const outcome = await runReadPdf({ path: pdf }, { ctx: { cwd: dir } });
		const text = textOf(outcome);
		assert.match(text, /no extractable text on pages 1, 3.*mode:"image"/s);
		assert.match(text, /visible words here/);
		await rm(dir, { recursive: true, force: true });
	});

	test("real Poppler: image mode renders PNGs with physical page labels", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdf-poppler-"));
		const pdf = join(dir, "probe.pdf");
		await writeFile(pdf, buildPdf(["renderable text alpha", "renderable text beta"]));
		const tmpRoot = await mkdtemp(join(tmpdir(), "pdf-poppler-tmp-"));
		const outcome = await runReadPdf(
			{ path: pdf, pages: "1-2", mode: "image" },
			{ ctx: { cwd: dir }, tmpRoot },
		);
		const images = outcome.content.filter((b) => b.type === "image");
		assert.equal(images.length, 2);
		const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		for (const img of images as Array<{ type: "image"; data: string; mimeType?: string }>) {
			assert.equal(img.mimeType, "image/png");
			const bytes = Buffer.from(img.data, "base64");
			assert.equal(PNG_MAGIC.compare(bytes.subarray(0, 8)), 0);
			assert.ok(bytes.length > 1000, "rendered page suspiciously small");
		}
		const header = (outcome.content[0] as { text: string }).text;
		assert.match(header, /Rendered 2 PDF pages from probe\.pdf at 130 dpi \(PNG\): 1-2\./);
		// no temp render files survive
		assert.equal((await readdir(tmpRoot)).length, 0);
		await rm(dir, { recursive: true, force: true });
		await rm(tmpRoot, { recursive: true, force: true });
	});

	test("real Poppler: corrupt file maps to a useful error", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdf-poppler-"));
		const pdf = join(dir, "corrupt.pdf");
		await writeFile(pdf, Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(512, 0x00), Buffer.from("truncated mid-xref")]));
		await assert.rejects(
			runReadPdf({ path: pdf }, { ctx: { cwd: dir } }),
			/corrupt|could not determine the page count/,
		);
		await rm(dir, { recursive: true, force: true });
	});

	test("real Poppler: contents replaced at the same path are read fresh", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdf-poppler-"));
		const pdf = join(dir, "recompiled.pdf");
		await writeFile(pdf, buildPdf(["LaTeX draft version one"]));
		const first = await runReadPdf({ path: pdf }, { ctx: { cwd: dir } });
		assert.match(textOf(first), /LaTeX draft version one/);
		await writeFile(pdf, buildPdf(["LaTeX draft version two"]));
		const second = await runReadPdf({ path: pdf }, { ctx: { cwd: dir } });
		const secondText = textOf(second);
		assert.match(secondText, /LaTeX draft version two/);
		assert.doesNotMatch(secondText, /version one/);
		await rm(dir, { recursive: true, force: true });
	});

	test("real Poppler: null-filled optionals still produce the default whole-PDF read", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdf-poppler-"));
		const pdf = join(dir, "probe.pdf");
		await writeFile(pdf, buildPdf(["nullish optionals probe page one", "nullish optionals probe page two"]));
		const outcome = await runReadPdf(
			{ path: pdf, pages: "null", mode: "null", offset: "null", limit: "null" } as Parameters<typeof runReadPdf>[0],
			{ ctx: { cwd: dir } },
		);
		const text = textOf(outcome);
		assert.match(text, /extracting pages 1-2\]/);
		assert.match(text, /nullish optionals probe page one/);
		assert.match(text, /nullish optionals probe page two/);
		await rm(dir, { recursive: true, force: true });
	});

	test("real Poppler: cold process-per-read latency (single-run observation)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdf-poppler-"));
		const pdf = join(dir, "probe.pdf");
		await writeFile(pdf, buildPdf([
			"latency probe page one with some words",
			"latency probe page two with more words",
		]));
		// text read (pdfinfo + pdftotext, one process each)
		const t0 = performance.now();
		await runReadPdf({ path: pdf }, { ctx: { cwd: dir } });
		const textMs = Math.round(performance.now() - t0);
		// image read (pdfinfo + pdftoppm, one page)
		const t1 = performance.now();
		await runReadPdf({ path: pdf, pages: "1", mode: "image" }, { ctx: { cwd: dir } });
		const imageMs = Math.round(performance.now() - t1);
		console.log(`[latency] cold process-per-read, single-run observation on 2-page probe: text ${textMs}ms, 1-page image ${imageMs}ms`);
		assert.ok(textMs < 60_000);
		assert.ok(imageMs < 120_000);
		await rm(dir, { recursive: true, force: true });
	});
}
