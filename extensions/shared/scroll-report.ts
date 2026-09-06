/**
 * Общий прокручиваемый компонент для текстовых отчётов внутри ctx.ui.custom().
 * Клавиши: ↑↓ j k PgUp PgDn Space Home End g G · r пересчитать · q Esc Ctrl+C закрыть.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

export interface ScrollReportOptions {
	tui: TUI;
	theme: Theme;
	/** Строки отчёта для заданной ширины. Вызывается при первом рендере, смене ширины и по `r`. */
	render: (width: number, theme: Theme) => string[];
	onClose: () => void;
	/** Дополнительная подсказка в строке помощи, например список аргументов команды. */
	helpSuffix?: string;
}

export class ScrollReport implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly renderLines: (width: number, theme: Theme) => string[];
	private readonly onClose: () => void;
	private readonly helpSuffix: string;
	private offset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(options: ScrollReportOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.renderLines = options.render;
		this.onClose = options.onClose;
		this.helpSuffix = options.helpSuffix ?? "";
	}

	private viewportRows(): number {
		return Math.max(6, this.tui.terminal.rows - 3);
	}

	handleInput(data: string): void {
		const rows = this.viewportRows();
		const total = this.lines(this.cachedWidth ?? this.tui.terminal.columns).length;
		const maxOffset = Math.max(0, total - rows);

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.onClose();
			return;
		}
		if (data === "r") {
			this.invalidate();
		} else if (matchesKey(data, "up") || data === "k") {
			this.offset = Math.max(0, this.offset - 1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.offset = Math.min(maxOffset, this.offset + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.offset = Math.max(0, this.offset - rows);
		} else if (matchesKey(data, "pageDown") || data === " ") {
			this.offset = Math.min(maxOffset, this.offset + rows);
		} else if (matchesKey(data, "home") || data === "g") {
			this.offset = 0;
		} else if (matchesKey(data, "end") || data === "G") {
			this.offset = maxOffset;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private lines(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedLines = this.renderLines(width, this.theme).map((line) => truncateToWidth(line, width));
		this.cachedWidth = width;
		return this.cachedLines;
	}

	render(width: number): string[] {
		const all = this.lines(width);
		const rows = this.viewportRows();
		const maxOffset = Math.max(0, all.length - rows);
		if (this.offset > maxOffset) this.offset = maxOffset;
		const slice = all.slice(this.offset, this.offset + rows);
		const position = all.length > rows ? ` ${this.offset + 1}-${Math.min(all.length, this.offset + rows)}/${all.length}` : "";
		const help = this.theme.fg("dim", `↑↓ PgUp PgDn Home End scroll · r refresh · q/esc close${position}${this.helpSuffix}`);
		return [...slice, truncateToWidth(help, width)];
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
