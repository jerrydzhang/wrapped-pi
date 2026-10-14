# pdf-read extension

Extends Pi's `read` tool with local PDF support, powered only by Poppler
(`pdftotext`, `pdftoppm`, `pdfinfo` from poppler-utils). Non-PDF reads are
delegated unchanged to Pi's built-in read definition: same parameters, same
errors, same image handling. Independently authored for the pinned Pi
extension API; single file, zero npm dependencies.

## What changes for the model

- **PDFs are detected by content, anchored at the start of the file** — the
  first kilobyte is read through a bounded file-handle probe (never the whole
  file) and must BEGIN with the `%PDF-` magic. Ordinary text files that merely
  mention `%PDF-` (source code, docs) are read as text; a malformed PDF with
  junk before its header is likewise delegated rather than guessed.
- **`mode: "text"` (default)** — extracts the text layer with `pdftotext`.
  Physical page boundaries are preserved as form-feed characters (`\f`, one
  per page end) and each page is labeled with a `--- PDF page N ---` line
  where `N` is the physical PDF page number. Physical page numbers are never
  equated with printed page labels (a paper's "page 3" may be PDF page 5).
- **`mode: "image"`** — renders full pages to PNG with `pdftoppm` at 130 dpi,
  one image block per page, each preceded by a `PDF page N:` text label. At
  most 8 pages per read; multi-page documents must say which `pages` they
  want. A PNG larger than 3.5 MB is re-rendered at 100, then 80 dpi; a page
  that is still too large is skipped with a stated reason instead of sent
  oversized.
- **`pages`** — optional selection of physical pages: `"3"`, `"2-5"`,
  `"1,4-6"`. Default is all pages for text; image mode requires a selection
  when the document has more than 8 pages. Selections are validated against
  the document's real page count (via `pdfinfo`) and rejected with the actual
  count when out of range. Optional fields treat null-ish values (`null`, the
  strings `"null"`/`"undefined"`, or `""`) as *not supplied* — a model that
  spells "omitted" instead of omitting still gets the default read on the
  first call; any other value is validated on its merits and rejected with a
  specific message.
- **`offset` / `limit`** keep their native meaning: line-based pagination over
  the assembled text output (header and page labels included), with the same
  2000-line / 50KB truncation contract and `Use offset=N to continue`
  footers. Boundary conventions models actually send are absorbed: `offset`
  `0` reads from the start, `limit` `0` means no limit; a `limit` that stops
  before the end reports the remaining lines and the next offset exactly like
  the native read. Negative or non-numeric values are rejected with specific
  messages. They are rejected in image mode, where lines do not exist.

## Honesty rules

- Thin or absent text layers are flagged in the output header with a
  suggestion to use `mode:"image"` — scanned or figure-only pages do not
  silently return emptiness, and the flag sits where truncation cannot hide
  it.
- Extracted text is not authoritative for math, tables, or reading order.
  Equations without a text layer are invisible to `pdftotext` by design;
  `mode:"image"` plus a vision model is the complement, not a guarantee.
- The page-boundary count from `pdftotext` is cross-checked against the
  requested page count; a mismatch is an error, never silent mislabeling.
- Encrypted PDFs and corrupt/unparsable files produce specific error
  messages; a missing Poppler executable says how the release build supplies
  it (`WRAPPED_PI_POPPLER_BIN`).
- Nothing is cached: every invocation spawns fresh processes over the
  current bytes, so re-reading the same path after a LaTeX recompile shows
  the new content.

## Operational bounds

Per-invocation subprocess timeouts: `pdfinfo` 10s, `pdftotext` 60s,
`pdftoppm` 120s. Cancellation kills the subprocesses. Render files live in a
unique temp directory that is removed when the call ends, success or failure.
All Poppler invocations are argv-array `execFile` calls; no shell intervenes.

## Packaging

In the wrapped-pi release build, Poppler comes from the flake package
closure and the wrapper exports `WRAPPED_PI_POPPLER_BIN` pointing at the
store path — the host's PATH is never consulted for Poppler, and nothing is
downloaded at run time. Development (plain `pi -e extensions/pdf-read.ts`)
falls back to whatever `pdftotext`/`pdftoppm`/`pdfinfo` are on PATH.

## Loading

Run `nix run .` to launch wrapped-pi with this extension bundled; the read
override replaces the built-in read for this session. For source development,
load it directly with plain Pi: `pi -e extensions/pdf-read.ts` (path relative
to this repo).

## Tests

```
node --test extensions/tests/pdf-read.test.ts            # logic suite (bare node)
node --test extensions/tests/pdf-read.poppler.test.ts    # real Poppler; skips when absent
```

The logic suite fakes Poppler at the exec boundary: delegation of non-PDF
reads, anchored content-based PDF detection (including the extension's own
source and docs, which mention `%PDF-` and must delegate), the bounded-sniff
memory bound on a sparse 128MiB probe, page validation and provenance, line
pagination and both continuation footers, null-ish optional normalization at
the boundary (default reads succeed when a model null-fills optionals, while
garbage selections still fail specifically), image bounds and dpi backoff,
failure mapping, temp cleanup, schema shape (native image variant, text
string, pages object), and fresh reads of changed contents. The Poppler
suite generates minimal probe PDFs in a temp dir at run time (no papers are
tracked in the repo, nothing is uploaded) and exercises extraction, page
selection, rendering, corruption, source-file delegation, the explicit-limit
footer, and cold latency as single-run observations.
