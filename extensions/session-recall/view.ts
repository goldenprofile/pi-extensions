/**
 * session-recall: интерактивный список результатов. Две строки на результат: заголовок и фрагмент.
 * ↑↓ j k PgUp PgDn Home End · Enter выбрать · q Esc закрыть.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { formatDate, type Hit, highlight } from "./search.ts";

export interface ResultsViewOptions {
	tui: TUI;
	theme: Theme;
	hits: Hit[];
	total: number;
	terms: string[];
	queryText: string;
	onSelect: (hit: Hit) => void;
	onClose: () => void;
}

export class ResultsView implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly hits: Hit[];
	private readonly total: number;
	private readonly terms: string[];
	private readonly queryText: string;
	private readonly onSelect: (hit: Hit) => void;
	private readonly onClose: () => void;
	private selected = 0;
	private top = 0;

	constructor(options: ResultsViewOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.hits = options.hits;
		this.total = options.total;
		this.terms = options.terms;
		this.queryText = options.queryText;
		this.onSelect = options.onSelect;
		this.onClose = options.onClose;
	}

	private pageSize(): number {
		// Заголовок, разделитель, подсказка занимают 3 строки; по 2 строки на результат.
		return Math.max(2, Math.floor((this.tui.terminal.rows - 4) / 2));
	}

	handleInput(data: string): void {
		const page = this.pageSize();
		const last = Math.max(0, this.hits.length - 1);
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, "return")) {
			const hit = this.hits[this.selected];
			if (hit) this.onSelect(hit);
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(last, this.selected + 1);
		else if (matchesKey(data, "pageUp")) this.selected = Math.max(0, this.selected - page);
		else if (matchesKey(data, "pageDown")) this.selected = Math.min(last, this.selected + page);
		else if (matchesKey(data, "home") || data === "g") this.selected = 0;
		else if (matchesKey(data, "end") || data === "G") this.selected = last;
		else return;

		if (this.selected < this.top) this.top = this.selected;
		if (this.selected >= this.top + page) this.top = this.selected - page + 1;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const page = this.pageSize();
		const lines: string[] = [];
		const shown = this.hits.length;
		const header = `${th.bold(th.fg("accent", " Recall"))}  ${th.fg("muted", this.queryText)}  ${th.fg("dim", `${shown === this.total ? shown : `${shown} of ${this.total}`} results`)}`;
		lines.push(truncateToWidth(header, width));
		lines.push(th.fg("borderMuted", "─".repeat(Math.min(width, 110))));

		if (this.hits.length === 0) {
			lines.push(th.fg("dim", "  Nothing found."));
		}
		const visible = this.hits.slice(this.top, this.top + page);
		visible.forEach((hit, i) => {
			const index = this.top + i;
			const active = index === this.selected;
			const u = hit.unit;
			const marker = active ? th.fg("accent", "▶ ") : "  ";
			const role = u.role === "tool" ? `tool:${u.tool ?? "?"}` : u.role === "custom" ? `custom:${u.tool ?? "?"}` : u.role;
			const name = u.sessionName ? `  ${th.fg("dim", u.sessionName)}` : "";
			const head = `${marker}${th.fg("dim", formatDate(u.timestamp))}  ${th.fg("toolTitle", u.project)}  ${th.fg("muted", role)}${name}`;
			const body = `    ${highlight(hit.snippet, this.terms, (s) => th.fg("warning", th.bold(s)))}`;
			lines.push(truncateToWidth(active ? th.bold(head) : head, width));
			lines.push(truncateToWidth(body, width));
		});

		const position = this.hits.length > page ? ` ${this.selected + 1}/${this.hits.length}` : "";
		lines.push(truncateToWidth(th.fg("dim", `↑↓ PgUp PgDn move · Enter open · q/esc close${position}`), width));
		return lines;
	}

	invalidate(): void {}
}
