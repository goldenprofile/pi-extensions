/**
 * session-ledger: табличный отчёт из Ledger. Стилизация через минимальный интерфейс, совместимый с Theme.
 */
import { cachePercent, type GroupKey, groupRows, type Ledger, type Row, type Stats, topSessions, dayOf } from "./ledger.ts";

export type Color = "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text" | "toolTitle" | "borderMuted";

export interface Styler {
	fg(color: Color, text: string): string;
	bold(text: string): string;
}

export const plainStyler: Styler = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

export function fmtTokens(n: number): string {
	if (!Number.isFinite(n)) return "?";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${(n / 1000).toFixed(2)}K`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

export function fmtPercent(n: number | null): string {
	return n === null ? "–" : `${Math.round(n)}%`;
}

interface Column {
	title: string;
	align: "left" | "right";
	value: (row: Row) => string;
	color?: (row: Row) => Color | undefined;
}

function errorRate(s: Stats): number | null {
	return s.toolCalls > 0 ? Math.round((s.toolErrors / s.toolCalls) * 1000) / 10 : null;
}

function columnsFor(by: GroupKey): Column[] {
	const name: Column = { title: by, align: "left", value: (r) => r.key };
	if (by === "tool") {
		return [
			name,
			{ title: "calls", align: "right", value: (r) => String(r.stats.toolCalls) },
			{ title: "errors", align: "right", value: (r) => String(r.stats.toolErrors) },
			{
				title: "err%",
				align: "right",
				value: (r) => fmtPercent(errorRate(r.stats)),
				color: (r) => ((errorRate(r.stats) ?? 0) >= 20 ? "error" : (errorRate(r.stats) ?? 0) >= 10 ? "warning" : undefined),
			},
			{ title: "sessions", align: "right", value: (r) => String(r.stats.sessions) },
		];
	}
	return [
		name,
		{ title: "sess", align: "right", value: (r) => String(r.stats.sessions) },
		{ title: "turns", align: "right", value: (r) => String(r.stats.turns) },
		{ title: "in", align: "right", value: (r) => fmtTokens(r.stats.input) },
		{ title: "cache", align: "right", value: (r) => fmtTokens(r.stats.cacheRead) },
		{
			title: "cache%",
			align: "right",
			value: (r) => fmtPercent(cachePercent(r.stats)),
			color: (r) => {
				const c = cachePercent(r.stats);
				return c === null ? undefined : c >= 70 ? "success" : c < 30 ? "warning" : undefined;
			},
		},
		{ title: "out", align: "right", value: (r) => fmtTokens(r.stats.output) },
		{ title: "cost", align: "right", value: (r) => fmtCost(r.stats.cost) },
		{ title: "tools", align: "right", value: (r) => String(r.stats.toolCalls) },
		{
			title: "err%",
			align: "right",
			value: (r) => fmtPercent(errorRate(r.stats)),
			color: (r) => ((errorRate(r.stats) ?? 0) >= 20 ? "error" : (errorRate(r.stats) ?? 0) >= 10 ? "warning" : undefined),
		},
		{ title: "compact", align: "right", value: (r) => String(r.stats.compactions) },
	];
}

export function renderTable(rows: Row[], by: GroupKey, total: Stats | undefined, width: number, st: Styler): string[] {
	const columns = columnsFor(by);
	const totalRow: Row | undefined = total ? { key: "total", stats: total } : undefined;
	const allRows = totalRow ? [...rows, totalRow] : rows;
	const widths = columns.map((c, i) => {
		const cells = allRows.map((r) => c.value(r).length);
		const max = Math.max(c.title.length, ...cells);
		// Первая колонка (имя) может быть длинной; остальные фиксируем по содержимому.
		return i === 0 ? Math.min(max, Math.max(12, width - 70)) : max;
	});

	const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text);

	const cell = (c: Column, i: number, text: string) => {
		const clipped = text.length > widths[i] ? `${text.slice(0, widths[i] - 1)}…` : text;
		return c.align === "left" ? clipped.padEnd(widths[i]) : clipped.padStart(widths[i]);
	};

	const lines: string[] = [];
	lines.push(st.fg("muted", columns.map((c, i) => cell(c, i, c.title)).join("  ")));
	lines.push(st.fg("borderMuted", widths.map((w) => "─".repeat(w)).join("  ")));
	for (const row of rows) {
		lines.push(
			columns
				.map((c, i) => {
					const text = cell(c, i, c.value(row));
					if (i === 0) return st.fg("toolTitle", text);
					const color = c.color?.(row);
					return color ? st.fg(color, text) : text;
				})
				.join("  "),
		);
		// Имя сессии или первый промпт не влезает в колонку, поэтому отдельной строкой под строкой сессии.
		if (by === "session" && row.detail) lines.push(st.fg("dim", `  ${clip(row.detail, Math.max(20, width - 2))}`));
	}
	if (totalRow) {
		lines.push(st.fg("borderMuted", widths.map((w) => "─".repeat(w)).join("  ")));
		lines.push(st.bold(columns.map((c, i) => cell(c, i, i === 0 ? "total" : c.value(totalRow))).join("  ")));
	}
	return lines;
}

export function renderLedger(ledger: Ledger, by: GroupKey, width: number, st: Styler = plainStyler, options: { top?: number } = {}): string[] {
	const lines: string[] = [];
	const dim = (t: string) => st.fg("dim", t);
	const muted = (t: string) => st.fg("muted", t);
	const t = ledger.total;

	const since = ledger.since > 0 ? `since ${dayOf(ledger.since)}` : "all time";
	lines.push(
		`${st.bold(st.fg("accent", " Session ledger"))}  ${muted(`${ledger.period} (${since}) · by ${by}`)}  ${dim(`${ledger.sessions.length} of ${ledger.scanned} sessions${ledger.skipped ? `, ${ledger.skipped} unreadable` : ""}`)}`,
	);
	lines.push(st.fg("borderMuted", "─".repeat(Math.min(width, 110))));
	lines.push(
		`${muted("Totals")}  ${st.bold(fmtCost(t.cost))} · ${t.turns} turns · prompt ${fmtTokens(t.input + t.cacheRead + t.cacheWrite)} (cache ${fmtPercent(cachePercent(t))}) · output ${fmtTokens(t.output)} · ${t.toolCalls} tool calls (${t.toolErrors} errors) · ${t.compactions} compactions${t.branchSummaries ? ` · ${t.branchSummaries} branch summaries` : ""}${t.errors ? ` · ${t.errors} LLM errors` : ""}${t.aborted ? ` · ${t.aborted} aborted` : ""}`,
	);
	lines.push("");

	const rows = groupRows(ledger, by);
	if (rows.length === 0) {
		lines.push(dim("No sessions in this period."));
		return lines;
	}
	lines.push(...renderTable(rows, by, by === "tool" || by === "session" ? undefined : t, width, st));

	if (by !== "session") {
		const top = topSessions(ledger, options.top ?? 5);
		if (top.length > 0) {
			lines.push("");
			lines.push(muted(`Most expensive sessions`));
			for (const s of top) {
				const label = s.name ?? s.firstPrompt ?? "(no prompt)";
				lines.push(
					`  ${fmtCost(s.stats.cost).padStart(8)}  ${dim(dayOf(s.startedAt))}  ${st.fg("toolTitle", s.project.padEnd(18).slice(0, 18))}  ${String(s.stats.turns).padStart(3)} turns  ${dim(label)}`,
				);
			}
		}
	}
	lines.push("");
	lines.push(dim("Cost comes from pi's per-message usage.cost; models without pricing show $0. Sessions count in a period if any entry falls into it."));
	return lines;
}

export function summaryLine(ledger: Ledger): string {
	const t = ledger.total;
	return `${ledger.period}: ${fmtCost(t.cost)} · ${ledger.sessions.length} sessions · ${t.turns} turns · cache ${fmtPercent(cachePercent(t))} · ${t.toolErrors}/${t.toolCalls} tool errors`;
}
