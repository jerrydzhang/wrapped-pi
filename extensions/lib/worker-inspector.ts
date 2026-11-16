// Human-facing live inspector over parent-provided worker rows. Independently
// authored for pinned Pi 1.5.2: only openWorkerInspector touches Pi, and the
// pi-tui import stays dynamic inside that entry so bare-node tests can load
// the pure helpers without resolving Pi packages. The parent owns the rows:
// it rebuilds them on demand and bounds transcripts externally; this module
// never appends session entries, sends messages, or touches model context.
import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionCommandContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

/** One live worker as the parent sees it. Rows are rebuilt on every call. */
export interface InspectorRow {
	id: string;
	kind: "bash" | "subagent";
	state: string;
	task: string;
	model?: string;
	/** Parent-provided one-line status. For waiting/input/unexplained/
	 *  interrupted rows the list surfaces it beside the task, so pending bg
	 *  ids and auto-resume are identifiable without opening the detail. */
	activity?: string;
	startedAt: number;
	endedAt?: number;
	/** Externally bounded; may still be large, so the inspector wraps it lazily. */
	transcript: string;
	logPath: string;
}

export interface WorkerInspectorOptions {
	/** Fresh rows on every call: the inspector polls this and keeps no row cache. */
	rows: () => InspectorRow[];
	/** Open directly on this worker's transcript when it exists in the first rows. */
	initialId?: string;
	/** Deliver a composed message to a worker; errors are caught and shown, never thrown. */
	send: (id: string, text: string) => Promise<void>;
	/** Terminate a worker or command group; errors are caught and shown, never thrown. */
	stop: (id: string) => Promise<void>;
}

type TuiModule = typeof import("@earendil-works/pi-tui");

const TICK_MS = 1000;
const MIN_LIST_ROWS = 3;
const MAX_LIST_ROWS = 40;
const MAX_DETAIL_VIEWPORT = 200;
const MAX_WRAPPED_LINES = 4000;
const ID_COL = 9;
const KIND_COL = 9;
const STATE_COL = 11;
const ELAPSED_COL = 8;
// Below this the fixed columns would crowd out the one field that matters.
const COMPACT_WIDTH = 46;
const COMPACT_ID_COL = 7;
const TAB_WIDTH = 3;

// ============================================================================
// Pure helpers (unit-tested; no Pi or terminal dependencies)
// ============================================================================

/** Controls that are never legitimate text: C0 except \n and \t, DEL, C1. */
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Make child/user text safe for the inspector's own rendering path: strip VT
 * escape sequences (node's stripVTControlCharacters), fold CR variants to \n,
 * drop every other control character, and expand tabs the way pi-tui measures
 * them (three columns). Wide characters are preserved; width handling is the
 * caller's job via the tui width helpers.
 */
export function sanitizeWorkerText(text: string): string {
	if (!text) return "";
	let out = stripVTControlCharacters(text);
	out = out.replace(/\r\n/g, "\n").replace(/\r/g, "");
	out = out.replace(UNSAFE_CONTROLS, "");
	out = out.replace(/\t/g, " ".repeat(TAB_WIDTH));
	return out;
}

/** Compact elapsed time, repo convention: 45s, 2m03s. Negative clamps to 0s. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Local wall clock, stable zero-padded HH:MM:SS (locale-independent). */
export function formatClock(timestamp: number): string {
	const date = new Date(timestamp);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export type StateTone = "accent" | "warning" | "error" | "success" | "muted";

/**
 * Map a parent-provided state string to a theme color. Pattern-based because
 * the parent owns state vocabulary; unknown states stay muted rather than
 * guessing a vivid color. Waiting on jobs or input warns (attention, not
 * failure); a run cut short while the process lives warns too; a turn that
 * ended with nothing to show is an anomaly and errors.
 */
export function stateTone(state: string): StateTone {
	const s = String(state).toLowerCase();
	if (/(fail|error|abort|unexplained)/.test(s)) return "error";
	if (/(stop|kill|cancel|timeout|waiting|input|interrupt)/.test(s)) return "warning";
	if (/(run|work|start|stream|think|respond|retry|compact|busy)/.test(s)) return "accent";
	if (/(idle|exit|finish|done|complete|ready|success)/.test(s)) return "success";
	return "muted";
}

/** Addressable workers are alive: active, parked after a turn, waiting on
 *  jobs or input, or a failed/interrupted turn the process survived. Terminal
 *  outcomes are not. */
export function isLiveState(state: string): boolean {
	return /^(starting|working|running|stopping|idle|failed|waiting|input|interrupted|unexplained)$/.test(
		state.toLowerCase(),
	);
}

/** Attention states whose list row must identify what is pending (bg ids,
 *  auto-resume) via the parent-provided activity. */
const LIST_CONTEXT_STATES = /^(waiting|input|unexplained|interrupted)$/;

/**
 * One-line pending-job context for a list row: the parent's activity, shown
 * only for attention states, sanitized and collapsed to a single line. The
 * known waiting label compacts so the bg id and automatic resumption both
 * fit a standard-width list row; every other label passes through verbatim.
 * Presentation only - nothing is decided from the text. The detail view
 * always shows the parent's full activity.
 */
const COMPACT_WAITING = /^waiting on background work: (.+); resumes automatically$/;

export function listActivityContext(state: string, activity: string | undefined): string {
	if (typeof activity !== "string" || !LIST_CONTEXT_STATES.test(String(state).toLowerCase())) return "";
	const text = sanitizeWorkerText(activity).replace(/\s+/g, " ").trim();
	const waiting = COMPACT_WAITING.exec(text);
	const ids = waiting === null ? "" : waiting[1]!.trim();
	return waiting === null || ids === "" ? text : `${ids} (auto-resume)`;
}

/** FNV-1a plus length: cheap change detection for large transcript strings. */
export function textSignature(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${(hash >>> 0).toString(36)}:${text.length}`;
}

/** Per-row change marker for refresh ticks; order-sensitive like the display. */
export function rowSignature(rows: readonly InspectorRow[]): string {
	return rows
		.map((row) =>
			[
				row.id ?? "",
				row.kind ?? "",
				row.state ?? "",
				row.model ?? "",
				row.activity ?? "",
				String(row.startedAt ?? 0),
				row.task ?? "",
				textSignature(typeof row.transcript === "string" ? row.transcript : ""),
			].join("\u001f"),
		)
		.join("\u001e");
}

/** Scroll-on-demand window for the list: `selected` always stays inside. */
export function visibleRange(
	count: number,
	selected: number,
	maxVisible: number,
): { start: number; end: number } {
	if (maxVisible <= 0 || count <= 0) return { start: 0, end: 0 };
	if (count <= maxVisible) return { start: 0, end: count };
	const sel = Math.max(0, Math.min(Math.trunc(selected), count - 1));
	const start = Math.max(0, Math.min(sel - (maxVisible - 1), count - maxVisible));
	return { start, end: start + maxVisible };
}

export interface ScrollState {
	scrollTop: number;
	followTail: boolean;
}

export function initialScrollState(): ScrollState {
	return { scrollTop: 0, followTail: true };
}

function maxScrollTop(contentLines: number, viewportLines: number): number {
	return Math.max(0, Math.trunc(contentLines) - Math.max(1, Math.trunc(viewportLines)));
}

/** Normalize a scroll state against current content: fits means follow, and
 *  follow means at the tail - a stale offset snaps to the end. */
export function clampScrollState(
	state: ScrollState,
	contentLines: number,
	viewportLines: number,
): ScrollState {
	const max = maxScrollTop(contentLines, viewportLines);
	if (max === 0) return { scrollTop: 0, followTail: true };
	if (state.followTail) return { scrollTop: max, followTail: true };
	const scrollTop = Math.max(0, Math.min(Math.trunc(state.scrollTop), max));
	return { scrollTop, followTail: false };
}

/**
 * Scroll by signed lines. Away from the tail always breaks follow; scrolling
 * back down to the bottom re-engages it (End is the explicit re-follow).
 */
export function scrollLines(
	state: ScrollState,
	delta: number,
	contentLines: number,
	viewportLines: number,
): ScrollState {
	const max = maxScrollTop(contentLines, viewportLines);
	if (max === 0) return { scrollTop: 0, followTail: true };
	const start = state.followTail ? max : state.scrollTop;
	const scrollTop = Math.max(0, Math.min(Math.trunc(start) + Math.trunc(delta), max));
	const followTail = delta < 0 ? false : scrollTop >= max ? true : state.followTail;
	return { scrollTop, followTail };
}

/** Jump to the live tail and re-engage follow. */
export function refollowTail(contentLines: number, viewportLines: number): ScrollState {
	return { scrollTop: maxScrollTop(contentLines, viewportLines), followTail: true };
}

/** Jump to the top and release follow. */
export function scrollToTop(): ScrollState {
	return { scrollTop: 0, followTail: false };
}

/** The viewport slice for a scroll state; follow takes the last page. */
export function windowLines(
	lines: readonly string[],
	state: ScrollState,
	viewportLines: number,
): string[] {
	const height = Math.max(1, Math.trunc(viewportLines));
	if (lines.length === 0) return [];
	if (state.followTail) return lines.slice(Math.max(0, lines.length - height));
	const start = Math.max(0, Math.min(Math.trunc(state.scrollTop), lines.length - height));
	return lines.slice(start, start + height);
}

/** Compact display text for one configured key ("ctrl+pageUp" -> "ctrl+PgUp").
 *  Plain letters and modifiers stay lowercase, as pi's own hints render them. */
export function formatKeyLabel(key: string): string {
	const pretty = (part: string): string => {
		if (part === "pageUp") return "PgUp";
		if (part === "pageDown") return "PgDn";
		if (part === "escape") return "Esc";
		if (part === "up") return "up";
		if (part === "down") return "down";
		return part;
	};
	return key
		.split("/")
		.map((k) => k.split("+").map(pretty).join("+"))
		.join("/");
}

// ============================================================================
// Inspector component
// ============================================================================

class WorkerInspectorComponent implements Component {
	private closed = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private view: "list" | "detail" = "list";
	private rows: InspectorRow[] = [];
	private rowsError: string | undefined;
	private selectedId: string | undefined;
	private scroll: ScrollState = initialScrollState();
	private busy = new Map<string, "sending" | "stopping">();
	private now = Date.now();
	private version = 1;
	private cacheWidth = -1;
	private cacheVersion = -1;
	private cacheLines: string[] = [];
	/** Wrapped transcript per row: unstyled content, so only width/signature key it. */
	private wrapped = new Map<string, { sig: string; width: number; lines: string[] }>();

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly m: TuiModule;
	private readonly ctx: ExtensionCommandContext;
	private readonly options: WorkerInspectorOptions;
	private readonly done: () => void;

	constructor(params: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		tuiModule: TuiModule;
		ctx: ExtensionCommandContext;
		options: WorkerInspectorOptions;
		done: () => void;
	}) {
		this.tui = params.tui;
		this.theme = params.theme;
		this.keybindings = params.keybindings;
		this.m = params.tuiModule;
		this.ctx = params.ctx;
		this.options = params.options;
		this.done = params.done;
		// First rows synchronously, so initialId resolves against real data before
		// the first paint and the timer never drives the opening state.
		this.refresh();
		const initial = this.options.initialId;
		if (initial !== undefined && this.rows.some((row) => row.id === initial)) {
			this.selectedId = initial;
			this.view = "detail";
			this.scroll = initialScrollState();
		} else if (this.rows.length > 0) {
			this.selectedId = this.rows[0]!.id;
		}
		this.timer = setInterval(this.tick, TICK_MS);
		// The TUI and session hold the event loop; an inspector timer must never
		// be the thing keeping the process alive after its dialog is gone.
		this.timer.unref?.();
	}

	private readonly tick = (): void => {
		if (!this.closed) this.refresh();
	};

	// ---- lifecycle ----------------------------------------------------

	private stopTimer(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopTimer();
		this.done();
	}

	/** Host teardown: after done() on close; alone on /reload, which never
	 *  resolves the promise, so cleanup lives here, not after the await. */
	dispose(): void {
		this.closed = true;
		this.stopTimer();
		this.wrapped.clear();
	}

	invalidate(): void {
		// Cached lines carry theme colors; rebuild on next render. The wrap cache
		// holds one styled truncation notice, so it drops too.
		this.version++;
		this.cacheLines = [];
		this.wrapped.clear();
	}

	private bump(): void {
		this.version++;
		this.tui.requestRender();
	}

	// ---- data ----------------------------------------------------------

	private refresh(): void {
		if (this.closed) return;
		this.now = Date.now();
		const previousIndex = this.selectedIndex();
		let fresh: InspectorRow[] | undefined;
		try {
			fresh = this.options.rows();
		} catch (error) {
			this.rowsError = describeError(error);
			this.bump();
			return;
		}
		this.rowsError = undefined;
		this.rows = Array.isArray(fresh)
			? fresh.filter((row) => row !== null && typeof row === "object" && typeof row.id === "string")
			: [];
		if (!Array.isArray(fresh)) {
			this.rowsError = "rows() did not return an array";
			this.bump();
			return;
		}
		const ids = new Set(this.rows.map((row) => row.id));
		for (const key of this.wrapped.keys()) {
			if (!ids.has(key)) this.wrapped.delete(key);
		}
		if (this.rows.length === 0) {
			this.selectedId = undefined;
			if (this.view === "detail") this.view = "list";
		} else {
			const current = this.rows.findIndex((row) => row.id === this.selectedId);
			if (current === -1) {
				// Selection follows the nearest survivor; an inspected worker that
				// vanished returns the user to the list rather than a dead detail.
				const fallback = Math.max(0, Math.min(Math.max(previousIndex, 0), this.rows.length - 1));
				if (this.view === "detail") this.view = "list";
				this.selectedId = this.rows[fallback]!.id;
			} else {
				this.selectedId = this.rows[current]!.id;
			}
		}
		this.bump();
	}

	private selectedIndex(): number {
		if (this.selectedId === undefined) return 0;
		const index = this.rows.findIndex((row) => row.id === this.selectedId);
		return index === -1 ? 0 : index;
	}

	private selectedRow(): InspectorRow | undefined {
		return this.rows.find((row) => row.id === this.selectedId);
	}

	// ---- sizing --------------------------------------------------------

	private terminalRows(): number {
		const rows = this.tui.terminal?.rows;
		return typeof rows === "number" && rows > 0 ? rows : 24;
	}

	private listMaxRows(): number {
		return Math.max(MIN_LIST_ROWS, Math.min(this.terminalRows() - 8, MAX_LIST_ROWS));
	}

	private detailViewport(): number {
		return Math.max(4, Math.min(this.terminalRows() - 11, MAX_DETAIL_VIEWPORT));
	}

	// ---- input ---------------------------------------------------------

	handleInput(data: string): void {
		if (this.closed) return;
		const kb = this.keybindings;
		if (this.view === "list") {
			if (kb.matches(data, "tui.select.up")) {
				this.moveSelection(-1);
			} else if (kb.matches(data, "tui.select.down")) {
				this.moveSelection(1);
			} else if (kb.matches(data, "tui.select.pageUp")) {
				this.moveSelection(-this.listMaxRows());
			} else if (kb.matches(data, "tui.select.pageDown")) {
				this.moveSelection(this.listMaxRows());
			} else if (kb.matches(data, "tui.select.confirm")) {
				this.openDetail();
			} else if (kb.matches(data, "tui.select.cancel") || this.matchesLetters(data, "q", "Q")) {
				this.close();
			} else {
				return;
			}
			this.bump();
			this.tui.requestRender();
			return;
		}

		const row = this.selectedRow();
		if (kb.matches(data, "tui.select.up")) {
			this.scrollDetail(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.scrollDetail(1);
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.scrollDetail(-this.detailViewport());
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.scrollDetail(this.detailViewport());
		} else if (this.m.matchesKey(data, "end")) {
			this.scroll = refollowTail(this.detailContentLines(), this.detailViewport());
		} else if (this.m.matchesKey(data, "home")) {
			this.scroll = scrollToTop();
		} else if (this.matchesLetters(data, "m", "M") && row !== undefined && row.kind !== "bash" && isLiveState(row.state) && !this.busy.has(row.id)) {
			this.compose(row);
			return;
		} else if (this.matchesLetters(data, "x", "X") && row !== undefined && (row.kind === "subagent" || isLiveState(row.state)) && !this.busy.has(row.id)) {
			this.requestStop(row);
			return;
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.view = "list";
			this.scroll = initialScrollState();
		} else if (this.matchesLetters(data, "q", "Q")) {
			this.close();
			return;
		} else {
			return;
		}
		this.bump();
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed || event.type !== "wheel" || event.wheelDelta === undefined || event.wheelDelta === 0) {
			return undefined;
		}
		if (this.view === "list") {
			const before = this.selectedIndex();
			this.moveSelection(event.wheelDelta < 0 ? -1 : 1);
			if (this.selectedIndex() === before) return { handled: true, render: false };
			this.bump();
			return { handled: true, render: true };
		}
		this.scrollDetail(event.wheelDelta);
		this.bump();
		return { handled: true, render: true };
	}

	private matchesLetters(data: string, ...letters: string[]): boolean {
		return letters.some((letter) => this.m.matchesKey(data, letter));
	}

	private moveSelection(delta: number): void {
		if (this.rows.length === 0) return;
		const next = Math.max(0, Math.min(this.selectedIndex() + Math.trunc(delta), this.rows.length - 1));
		this.selectedId = this.rows[next]!.id;
	}

	private openDetail(): void {
		const row = this.selectedRow();
		if (row === undefined) return;
		this.refresh();
		if (this.selectedRow()?.id !== row.id) return;
		this.view = "detail";
		this.scroll = initialScrollState();
	}

	private scrollDetail(delta: number): void {
		this.scroll = scrollLines(this.scroll, delta, this.detailContentLines(), this.detailViewport());
	}

	private detailContentLines(): number {
		const row = this.selectedRow();
		if (row === undefined) return 0;
		return this.wrappedLines(row, this.lastWidth()).length;
	}

	private lastWidth(): number {
		return this.cacheWidth > 0 ? this.cacheWidth : 80;
	}

	// ---- actions -------------------------------------------------------

	private compose(row: InspectorRow): void {
		void (async () => {
			try {
				const text = await this.ctx.ui.editor(`Message to ${sanitizeWorkerText(row.id)}`, "");
				if (this.closed) return;
				if (typeof text !== "string" || text.trim() === "") return;
				if (this.busy.has(row.id)) return;
				this.busy.set(row.id, "sending");
				this.bump();
				try {
					await this.options.send(row.id, text);
					if (!this.closed) this.ctx.ui.notify(`Message sent to ${row.id}.`, "info");
				} catch (error) {
					if (!this.closed) this.ctx.ui.notify(`Send to ${row.id} failed: ${describeError(error)}`, "error");
				} finally {
					this.busy.delete(row.id);
					if (!this.closed) {
						this.refresh();
					}
				}
			} catch (error) {
				// Editor failed to open; the inspector itself stays usable.
				if (!this.closed) this.ctx.ui.notify(`Could not open the message editor: ${describeError(error)}`, "error");
			}
		})();
	}

	private requestStop(row: InspectorRow): void {
		void (async () => {
			let confirmed = false;
			try {
				confirmed = await this.ctx.ui.confirm(
					`Stop ${sanitizeWorkerText(row.id)}?`,
					row.kind === "subagent"
						? "Terminates this worker and removes its conversation from this session. This cannot be undone."
						: "Terminates the bash job's whole process group. This cannot be undone.",
				);
			} catch (error) {
				if (!this.closed) this.ctx.ui.notify(`Could not open the confirm dialog: ${describeError(error)}`, "error");
				return;
			}
			if (this.closed || !confirmed) return;
			if (this.busy.has(row.id)) return;
			this.busy.set(row.id, "stopping");
			this.bump();
			try {
				await this.options.stop(row.id);
				if (!this.closed) this.ctx.ui.notify(`Stop requested for ${row.id}.`, "info");
			} catch (error) {
				if (!this.closed) this.ctx.ui.notify(`Stopping ${row.id} failed: ${describeError(error)}`, "error");
			} finally {
				this.busy.delete(row.id);
				if (!this.closed) {
					this.refresh();
				}
			}
		})();
	}

	// ---- rendering -----------------------------------------------------

	render(width: number): string[] {
		if (this.closed) return [];
		if (width === this.cacheWidth && this.cacheVersion === this.version) return this.cacheLines;
		this.now = Date.now();
		const lines = this.view === "detail" ? this.renderDetail(width) : this.renderList(width);
		this.cacheWidth = width;
		this.cacheVersion = this.version;
		this.cacheLines = lines;
		return lines;
	}

	private cut(text: string, width: number): string {
		return this.m.truncateToWidth(text, Math.max(0, width));
	}

	private pad(text: string, cols: number): string {
		return this.m.truncateToWidth(text, Math.max(0, cols), "", true);
	}

	private rightAlign(text: string, cols: number): string {
		const w = this.m.visibleWidth(text);
		if (w >= cols) return this.m.truncateToWidth(text, cols);
		return `${" ".repeat(cols - w)}${text}`;
	}

	private separator(width: number, label: string): string {
		const labelWidth = this.m.visibleWidth(label);
		const fill = Math.max(0, width - labelWidth - 2);
		const left = Math.floor(fill / 2);
		const right = fill - left;
		return this.cut(this.theme.fg(
			"borderMuted",
			label === ""
				? "-".repeat(Math.max(0, width))
				: `${"-".repeat(left)} ${label} ${"-".repeat(right)}`,
		), width);
	}

	private rowState(row: InspectorRow): string {
		return sanitizeWorkerText(typeof row.state === "string" ? row.state : "unknown");
	}

	private renderBusyLabel(row: InspectorRow | undefined): string {
		if (row === undefined) return "";
		const busy = this.busy.get(row.id);
		if (busy === "sending") return this.theme.fg("warning", "sending... ");
		if (busy === "stopping") return this.theme.fg("warning", "stopping... ");
		return "";
	}

	private renderList(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const total = this.rows.length;
		const live = this.rows.filter((row) => isLiveState(this.rowState(row))).length;
		const noun = total === 1 ? "job" : "jobs";
		let header = th.fg("accent", "workers") + th.fg("muted", ` - ${total} ${noun}, ${live} live`);
		header += th.fg("dim", ` | ${formatClock(this.now)}`);
		lines.push(this.cut(header, width));
		if (this.rowsError !== undefined) {
			lines.push(this.cut(th.fg("error", `rows error: ${this.rowsError}`), width));
		}
		if (total === 0) {
			lines.push(this.cut(th.fg("dim", "no background jobs this session"), width));
		} else {
			const maxRows = this.listMaxRows();
			const selected = this.selectedIndex();
			const { start, end } = visibleRange(total, selected, maxRows);
			for (let index = start; index < end; index++) {
				lines.push(this.renderListRow(this.rows[index]!, index === selected, width));
			}
			if (total > maxRows) {
				lines.push(this.cut(th.fg("dim", `  (${selected + 1}/${total})`), width));
			}
		}
		const up = formatKeyLabel(this.keyLabel("tui.select.up"));
		const down = formatKeyLabel(this.keyLabel("tui.select.down"));
		const enter = formatKeyLabel(this.keyLabel("tui.select.confirm"));
		const busyLabel = this.renderBusyLabel(this.selectedRow());
		const hints = this.cut(
			busyLabel +
				th.fg("dim", `${up}/${down}`) +
				th.fg("muted", " select | ") +
				th.fg("dim", enter) +
				th.fg("muted", " inspect | ") +
				th.fg("dim", "q") +
				th.fg("muted", " close"),
			width,
		);
		lines.push(hints);
		return lines;
	}

	/** The list row's task slot: the task, plus - for attention states - the
	 *  parent's pending-job context in parentheses. The task is cut first so
	 *  the context keeps its room: a waiting row must still name its bg ids
	 *  and auto-resume when the task text is long. */
	private taskWithContext(row: InspectorRow, state: string, cols: number): string {
		const task = sanitizeWorkerText(row.task);
		const context = listActivityContext(state, row.activity);
		if (context === "") return this.cut(task, cols);
		const suffix = ` (${context})`;
		const suffixCols = this.m.visibleWidth(suffix);
		const taskPart = suffixCols < cols ? this.cut(task, cols - suffixCols) : "";
		return this.cut(`${taskPart}${suffix}`, cols);
	}

	private renderListRow(row: InspectorRow, selected: boolean, width: number): string {
		const th = this.theme;
		const id = sanitizeWorkerText(row.id);
		const state = this.rowState(row);
		const tone = stateTone(state);
		const elapsed = formatElapsed((row.endedAt ?? this.now) - (typeof row.startedAt === "number" ? row.startedAt : 0));
		let line: string;
		if (width < COMPACT_WIDTH) {
			const taskCols = Math.max(4, width - 2 - COMPACT_ID_COL);
			const stateCols = Math.max(6, Math.floor(taskCols / 3));
			const textCols = Math.max(4, taskCols - stateCols);
			line =
				(selected ? th.fg("accent", "> ") : "  ") +
				th.fg(selected ? "accent" : "muted", this.pad(id, COMPACT_ID_COL)) +
				th.fg(tone, this.pad(state, stateCols)) +
				this.cut(this.taskWithContext(row, state, textCols), textCols);
		} else {
			const taskCols = Math.max(4, width - 2 - ID_COL - KIND_COL - STATE_COL - ELAPSED_COL - 3);
			line =
				(selected ? th.fg("accent", "> ") : "  ") +
				th.fg(selected ? "accent" : "muted", this.pad(id, ID_COL)) +
				th.fg("muted", this.pad(sanitizeWorkerText(row.kind), KIND_COL)) +
				th.fg(tone, this.pad(state, STATE_COL)) +
				th.fg("dim", this.rightAlign(elapsed, ELAPSED_COL)) +
				"  " +
				this.cut(this.taskWithContext(row, state, taskCols), taskCols);
		}
		const fitted = this.m.truncateToWidth(line, width, "", true);
		if (!selected) return fitted;
		return th.style(fitted, { fg: "text", bg: "selectedBg" });
	}

	private renderDetail(width: number): string[] {
		const th = this.theme;
		const row = this.selectedRow();
		if (row === undefined) {
			this.view = "list";
			return this.renderList(width);
		}
		const content = this.wrappedLines(row, width);
		const viewport = this.detailViewport();
		this.scroll = clampScrollState(this.scroll, content.length, viewport);

		const state = this.rowState(row);
		const elapsed = formatElapsed((row.endedAt ?? this.now) - (typeof row.startedAt === "number" ? row.startedAt : 0));
		const startedAt = typeof row.startedAt === "number" ? formatClock(row.startedAt) : "?";
		const lines: string[] = [];
		lines.push(
			this.cut(
				th.fg("accent", sanitizeWorkerText(row.id)) +
					th.fg("dim", " | ") +
					th.fg("muted", sanitizeWorkerText(row.kind)) +
					th.fg("dim", " | ") +
					th.fg(stateTone(state), state) +
					th.fg("dim", " | ") +
					th.fg("muted", elapsed) +
					th.fg("dim", ` | started ${startedAt}`),
				width,
			),
		);
		if (typeof row.model === "string" && row.model !== "") {
			lines.push(this.cut(th.fg("muted", "model: ") + sanitizeWorkerText(row.model), width));
		}
		if (typeof row.activity === "string" && row.activity !== "") {
			lines.push(this.cut(th.fg("muted", "activity: ") + sanitizeWorkerText(row.activity), width));
		}
		lines.push(this.cut(th.fg("dim", `log: ${sanitizeWorkerText(row.logPath)}`), width));
		if (this.rowsError !== undefined) {
			lines.push(this.cut(th.fg("error", `rows error: ${this.rowsError}`), width));
		}
		lines.push(this.separator(width, ""));

		if (content.length === 0) {
			lines.push(this.cut(th.fg("dim", "(no transcript yet)"), width));
		} else {
			for (const line of windowLines(content, this.scroll, viewport)) lines.push(this.cut(line, width));
		}

		const position =
			this.scroll.followTail || content.length <= viewport
				? "following tail"
				: `${this.scroll.scrollTop + 1}-${Math.min(this.scroll.scrollTop + viewport, content.length)} of ${content.length}`;
		// Plain label: separator styles the whole line, so no nested fg resets.
		lines.push(this.separator(width, position));

		const up = formatKeyLabel(this.keyLabel("tui.select.up"));
		const down = formatKeyLabel(this.keyLabel("tui.select.down"));
		const pageUp = formatKeyLabel(this.keyLabel("tui.select.pageUp"));
		const pageDown = formatKeyLabel(this.keyLabel("tui.select.pageDown"));
		const esc = formatKeyLabel(this.keyLabel("tui.select.cancel", "Esc"));
		const parts: string[] = [
			th.fg("dim", `${up}/${down}`) + th.fg("muted", " line | "),
			th.fg("dim", `${pageUp}/${pageDown}`) + th.fg("muted", " page | "),
			th.fg("dim", "End") + th.fg("muted", " tail | "),
		];
		if (isLiveState(row.state) && row.kind !== "bash") parts.push(th.fg("dim", "m") + th.fg("muted", " message | "));
		if (row.kind === "subagent" || isLiveState(row.state)) {
			parts.push(th.fg("dim", "x") + th.fg("muted", isLiveState(row.state) ? " stop | " : " remove | "));
		}
		parts.push(th.fg("dim", esc) + th.fg("muted", " back | "));
		parts.push(th.fg("dim", "q") + th.fg("muted", " close"));
		lines.push(this.cut(this.renderBusyLabel(row) + parts.join(""), width));
		return lines;
	}

	private keyLabel(id: Parameters<KeybindingsManager["getKeys"]>[0], fallback = ""): string {
		const keys = this.keybindings.getKeys(id);
		return keys.length > 0 ? String(keys[0]) : fallback;
	}

	/** Sanitized, wrapped, tail-capped transcript lines, cached per change+width. */
	private wrappedLines(row: InspectorRow, width: number): string[] {
		const transcript = typeof row.transcript === "string" ? row.transcript : "";
		const sig = textSignature(transcript);
		const cached = this.wrapped.get(row.id);
		if (cached !== undefined && cached.sig === sig && cached.width === width) return cached.lines;
		const sanitized = sanitizeWorkerText(transcript);
		const wrapWidth = Math.max(1, width);
		let lines: string[] = [];
		if (sanitized.length > 0) {
			const wrap = this.m.wrapTextWithAnsi;
			for (const raw of sanitized.split("\n")) {
				for (const wrapped of wrap(raw, wrapWidth)) lines.push(wrapped);
			}
		}
		if (lines.length > MAX_WRAPPED_LINES) {
			const dropped = lines.length - MAX_WRAPPED_LINES;
			lines = [
				this.theme.fg(
					"dim",
					`[${dropped} earlier lines not shown - full log: ${sanitizeWorkerText(row.logPath)}]`,
				),
				...lines.slice(lines.length - MAX_WRAPPED_LINES),
			];
		}
		this.wrapped.set(row.id, { sig, width, lines });
		return lines;
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Open the inspector as an inline custom component in the editor slot. Timer
 * and callbacks live only while the dialog is open; the host's reload path
 * disposes the component without resolving the promise, so every cleanup hook
 * runs from dispose() rather than from the (then-never-resolving) await.
 */
export async function openWorkerInspector(
	ctx: ExtensionCommandContext,
	options: WorkerInspectorOptions,
): Promise<void> {
	if (ctx.mode !== "tui") {
		// custom() resolves immediately without showing anything outside the
		// TUI; refusing beats a command that silently does nothing (or hangs a
		// caller waiting for UI that never renders).
		ctx.ui.notify(`The worker inspector needs interactive mode (tui), not ${ctx.mode}.`, "error");
		return;
	}
	let tuiModule: TuiModule;
	try {
		const imported = (await import("@earendil-works/pi-tui")) as TuiModule & { default?: TuiModule };
		tuiModule = (imported.default ?? imported) as TuiModule;
	} catch (error) {
		ctx.ui.notify(`Worker inspector could not load its UI toolkit: ${describeError(error)}`, "error");
		return;
	}
	try {
		await ctx.ui.custom<void>(
			(tui, theme, keybindings, done) =>
				new WorkerInspectorComponent({ tui, theme, keybindings, tuiModule, ctx, options, done }),
			{ blocked: { kind: "question", message: "worker inspector open" } },
		);
	} catch (error) {
		if (ctx.mode === "tui") {
			ctx.ui.notify(`Worker inspector failed: ${describeError(error)}`, "error");
		}
	}
}
