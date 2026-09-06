/**
 * session-trace — TUI-компонент: лента ходов агента как flow-граф.
 * Режимы: live (follow за хвостом файла) и replay (проигрывание по timestamp'ам).
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GraphModel, type ChildItem, type Item, fmtClock, fmtDur, fmtK, fmtMoney, oneLine } from "./session.ts";

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/** Ширина мини-карты: колонка силуэта + колонка позиции вьюпорта. */
const MAP = 2;
// класс строки ленты: вес для выборки и цвет на карте
const KIND_WEIGHT: Record<string, number> = { E: 5, R: 4, U: 3, C: 2, B: 2, t: 1, ".": 0 };
const MAP_COLOR: Record<string, string> = { E: "error", R: "accent", U: "userMessageText", C: "toolTitle", B: "muted", t: "dim" };

interface UiTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface TuiLike {
	requestRender(): void;
	terminal: { rows: number; columns: number };
}

export class TraceView {
	private tui: TuiLike;
	private theme: UiTheme;
	private file: string;
	private mode: "live" | "replay";
	private onClose: () => void;

	private entries: { ms: number; e: any }[] = [];
	private model: GraphModel = new GraphModel();
	private fedCount = 0;
	private byteOffset = 0;
	private pending = "";

	private playheadMs = 0;
	private speed = 8;
	private paused = false;
	private follow: boolean;
	private scrollBack = 0;
	private lastTick = Date.now();
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	private lineKinds: string[] = [];
	private matchStarts: number[] = []; // строки ленты, где начинаются элементы под фильтром
	private matchCursor = -1; // индекс последнего совпадения, к которому прыгали (n/N)
	private filterQ = ""; // активный фильтр подстроки
	private editing = false; // идёт ввод фильтра
	private errorsOnly = false; // режим «только ошибки»
	private summary = false; // сводка по моделям вместо ленты
	private cache: { width: number; version: number; lines: string[]; kinds: string[]; matchStarts: number[] } | undefined;

	constructor(opts: {
		tui: TuiLike;
		theme: UiTheme;
		file: string;
		mode: "live" | "replay";
		speed?: number;
		onClose: () => void;
	}) {
		this.tui = opts.tui;
		this.theme = opts.theme;
		this.file = opts.file;
		this.mode = opts.mode;
		this.speed = opts.speed ?? 8;
		this.onClose = opts.onClose;
		this.follow = opts.mode === "live";
		this.poll();
		this.playheadMs = this.entries[0]?.ms ?? 0;
		if (this.mode === "live") this.feedAvailable();
		this.timer = setInterval(() => this.tick(), 150);
	}

	dispose(): void {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	// ---------- данные ----------

	/** Инкрементально дочитывает файл. true — появились новые записи. */
	private poll(): boolean {
		let fd: number;
		try {
			fd = openSync(this.file, "r");
		} catch {
			return false;
		}
		try {
			const size = fstatSync(fd).size;
			if (size < this.byteOffset) {
				// файл пересоздали — начинаем заново
				this.byteOffset = 0;
				this.pending = "";
				this.resetModel();
			}
			if (size === this.byteOffset) return false;
			const buf = Buffer.alloc(size - this.byteOffset);
			readSync(fd, buf, 0, buf.length, this.byteOffset);
			this.byteOffset = size;
			const lines = (this.pending + buf.toString("utf8")).split("\n");
			this.pending = lines.pop() ?? "";
			let added = 0;
			for (const line of lines) {
				const t = line.trim();
				if (!t) continue;
				let e: any;
				try {
					e = JSON.parse(t);
				} catch {
					continue;
				}
				this.entries.push({ ms: Date.parse(e.timestamp) || 0, e });
				added++;
			}
			return added > 0;
		} finally {
			closeSync(fd);
		}
	}

	private resetModel(): void {
		this.model = new GraphModel();
		this.fedCount = 0;
		this.cache = undefined;
	}

	private feedOne(): void {
		if (this.fedCount >= this.entries.length) return;
		this.model.feedEntry(this.entries[this.fedCount].e);
		this.fedCount++;
	}

	private feedAvailable(): void {
		while (this.fedCount < this.entries.length) this.feedOne();
		if (this.entries.length > 0) {
			this.playheadMs = Math.max(this.playheadMs, this.entries[this.entries.length - 1].ms);
		}
	}

	private seekTo(ms: number): void {
		let lo = 0;
		let hi = this.entries.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.entries[mid].ms <= ms) lo = mid + 1;
			else hi = mid;
		}
		this.resetModel();
		for (let i = 0; i < lo; i++) this.feedOne();
		this.playheadMs = this.entries[Math.max(0, lo - 1)]?.ms ?? ms;
	}

	private tick(): void {
		if (this.closed) return;
		const now = Date.now();
		const dt = now - this.lastTick;
		this.lastTick = now;
		const grew = this.poll();
		if (this.mode === "live" || this.follow) {
			this.feedAvailable();
		} else if (!this.paused) {
			this.playheadMs += dt * this.speed;
			while (this.fedCount < this.entries.length && this.entries[this.fedCount].ms <= this.playheadMs) {
				this.feedOne();
			}
			if (this.fedCount >= this.entries.length && grew) {
				this.poll(); // догнать дозапись на «живом» краю replay
			}
		}
		this.tui.requestRender();
	}

	// ---------- ввод ----------

	handleInput(data: string): void {
		const rows = Math.max(6, this.tui.terminal.rows - 2);

		// режим ввода фильтра: печатаем подстроку, enter — применить, esc — сбросить
		if (this.editing) {
			if (matchesKey(data, Key.enter)) {
				this.editing = false;
				this.matchCursor = -1;
			} else if (matchesKey(data, Key.escape)) {
				this.editing = false;
				this.filterQ = "";
				this.matchCursor = -1;
			} else if (matchesKey(data, Key.backspace)) {
				this.filterQ = this.filterQ.slice(0, -1);
				this.matchCursor = -1;
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.filterQ += data;
				this.matchCursor = -1;
			}
			this.cache = undefined;
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.dispose();
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			// esc: сначала снимает фильтры, и только потом закрывает
			if (this.filterQ || this.errorsOnly || this.summary) {
				this.filterQ = "";
				this.errorsOnly = false;
				this.summary = false;
				this.matchCursor = -1;
				this.cache = undefined;
			} else {
				this.dispose();
				this.onClose();
				return;
			}
		} else if (data === "/") {
			this.editing = true;
		} else if (data === "e") {
			this.errorsOnly = !this.errorsOnly;
			this.matchCursor = -1;
			this.cache = undefined;
		} else if (data === "m") {
			this.summary = !this.summary;
			this.cache = undefined;
		} else if (data === "n" || data === "N") {
			this.jumpMatch(data === "n" ? 1 : -1);
		} else if (matchesKey(data, Key.up)) {
			this.follow = false;
			this.scrollBack += 3;
		} else if (matchesKey(data, Key.down)) {
			this.scrollBack = Math.max(0, this.scrollBack - 3);
			if (this.scrollBack === 0) this.follow = true;
		} else if (matchesKey(data, Key.pageUp)) {
			this.follow = false;
			this.scrollBack += rows - 3;
		} else if (matchesKey(data, Key.pageDown)) {
			this.scrollBack = Math.max(0, this.scrollBack - (rows - 3));
			if (this.scrollBack === 0) this.follow = true;
		} else if (matchesKey(data, Key.home)) {
			this.follow = false;
			this.scrollBack = Number.MAX_SAFE_INTEGER / 2;
		} else if (matchesKey(data, Key.end) || data === "f") {
			this.jumpToEnd();
		} else if (this.mode === "replay") {
			this.handleReplayKeys(data);
		}
		this.tui.requestRender();
	}

	private handleReplayKeys(data: string): void {
		if (matchesKey(data, Key.space)) {
			this.paused = !this.paused;
		} else if (data === "+" || data === "=") {
			this.speed = Math.min(256, this.speed * 2);
		} else if (data === "-" || data === "_") {
			this.speed = Math.max(0.25, this.speed / 2);
		} else if (matchesKey(data, Key.left)) {
			this.follow = false;
			this.paused = true;
			this.seekTo(Math.max(0, this.playheadMs - 5000));
		} else if (matchesKey(data, Key.right)) {
			this.follow = false;
			this.paused = true;
			this.seekTo(this.playheadMs + 5000);
		} else if (data === "l") {
			this.jumpToEnd();
		} else if (data === "r") {
			this.follow = false;
			this.paused = false;
			this.seekTo(this.entries[0]?.ms ?? 0);
		}
	}

	/** n/N: к следующему/предыдущему совпадению фильтра (без фильтра — к соседнему элементу). */
	private jumpMatch(dir: 1 | -1): void {
		if (!this.cache) {
			// после правки фильтра кэш сброшен — прогреваем, чтобы получить matchStarts
			this.render(Math.max(20, this.tui.terminal.columns - MAP));
		}
		const ms = this.cache?.matchStarts;
		if (!ms || ms.length === 0) return;

		if (this.matchCursor < 0 || this.matchCursor >= ms.length) {
			// первый прыжок: от текущей позиции вьюпорта
			const body = Math.max(4, this.tui.terminal.rows - 2);
			const maxStart = Math.max(0, this.cache!.lines.length - body);
			const cur = this.follow ? maxStart : Math.max(0, Math.min(maxStart, maxStart - this.scrollBack));
			this.matchCursor = dir === 1 ? ms.findIndex((s) => s > cur) : -1;
			if (dir === 1 && this.matchCursor < 0) this.matchCursor = 0; // по кругу
			if (dir === -1) {
				this.matchCursor = ms.length - 1;
				for (let i = ms.length - 1; i >= 0; i--) {
					if (ms[i] < cur) {
						this.matchCursor = i;
						break;
					}
				}
			}
		} else {
			this.matchCursor += dir;
			if (this.matchCursor >= ms.length) this.matchCursor = 0;
			if (this.matchCursor < 0) this.matchCursor = ms.length - 1;
		}

		const body2 = Math.max(4, this.tui.terminal.rows - 2);
		const maxStart2 = Math.max(0, this.cache!.lines.length - body2);
		const target = ms[this.matchCursor];
		this.follow = false;
		this.scrollBack = Math.max(0, maxStart2 - target);
		this.tui.requestRender();
	}

	private jumpToEnd(): void {
		this.follow = true;
		this.scrollBack = 0;
		this.feedAvailable();
	}

	// ---------- рендер ----------

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): string[] {
		const rows = Math.max(6, this.tui.terminal.rows);
		const body = rows - 2;
		const contentW = Math.max(20, width - MAP);
		if (!this.cache || this.cache.width !== contentW || this.cache.version !== this.model.version) {
			const lines = this.buildLines(contentW).map((l) => truncateToWidth(l, contentW));
			this.cache = { width: contentW, version: this.model.version, lines, kinds: this.lineKinds, matchStarts: this.matchStarts };
		}
		const { lines, kinds } = this.cache;
		const maxStart = Math.max(0, lines.length - body);
		let start = this.follow ? maxStart : maxStart - this.scrollBack;
		start = Math.max(0, Math.min(maxStart, start));
		const showMap = lines.length > body;
		const out = [this.header(width, start)];
		for (let r = 0; r < body; r++) {
			const line = lines[start + r];
			if (!showMap || line === undefined) {
				out.push(line ?? "");
				continue;
			}
			out.push(this.mapRow(line, contentW, kinds, start, body, r, lines.length));
		}
		while (out.length < rows) out.push("");
		out[rows - 1] = this.footer(width, start, lines.length);
		return out;
	}

	/** Строка ленты, дополненная справа колонкой мини-карты. */
	private mapRow(line: string, contentW: number, kinds: string[], start: number, body: number, r: number, total: number): string {
		const th = this.theme;
		const pad = contentW - visibleWidth(line);
		// диапазон исходных строк, который представляет эта строка карты
		const a = Math.floor((total * r) / body);
		const bEnd = Math.max(a + 1, Math.floor((total * (r + 1)) / body));
		let bestW = 0;
		let bestK = ".";
		for (let i = a; i < kinds.length && i < bEnd + 1; i++) {
			const w = KIND_WEIGHT[kinds[i]] ?? 0;
			if (w > bestW) {
				bestW = w;
				bestK = kinds[i];
			}
		}
		const inView = bEnd > start && a < start + body;
		const glyph = bestK === "." ? " " : th.fg(MAP_COLOR[bestK] ?? "dim", "▪");
		const bar = inView ? th.fg("accent", "▐") : " ";
		return line + " ".repeat(Math.max(0, pad)) + glyph + bar;
	}

	private badge(start: number): string {
		const th = this.theme;
		let b: string;
		if (this.mode === "live" || this.follow) b = th.fg("accent", th.bold("LIVE ●"));
		else if (this.paused) b = th.fg("warning", "PAUSED ⏸");
		else if (this.fedCount >= this.entries.length) b = th.fg("muted", "END");
		else b = th.fg("dim", `▶ ${this.speed}×`);
		if (this.errorsOnly) b += " " + th.fg("error", "err-only");
		if (this.filterQ) b += " " + th.fg("accent", `«${oneLine(this.filterQ, 14)}»`);
		const ms = this.cache?.matchStarts;
		if (this.matchCursor >= 0 && ms && this.matchCursor < ms.length) {
			b += " " + th.fg("dim", `${this.matchCursor + 1}/${ms.length}`);
		} else if ((this.filterQ || this.errorsOnly) && ms && ms.length) {
			let idx = 0;
			for (const s of ms) if (s <= start) idx++;
			b += " " + th.fg("dim", `${Math.min(idx + 1, ms.length)}/${ms.length}`);
		}
		return b;
	}

	private header(width: number, start: number): string {
		const th = this.theme;
		const m = this.model;
		const fileLabel =
			this.mode === "replay" ? oneLine(basename(this.file).replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, ""), 18) : "";
		const name = m.sessionName ? oneLine(m.sessionName, 24) : "";
		const sep = th.fg("dim", " · ");
		const parts = [
			` ${th.fg("accent", "◐")} ${th.bold("session-trace")}`,
			fileLabel && th.fg("dim", fileLabel),
			th.fg("dim", `${name ? `${name} · ` : ""}${this.entries.length} entries`),
			`↑${fmtK(m.totals.input)} ↓${fmtK(m.totals.output)}`,
			m.totals.cost > 0 ? fmtMoney(m.totals.cost) : "",
		].filter(Boolean) as string[];
		const left = parts.join(sep);
		const b = this.badge();
		const pad = width - visibleWidth(left) - visibleWidth(b) - 1;
		return pad > 0 ? `${left} ${" ".repeat(pad)}${b}` : truncateToWidth(`${left} ${b}`, width);
	}

	private footer(width: number, start: number, total: number): string {
		const th = this.theme;
		const pos = th.fg("dim", `${Math.min(start + 1, total)}/${total}`);
		let hints: string;
		if (this.editing) {
			hints = ` filter: ${this.filterQ}▏ enter — применить · esc — сброс `;
		} else {
		const nav = this.mode === "live" ? "↑↓ scroll · f follow" : "space pause · ←→ seek · +/- speed · l live · r restart";
			hints = ` ${nav} · / filter · n/N jump · e errors · m models · esc close `;
		}
		const right = `${hints}${pos} `;
		const pad = width - visibleWidth(right);
		return pad > 0 ? `${" ".repeat(pad)}${right}` : truncateToWidth(right, width);
	}

	private spin(): string {
		return SPIN[Math.floor(Date.now() / 90) % SPIN.length];
	}

	private cardEdge(left: string, title: string, width: number): string {
		const th = this.theme;
		const inner = width - visibleWidth(left) - visibleWidth("─" + title) - 1;
		const dashes = "─".repeat(Math.max(0, inner));
		return th.fg("border", left + dashes) + th.fg("dim", title) + th.fg("border", "─┐");
	}

	private cardRow(left: string, right: string, inner: number): string {
		const gap = inner - visibleWidth(left) - visibleWidth(right);
		const content = gap >= 1 ? left + " ".repeat(gap) + right : truncateToWidth(`${left} ${right}`, inner);
		const padding = " ".repeat(Math.max(0, inner - visibleWidth(content)));
		return this.theme.fg("border", "│") + content + padding + this.theme.fg("border", "│");
	}

	private plainRow(content: string, inner: number): string {
		const padding = " ".repeat(Math.max(0, inner - visibleWidth(content)));
		return this.theme.fg("border", "│") + content + padding + this.theme.fg("border", "│");
	}

	private childLines(c: ChildItem, width: number, out: string[], kinds: string[]): void {
		const th = this.theme;
		const inner = Math.max(8, width - 2);
		const title =
			` ⧉ субагент: ${c.agent}` +
			` · ${fmtClock(c.ts)}` +
			(c.tokensOut ? ` · ↓${fmtK(c.tokensOut)}` : "") +
			(c.cost ? ` · ${fmtMoney(c.cost)}` : "");
		out.push(this.cardEdge("┌─", title, width));
		kinds.push("C");
		out.push(this.plainRow(` ${th.fg("text", c.task)}`, inner));
		kinds.push("C");
		out.push(this.plainRow(` ${th.fg("dim", basename(c.session))}`, inner));
		kinds.push("C");
		out.push(this.plainRow(` ${th.fg("toolTitle", "→ /graph " + c.session)}`, inner));
		kinds.push("C");
		out.push(th.fg("border", `└${"─".repeat(width - 2)}┘`));
		kinds.push("C");
	}

	private cardLines(t: any, width: number, out: string[], kinds: string[]): void {
		const put = (s: string, k: string) => {
			out.push(s);
			kinds.push(k);
		};
		const th = this.theme;
		const inner = Math.max(8, width - 2);
		const running = t.chips.some((c: any) => c.status === "running");
		const ends = t.chips.map((c: any) => c.endMs).filter((x: any) => x !== undefined) as number[];
		const dur = ends.length > 0 ? fmtDur(Math.max(...ends) - t.startMs) : "";
		const title =
			` T${t.index} · ${fmtClock(t.startMs)}` +
			(dur ? ` · ${dur}` : "") +
			(t.model ? ` · ${t.model}` : "") +
			(t.tokensOut ? ` · ↓${fmtK(t.tokensOut)}` : "") +
			(t.cost ? ` · ${fmtMoney(t.cost)}` : "") +
			(t.stopReason === "aborted" ? " · aborted" : "") +
			(running ? " · working" : "");
		put(this.cardEdge("┌─", title, width), running ? "R" : "t");

		for (const c of t.chips) {
			const glyph =
				c.status === "ok"
					? th.fg("success", "✓")
					: c.status === "error"
						? th.fg("error", "✗")
						: th.fg("accent", `${this.spin()} running`);
			const dur = c.endMs !== undefined ? fmtDur(c.endMs - c.startMs) : "";
			const left = `${th.fg("toolTitle", c.name)} ${th.fg("dim", c.label)}`;
			put(this.cardRow(` ⚒ ${left}`, `${th.fg("muted", dur)} ${glyph}`, inner), c.status === "error" ? "E" : c.status === "running" ? "R" : "t");
		}
		if (t.thinking) {
			put(this.plainRow(` ${th.fg("muted", `⋮ ${t.thinking}`)}`, inner), "t");
		}
		if (t.text) {
			put(this.plainRow(` ${th.fg("text", `«${t.text}»`)}`, inner), "t");
		}
		if (t.errorMessage) {
			put(this.plainRow(` ${th.fg("error", `✗ ${oneLine(t.errorMessage, inner - 4)}`)}`, inner), "E");
		}
		put(th.fg("border", `└${"─".repeat(width - 2)}┘`), "t");
	}

	/** Проходит ли элемент под активными фильтрами (подстрока и/или «только ошибки»). */
	private matches(it: Item): boolean {
		if (this.errorsOnly) {
			const bad =
				(it.kind === "turn" && (it.errorMessage || it.chips.some((c) => c.status === "error"))) ||
				(it.kind === "bash" && it.exitCode !== undefined && it.exitCode !== 0);
			if (!bad) return false;
		}
		if (!this.filterQ) return true;
		const q = this.filterQ.toLowerCase();
		const hay =
			it.kind === "turn"
				? `${it.text ?? ""} ${it.thinking ?? ""} ${it.model ?? ""} ${it.chips.map((c) => `${c.name} ${c.label}`).join(" ")}`
				: it.kind === "marker"
					? it.text
					: it.kind === "user"
						? it.text
						: it.kind === "child"
							? `${it.agent} ${it.task} ${it.session}`
							: it.command; // bash
		return hay.toLowerCase().includes(q);
	}

	private summaryLines(width: number, kinds: string[]): string[] {
		const th = this.theme;
		const out: string[] = ["", ` ${th.bold("Модели")}`, th.fg("dim", " ─────────────────────────────────────────")];
		kinds.push(".", ".", ".");
		const rows = [...this.model.models.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].turns - a[1].turns);
		for (const [name, s] of rows) {
			const left = ` ${th.fg("toolTitle", oneLine(name, Math.max(12, width - 44)))}`;
			const right = `${s.turns} turns · ↑${fmtK(s.input)} ↓${fmtK(s.output)} · ${fmtMoney(s.cost)}`;
			const gap = width - visibleWidth(left) - visibleWidth(right) - 1;
			out.push(gap > 0 ? `${left}${" ".repeat(gap)}${th.fg("dim", right)}` : truncateToWidth(`${left} ${right}`, width));
			kinds.push(".");
		}
		if (rows.length === 0) out.push(th.fg("dim", " пока нет ответов модели")), kinds.push(".");
		out.push("", th.fg("dim", " m — вернуться к ленте · esc — сбросить всё"));
		kinds.push(".", ".");
		return out;
	}

	private buildLines(width: number): string[] {
		const th = this.theme;
		const out: string[] = [];
		const kinds: string[] = [];
		const m = this.model;
		if (this.summary) {
			this.matchStarts = [];
			this.lineKinds = kinds;
			return this.summaryLines(width, kinds);
		}
		const matchStarts: number[] = [];
		for (const it of m.items) {
			if (!this.matches(it)) continue;
			matchStarts.push(out.length);
			out.push(th.fg("borderMuted", "  │"));
			kinds.push(".");
			if (it.kind === "user") {
				out.push(`  ${th.fg("accent", "●")} ${th.fg("userMessageText", it.text)}`);
				kinds.push("U");
			} else if (it.kind === "bash") {
				const bad = it.exitCode !== undefined && it.exitCode !== 0;
				const mark = bad ? ` ${th.fg("error", `exit ${it.exitCode}`)}` : "";
				out.push(`  ${th.fg("bashMode", "$")} ${th.fg("dim", it.command)}${mark}`);
				kinds.push(bad ? "E" : "B");
			} else if (it.kind === "marker") {
				out.push(`  ${th.fg("muted", `├ ${it.icon} ${it.text}`)}`);
				kinds.push(".");
			} else if (it.kind === "child") {
				this.childLines(it, width, out, kinds);
			} else {
				this.cardLines(it, width, out, kinds);
			}
		}
		if (out.length === 0) {
			out.push(
				th.fg("dim", m.items.length === 0 ? "  ждём первую запись сессии…" : "  под фильтр ничего не попало")
			);
			kinds.push(".");
		}
		this.matchStarts = matchStarts;
		this.lineKinds = kinds;
		return out;
	}
}
