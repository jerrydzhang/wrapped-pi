// Runs with: node --test extensions/tests/worker-inspector.test.ts
// Pure helpers only: worker-inspector.ts keeps its Pi/tui imports behind the
// dynamic UI entry, so this file loads under bare node type stripping.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	clampScrollState,
	formatClock,
	formatElapsed,
	formatKeyLabel,
	initialScrollState,
	isLiveState,
	listActivityContext,
	refollowTail,
	rowSignature,
	sanitizeWorkerText,
	scrollLines,
	scrollToTop,
	stateTone,
	textSignature,
	visibleRange,
	windowLines,
} from "../lib/worker-inspector.ts";

test("sanitizeWorkerText strips terminal controls but keeps newlines and wide chars", () => {
	assert.equal(sanitizeWorkerText(""), "");
	assert.equal(
		sanitizeWorkerText("\x1b[31mred\x1b[0m \x1b[2Jplain\x1b[1;2Htext"),
		"red plaintext",
	);
	assert.equal(sanitizeWorkerText("a\u0007b\u0000c\u007fd\u009be"), "abcde");
	assert.equal(sanitizeWorkerText("one\r\ntwo\rthree\n"), "one\ntwothree\n");
	assert.equal(sanitizeWorkerText("col\tvalue"), "col   value");
	// Wide characters and emoji survive; width handling belongs to the tui helpers.
	assert.equal(sanitizeWorkerText("中文𝕏🚀 ok"), "中文𝕏🚀 ok");
	// A stripped-down ESC that survived VT parsing is still dropped.
	assert.equal(sanitizeWorkerText("a\x1bb"), "ab");
});

test("formatElapsed and formatClock are compact and zero-padded", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(59_400), "59s");
	assert.equal(formatElapsed(60_000), "1m00s");
	assert.equal(formatElapsed(125_400), "2m05s");
	assert.equal(formatElapsed(-5), "0s");
	assert.equal(formatElapsed(3_600_000), "60m00s");
	// 2026-01-05T09:07:03 local — pad every field.
	const stamp = new Date(2026, 0, 5, 9, 7, 3).getTime();
	assert.equal(formatClock(stamp), "09:07:03");
});

test("stateTone buckets parent state vocabulary without guessing on unknowns", () => {
	assert.equal(stateTone("failed"), "error");
	assert.equal(stateTone("RPC protocol failure"), "error");
	assert.equal(stateTone("stopping"), "warning");
	assert.equal(stateTone("stopped at its deadline"), "warning");
	assert.equal(stateTone("running"), "accent");
	assert.equal(stateTone("working"), "accent");
	assert.equal(stateTone("starting"), "accent");
	assert.equal(stateTone("compacting"), "accent");
	assert.equal(stateTone("idle"), "success");
	assert.equal(stateTone("exited"), "success");
	assert.equal(stateTone("ready for another message"), "success");
	assert.equal(stateTone("something else entirely"), "muted");
	// Attention states warn: pending jobs, blocked on input, a run cut short
	// while the process lives. An empty turn is an anomaly, not a success.
	assert.equal(stateTone("waiting"), "warning");
	assert.equal(stateTone("input"), "warning");
	assert.equal(stateTone("interrupted"), "warning");
	assert.equal(stateTone("unexplained"), "error");
	assert.equal(stateTone("Waiting on bg-2, bg-3 (auto-resume)"), "warning", "phrases bucket like their keyword");
	assert.equal(stateTone("turn unexplained"), "error");
	assert.equal(isLiveState("running"), true);
	assert.equal(isLiveState("stopping"), true);
	assert.equal(isLiveState("exited"), false);
	assert.equal(isLiveState("idle"), true);
	assert.equal(isLiveState("failed"), true, "a failed turn can still have a live process");
	assert.equal(isLiveState("stopped"), false);
	assert.equal(isLiveState("waiting"), true, "a worker waiting on jobs is addressable");
	assert.equal(isLiveState("input"), true, "a worker waiting for parent/human input is addressable");
	assert.equal(isLiveState("interrupted"), true, "an aborted run with a live process is addressable");
	assert.equal(isLiveState("unexplained"), true);
});

test("listActivityContext surfaces parent context only for attention states", () => {
	assert.equal(listActivityContext("waiting", "bg-2, bg-3 pending (auto-resume)"), "bg-2, bg-3 pending (auto-resume)");
	assert.equal(listActivityContext("input", "  asked: which model?  "), "asked: which model?");
	assert.equal(listActivityContext("interrupted", "run aborted; process alive"), "run aborted; process alive");
	assert.equal(listActivityContext("unexplained", "no reply, no jobs, no message"), "no reply, no jobs, no message");
	assert.equal(listActivityContext("waiting", undefined), "");
	assert.equal(listActivityContext("waiting", "   "), "");
	assert.equal(listActivityContext("working", "compiling"), "", "activity stays out of non-attention rows");
	assert.equal(listActivityContext("idle", "ready for another message"), "");
	assert.equal(listActivityContext("stopped", "conversation closed"), "");
	// One line only: whitespace collapses and controls strip.
	assert.equal(listActivityContext("waiting", "bg-1\tpending\ndefault"), "bg-1 pending default");
	assert.equal(listActivityContext("waiting", "\x1b[31mbg-1\x1b[0m"), "bg-1");
	// The known waiting label compacts for the list so a standard-width row
	// names the bg id and automatic resumption together; detail stays full.
	assert.equal(listActivityContext("waiting", "waiting on background work: bg-1; resumes automatically"), "bg-1 (auto-resume)");
	assert.equal(listActivityContext("waiting", "waiting on background work: bg-1, bg-2; resumes automatically"), "bg-1, bg-2 (auto-resume)");
	assert.equal(listActivityContext("waiting", "waiting on\nbackground work: bg-1;   resumes automatically"), "bg-1 (auto-resume)", "compaction applies after whitespace collapse");
	assert.equal(
		listActivityContext("waiting", "waiting on background work: bg-1; resumes manually"),
		"waiting on background work: bg-1; resumes manually",
		"unknown labels pass through verbatim - nothing is decided from text",
	);
	assert.equal(
		listActivityContext("input", "waiting for input after message; no background work pending"),
		"waiting for input after message; no background work pending",
	);
});

test("textSignature and rowSignature detect the changes the view depends on", () => {
	assert.equal(textSignature("abc"), textSignature("abc"));
	assert.notEqual(textSignature("abc"), textSignature("abd"));
	assert.notEqual(textSignature("abc"), textSignature("abcd"));

	const rows = [
		{ id: "bg-1", kind: "bash", state: "running", task: "sleep", startedAt: 1, transcript: "a", logPath: "/x" },
		{ id: "sa-2", kind: "subagent", state: "working", task: "refactor", startedAt: 2, transcript: "b", logPath: "/y" },
	] as const;
	const base = rowSignature([...rows]);
	assert.equal(base, rowSignature([...rows]));
	assert.notEqual(
		base,
		rowSignature([{ ...rows[0], state: "exited" }, rows[1]]),
		"state change must change the signature",
	);
	assert.notEqual(
		base,
		rowSignature([{ ...rows[0], transcript: "a\nb" }, rows[1]]),
		"transcript growth must change the signature",
	);
	assert.notEqual(
		base,
		rowSignature([{ ...rows[0], activity: "compiling" }, rows[1]]),
		"activity change must change the signature",
	);
	assert.notEqual(base, rowSignature([rows[1], ...rows.slice(0, 1)]), "order matters like the display");
});

test("visibleRange keeps the selected row inside a sliding window", () => {
	assert.deepEqual(visibleRange(5, 4, 10), { start: 0, end: 5 });
	assert.deepEqual(visibleRange(0, 0, 5), { start: 0, end: 0 });
	assert.deepEqual(visibleRange(100, 0, 8), { start: 0, end: 8 });
	assert.deepEqual(visibleRange(100, 7, 8), { start: 0, end: 8 });
	assert.deepEqual(visibleRange(100, 8, 8), { start: 1, end: 9 });
	assert.deepEqual(visibleRange(100, 99, 8), { start: 92, end: 100 });
});

test("scroll state: follow tail by default, break on scroll up, re-engage at the bottom", () => {
	const content = 100;
	const viewport = 10;
	const start = initialScrollState();
	assert.equal(start.followTail, true);

	// While following, scrolling up starts from the tail: 99-10=90, minus 5 → 85.
	const up = scrollLines(start, -5, content, viewport);
	assert.deepEqual(up, { scrollTop: 85, followTail: false });

	// Scrolling down without reaching the bottom keeps follow broken.
	const down = scrollLines(up, 3, content, viewport);
	assert.deepEqual(down, { scrollTop: 88, followTail: false });

	// Reaching the bottom re-engages follow; the explicit End does too.
	assert.deepEqual(scrollLines(down, 2, content, viewport), { scrollTop: 90, followTail: true });
	assert.deepEqual(refollowTail(content, viewport), { scrollTop: 90, followTail: true });

	// Overscroll clamps at both ends.
	assert.deepEqual(scrollLines(start, -500, content, viewport), { scrollTop: 0, followTail: false });
	assert.deepEqual(scrollLines(up, 500, content, viewport), { scrollTop: 90, followTail: true });

	// Content that fits always reports the tail, whatever the caller does.
	assert.deepEqual(scrollLines(start, -3, 5, viewport), { scrollTop: 0, followTail: true });
	assert.deepEqual(clampScrollState({ scrollTop: 40, followTail: false }, 5, viewport), {
		scrollTop: 0,
		followTail: true,
	});
	// A follow state snaps to the tail even when its offset is stale.
	assert.deepEqual(clampScrollState({ scrollTop: 0, followTail: true }, content, viewport), {
		scrollTop: 90,
		followTail: true,
	});

	// Shrunken content clamps a stale offset but keeps the user's unfollowed state.
	assert.deepEqual(clampScrollState({ scrollTop: 40, followTail: false }, 50, viewport), {
		scrollTop: 40,
		followTail: false,
	});

	assert.deepEqual(scrollToTop(), { scrollTop: 0, followTail: false });
});

test("windowLines slices by viewport; follow takes the last page", () => {
	const lines = Array.from({ length: 26 }, (_, i) => `L${i}`);
	assert.deepEqual(windowLines(lines, initialScrollState(), 10), lines.slice(16));
	assert.deepEqual(windowLines(lines, { scrollTop: 3, followTail: false }, 10), lines.slice(3, 13));
	// Stale offsets clamp against content length.
	assert.deepEqual(windowLines(lines, { scrollTop: 99, followTail: false }, 10), lines.slice(16));
	assert.deepEqual(windowLines([], initialScrollState(), 10), []);
	assert.deepEqual(windowLines(["only"], { scrollTop: 9, followTail: false }, 10), ["only"]);
});

test("formatKeyLabel renders configured key text compactly", () => {
	assert.equal(formatKeyLabel("up"), "up");
	assert.equal(formatKeyLabel("down"), "down");
	assert.equal(formatKeyLabel("pageUp"), "PgUp");
	assert.equal(formatKeyLabel("pageDown"), "PgDn");
	assert.equal(formatKeyLabel("escape"), "Esc");
	assert.equal(formatKeyLabel("ctrl+pageUp"), "ctrl+PgUp");
	assert.equal(formatKeyLabel("enter"), "enter");
	assert.equal(formatKeyLabel("escape/ctrl+c"), "Esc/ctrl+c");
});
