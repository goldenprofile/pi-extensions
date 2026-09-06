/**
 * context-inspector: текстовый отчёт из Snapshot. Не зависит от pi-tui, стилизация
 * через минимальный интерфейс, совместимый с Theme.
 */
import type { GroupStat, Snapshot } from "./analyze.ts";

export type Color = "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text" | "toolTitle" | "borderMuted";

export interface Styler {
	fg(color: Color, text: string): string;
	bold(text: string): string;
}

export const plainStyler: Styler = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

export function fmtTokens(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "?";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${(n / 1000).toFixed(2)}K`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function bar(ratio: number, width: number): string {
	const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
	const filled = Math.round(clamped * width);
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

/** Одна строка для футера или статуса. */
export function summaryLine(s: Snapshot): string {
	const occ = s.occupancy;
	const parts: string[] = [];
	if (occ?.tokens !== null && occ?.tokens !== undefined) {
		parts.push(`ctx ${fmtTokens(occ.tokens)}/${fmtTokens(occ.contextWindow)} ${Math.round(occ.percent ?? 0)}%`);
	} else if (occ) {
		parts.push(`ctx ?/${fmtTokens(occ.contextWindow)}`);
	}
	if (s.lastUsage?.cachePercent !== null && s.lastUsage?.cachePercent !== undefined) {
		parts.push(`cache ${s.lastUsage.cachePercent}%`);
	}
	parts.push(`sys ${fmtTokens(s.system.totalTokens)}`);
	parts.push(`tools ${fmtTokens(s.tools.activeTokens)}`);
	parts.push(`msgs ${fmtTokens(s.messages.totalTokens)}`);
	return parts.join(" · ");
}

export function renderReport(s: Snapshot, width: number, st: Styler = plainStyler): string[] {
	const lines: string[] = [];
	const w = Math.max(40, width);
	const label = (text: string) => st.fg("accent", st.bold(text.padEnd(15)));
	const dim = (text: string) => st.fg("dim", text);
	const muted = (text: string) => st.fg("muted", text);
	const hr = () => lines.push(st.fg("borderMuted", "─".repeat(Math.min(w, 100))));

	const modelText = s.model ? `${s.model.id} (${s.model.provider}) · window ${fmtTokens(s.model.contextWindow)}` : "model: unknown";
	lines.push(`${st.bold(st.fg("accent", " Context inspector"))}  ${muted(modelText)}  ${dim(new Date(s.at).toLocaleTimeString())}`);
	hr();

	// Занятость окна
	const occ = s.occupancy;
	if (occ) {
		const ratio = occ.tokens !== null ? occ.tokens / occ.contextWindow : 0;
		const color: Color = ratio > 0.85 ? "error" : ratio > 0.6 ? "warning" : "success";
		const tokensText = occ.tokens !== null ? `${fmtTokens(occ.tokens)} / ${fmtTokens(occ.contextWindow)}  ${Math.round(occ.percent ?? 0)}%` : `? / ${fmtTokens(occ.contextWindow)}`;
		lines.push(`${label("Occupancy")}${tokensText.padEnd(26)} ${st.fg(color, bar(ratio, 24))}`);
		const c = s.compaction;
		lines.push(
			`${"".padEnd(15)}${dim(
				c.enabled
					? `auto-compaction at ${fmtTokens(c.compactAt)} (window − reserve ${fmtTokens(c.reserveTokens)}), keeps recent ${fmtTokens(c.keepRecentTokens)}`
					: "auto-compaction disabled",
			)}`,
		);
	}

	// Последний ответ провайдера
	const u = s.lastUsage;
	if (u) {
		const cache = u.cachePercent !== null ? ` (${u.cachePercent}% cached)` : "";
		const cost = u.costTotal !== undefined ? ` · cost $${u.costTotal.toFixed(4)}` : "";
		lines.push(
			`${label("Last response")}prompt ${st.bold(fmtTokens(u.promptTokens))} = input ${fmtTokens(u.input)} + cache read ${fmtTokens(u.cacheRead)} + cache write ${fmtTokens(u.cacheWrite)}${cache} · output ${fmtTokens(u.output)}${cost}`,
		);
	} else {
		lines.push(`${label("Last response")}${dim("no assistant usage yet")}`);
	}

	// Последний отправленный payload
	const r = s.lastRequest;
	if (r) {
		const bits = [`${fmtBytes(r.bytes)} ≈ ${fmtTokens(r.tokensEst)} tok`];
		if (r.systemTokens !== undefined) bits.push(`system ${fmtTokens(r.systemTokens)}`);
		if (r.toolsTokens !== undefined) bits.push(`tools ${fmtTokens(r.toolsTokens)} (${r.toolCount})`);
		if (r.messagesTokens !== undefined) bits.push(`messages ${fmtTokens(r.messagesTokens)} (${r.messageCount})`);
		lines.push(`${label("Last payload")}${bits.join(" · ")} ${dim(`· ${r.shape} · ${new Date(r.at).toLocaleTimeString()}`)}`);
	} else {
		lines.push(`${label("Last payload")}${dim("no request captured yet in this process")}`);
	}

	lines.push("");

	// Системный промпт
	lines.push(`${label("System prompt")}${st.bold(fmtTokens(s.system.totalTokens))} tokens ${dim(`· ${s.system.totalChars} chars`)}`);
	const sysMax = Math.max(1, ...s.system.parts.map((p) => p.tokens));
	for (const p of s.system.parts) {
		const detail = p.detail ? dim(`  ${p.detail}`) : "";
		lines.push(`  ${muted(bar(p.tokens / sysMax, 12))}  ${p.label.padEnd(28)} ${fmtTokens(p.tokens).padStart(7)}${detail}`);
	}
	lines.push("");

	// Инструменты
	lines.push(
		`${label("Tools")}${st.bold(fmtTokens(s.tools.activeTokens))} tokens active ${dim(`· ${s.tools.activeCount} of ${s.tools.totalCount} registered`)}`,
	);
	const toolMax = Math.max(1, ...s.tools.items.map((t) => t.tokens));
	for (const t of s.tools.items) {
		const name = t.active ? st.fg("toolTitle", t.name) : dim(`${t.name} (inactive)`);
		lines.push(`  ${muted(bar(t.tokens / toolMax, 12))}  ${padVisible(name, t.name.length + (t.active ? 0 : 11), 28)} ${fmtTokens(t.tokens).padStart(7)}`);
	}
	lines.push("");

	// Сообщения
	const m = s.messages;
	lines.push(`${label("Messages")}${st.bold(fmtTokens(m.totalTokens))} tokens ${dim(`· ${m.count} entries in context`)}`);
	if (m.compaction) {
		lines.push(
			`  ${muted("compaction summary")} ${fmtTokens(m.compaction.summaryTokens)} tokens ${dim(`(replaced ${fmtTokens(m.compaction.tokensBefore)})`)}`,
		);
	}
	lines.push(`  ${muted("by role:")} ${groupLine(m.byRole)}`);
	if (Object.keys(m.byTool).length > 0) lines.push(`  ${muted("by tool:")} ${groupLine(m.byTool)}`);
	if (m.largest.length > 0) {
		lines.push(`  ${muted("largest:")}`);
		for (const item of m.largest) {
			const who = item.toolName ? `${item.role} ${item.toolName}` : item.role;
			lines.push(
				`   ${dim(String(item.index).padStart(4))}  ${st.fg("toolTitle", who.padEnd(22))} ${fmtTokens(item.tokens).padStart(7)}  ${dim(item.preview)}`,
			);
		}
	}
	lines.push("");
	lines.push(dim("Estimates are chars/4 (same heuristic as pi). Only “Last response” is provider-reported."));
	return lines;
}

function groupLine(group: Record<string, GroupStat>): string {
	return Object.entries(group)
		.sort((a, b) => b[1].tokens - a[1].tokens)
		.map(([key, g]) => `${key} ${fmtTokens(g.tokens)} (${g.count})`)
		.join(" · ");
}

function padVisible(styled: string, visibleLength: number, width: number): string {
	return styled + " ".repeat(Math.max(0, width - visibleLength));
}
