/**
 * context-inspector: прокручиваемый TUI-компонент для отчёта. Открывается через ctx.ui.custom().
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { ScrollReport } from "../shared/scroll-report.ts";
import type { Snapshot } from "./analyze.ts";
import { renderReport } from "./report.ts";

export interface ReportViewOptions {
	tui: TUI;
	theme: Theme;
	snapshot: Snapshot;
	refresh: () => Snapshot;
	onClose: () => void;
}

export class ReportView extends ScrollReport {
	constructor(options: ReportViewOptions) {
		let snapshot = options.snapshot;
		let first = true;
		super({
			tui: options.tui,
			theme: options.theme,
			onClose: options.onClose,
			render: (width, theme) => {
				// Первый рендер использует переданный снимок; `r` и смена ширины пересчитывают.
				if (!first) snapshot = options.refresh();
				first = false;
				return renderReport(snapshot, width, theme);
			},
		});
	}
}
