/**
 * session-ledger: разбор JSONL-сессий pi и агрегаты по проектам, моделям, дням и инструментам.
 *
 * Чистый модуль без runtime-зависимостей от pi: работает и в расширении, и в CLI, и в тестах.
 * Считает все записи файла независимо от ветки дерева: деньги потрачены на каждую.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface Stats {
	sessions: number;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	toolCalls: number;
	toolErrors: number;
	compactions: number;
	branchSummaries: number;
	errors: number;
	aborted: number;
}

export interface ToolStats {
	calls: number;
	errors: number;
}

export interface SessionSummary {
	file: string;
	id: string;
	cwd: string;
	project: string;
	name?: string;
	firstPrompt?: string;
	startedAt: number;
	endedAt: number;
	userMessages: number;
	stats: Stats;
	byModel: Record<string, Stats>;
	byDay: Record<string, Stats>;
	byTool: Record<string, ToolStats>;
}

export type GroupKey = "project" | "model" | "day" | "tool" | "session";
export type Period = "today" | "yesterday" | "7d" | "30d" | "all";

export interface Row {
	key: string;
	stats: Stats;
	detail?: string;
}

export interface Ledger {
	period: Period;
	since: number;
	sessions: SessionSummary[];
	scanned: number;
	skipped: number;
	total: Stats;
}

export const PERIODS: Period[] = ["today", "yesterday", "7d", "30d", "all"];
export const GROUPS: GroupKey[] = ["project", "model", "day", "tool", "session"];

export interface StatsArgs {
	period: Period;
	by: GroupKey;
	project?: string;
}

/** Аргументы `/stats` и CLI в любом порядке: период, группа, всё остальное — фильтр проекта. */
export function parseArgs(args: string): StatsArgs {
	const result: StatsArgs = { period: "7d", by: "project" };
	for (const token of args.split(/\s+/).filter(Boolean)) {
		const lower = token.toLowerCase();
		if ((PERIODS as string[]).includes(lower)) result.period = lower as Period;
		else if ((GROUPS as string[]).includes(lower)) result.by = lower as GroupKey;
		else result.project = token;
	}
	return result;
}

export function emptyStats(): Stats {
	return {
		sessions: 0,
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		toolCalls: 0,
		toolErrors: 0,
		compactions: 0,
		branchSummaries: 0,
		errors: 0,
		aborted: 0,
	};
}

export function addStats(target: Stats, source: Stats): Stats {
	for (const key of Object.keys(target) as Array<keyof Stats>) target[key] += source[key];
	return target;
}

export function promptTokens(s: Stats): number {
	return s.input + s.cacheRead + s.cacheWrite;
}

export function cachePercent(s: Stats): number | null {
	const prompt = promptTokens(s);
	return prompt > 0 ? Math.round((s.cacheRead / prompt) * 1000) / 10 : null;
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

interface RawEntry {
	type?: string;
	id?: string;
	timestamp?: string | number;
	cwd?: string;
	name?: string;
	message?: {
		role?: string;
		content?: unknown;
		provider?: string;
		model?: string;
		usage?: UsageLike;
		stopReason?: string;
		toolName?: string;
		isError?: boolean;
		timestamp?: number;
	};
	usage?: UsageLike;
}

export function parseSessionText(text: string, file: string): SessionSummary | undefined {
	const lines = text.split("\n");
	let header: RawEntry | undefined;
	const summary: SessionSummary = {
		file,
		id: "",
		cwd: "",
		project: "",
		startedAt: 0,
		endedAt: 0,
		userMessages: 0,
		stats: emptyStats(),
		byModel: {},
		byDay: {},
		byTool: {},
	};
	summary.stats.sessions = 1;
	const toolNameByCallId = new Map<string, string>();

	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: RawEntry;
		try {
			entry = JSON.parse(line) as RawEntry;
		} catch {
			continue;
		}
		if (!header) {
			if (entry.type !== "session") return undefined;
			header = entry;
			summary.id = entry.id ?? "";
			summary.cwd = entry.cwd ?? "";
			summary.project = projectName(summary.cwd);
			summary.startedAt = toMs(entry.timestamp);
			summary.endedAt = summary.startedAt;
			continue;
		}

		const at = toMs(entry.timestamp);
		if (at > summary.endedAt) summary.endedAt = at;

		if (entry.type === "session_info") {
			summary.name = entry.name || undefined;
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// Расход суммаризации (компакция, итог ветки при /fork и /tree) относим к текущей модели сессии,
			// иначе строки разреза по моделям не сходятся с итогом.
			const lastModel = Object.keys(summary.byModel).at(-1);
			const targets = [summary.stats, bump(summary.byDay, dayOf(at)), ...(lastModel ? [summary.byModel[lastModel]] : [])];
			const usage = entry.usage ? normalizeUsage(entry.usage) : undefined;
			for (const t of targets) {
				if (entry.type === "branch_summary") t.branchSummaries += 1;
				else t.compactions += 1;
				if (usage) addTokens(t, usage);
			}
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;

		if (message.role === "user") {
			summary.userMessages += 1;
			if (!summary.firstPrompt) summary.firstPrompt = preview(textOf(message.content));
			continue;
		}
		if (message.role === "assistant") {
			const modelKey = `${message.provider ?? "?"}/${message.model ?? "?"}`;
			const day = dayOf(at);
			const usage = normalizeUsage(message.usage ?? {});
			const targets = [summary.stats, bump(summary.byModel, modelKey), bump(summary.byDay, day)];
			for (const t of targets) {
				t.turns += 1;
				addTokens(t, usage);
				if (message.stopReason === "error") t.errors += 1;
				if (message.stopReason === "aborted") t.aborted += 1;
			}
			for (const block of blocksOf(message.content)) {
				if (block.type === "toolCall" && typeof block.name === "string") {
					toolNameByCallId.set(String(block.id), block.name);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const name = message.toolName ?? toolNameByCallId.get(String((message as { toolCallId?: string }).toolCallId)) ?? "?";
			const tool = (summary.byTool[name] ??= { calls: 0, errors: 0 });
			tool.calls += 1;
			const isError = message.isError === true;
			if (isError) tool.errors += 1;
			for (const t of [summary.stats, bump(summary.byDay, dayOf(at))]) {
				t.toolCalls += 1;
				if (isError) t.toolErrors += 1;
			}
			// Ошибки инструментов относим к модели, которая их вызвала: последней по времени.
			const lastModel = Object.keys(summary.byModel).at(-1);
			if (lastModel) {
				summary.byModel[lastModel].toolCalls += 1;
				if (isError) summary.byModel[lastModel].toolErrors += 1;
			}
		}
	}

	if (!header) return undefined;
	for (const stats of [...Object.values(summary.byModel), ...Object.values(summary.byDay)]) stats.sessions = 1;
	return summary;
}

export function discoverSessionFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const full = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) walk(full);
			else if (name.endsWith(".jsonl")) out.push(full);
		}
	};
	walk(root);
	return out.sort();
}

export function loadSessions(files: string[]): { sessions: SessionSummary[]; skipped: number } {
	const sessions: SessionSummary[] = [];
	let skipped = 0;
	for (const file of files) {
		try {
			const summary = parseSessionText(readFileSync(file, "utf8"), file);
			if (summary) sessions.push(summary);
			else skipped += 1;
		} catch {
			skipped += 1;
		}
	}
	return { sessions, skipped };
}

export function periodStart(period: Period, now = Date.now()): number {
	const startOfToday = new Date(now);
	startOfToday.setHours(0, 0, 0, 0);
	switch (period) {
		case "today":
			return startOfToday.getTime();
		case "yesterday":
			return startOfToday.getTime() - 86_400_000;
		case "7d":
			return now - 7 * 86_400_000;
		case "30d":
			return now - 30 * 86_400_000;
		case "all":
			return 0;
	}
}

/** Сессия попадает в период, если хоть одна её запись сделана после `since`. Для "yesterday" — строго вчера. */
export function inPeriod(session: SessionSummary, period: Period, now = Date.now()): boolean {
	const since = periodStart(period, now);
	if (period === "yesterday") {
		const end = periodStart("today", now);
		return session.endedAt >= since && session.startedAt < end;
	}
	return session.endedAt >= since;
}

export function buildLedger(all: SessionSummary[], period: Period, options: { scanned?: number; skipped?: number; now?: number; project?: string } = {}): Ledger {
	const now = options.now ?? Date.now();
	const needle = options.project?.toLowerCase();
	const sessions = all.filter(
		(s) => inPeriod(s, period, now) && (!needle || s.project.toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle)),
	);
	const total = emptyStats();
	for (const s of sessions) addStats(total, s.stats);
	return { period, since: periodStart(period, now), sessions, scanned: options.scanned ?? all.length, skipped: options.skipped ?? 0, total };
}

export function groupRows(ledger: Ledger, by: GroupKey): Row[] {
	const rows = new Map<string, Row>();
	const rowFor = (key: string, detail?: string) => {
		let row = rows.get(key);
		if (!row) {
			row = { key, stats: emptyStats(), detail };
			rows.set(key, row);
		}
		return row;
	};

	for (const s of ledger.sessions) {
		switch (by) {
			case "project":
				addStats(rowFor(s.project, s.cwd).stats, s.stats);
				break;
			case "model":
				for (const [model, stats] of Object.entries(s.byModel)) addStats(rowFor(model).stats, stats);
				break;
			case "day":
				for (const [day, stats] of Object.entries(s.byDay)) addStats(rowFor(day).stats, stats);
				break;
			case "tool":
				for (const [tool, t] of Object.entries(s.byTool)) {
					const row = rowFor(tool);
					row.stats.toolCalls += t.calls;
					row.stats.toolErrors += t.errors;
					row.stats.sessions += 1;
				}
				break;
			case "session": {
				const label = s.name ?? s.firstPrompt ?? basename(s.file);
				addStats(rowFor(`${dayOf(s.startedAt)} ${s.project}`, label).stats, s.stats);
				break;
			}
		}
	}

	const list = [...rows.values()];
	if (by === "day") return list.sort((a, b) => a.key.localeCompare(b.key));
	if (by === "tool") return list.sort((a, b) => b.stats.toolCalls - a.stats.toolCalls);
	return list.sort((a, b) => b.stats.cost - a.stats.cost || b.stats.turns - a.stats.turns);
}

export function topSessions(ledger: Ledger, limit = 5): SessionSummary[] {
	return [...ledger.sessions].sort((a, b) => b.stats.cost - a.stats.cost || b.stats.turns - a.stats.turns).slice(0, limit);
}

export function projectName(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	return normalized.split("/").filter(Boolean).at(-1) ?? normalized ?? "?";
}

export function dayOf(ms: number): string {
	if (!ms) return "unknown";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function bump<T extends Stats>(group: Record<string, T>, key: string): T {
	return (group[key] ??= emptyStats() as T);
}

function normalizeUsage(usage: UsageLike): Required<Pick<UsageLike, "input" | "output" | "cacheRead" | "cacheWrite">> & { cost: number } {
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		cost: usage.cost?.total ?? 0,
	};
}

function addTokens(target: Stats, usage: ReturnType<typeof normalizeUsage>): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.cost += usage.cost;
}

function toMs(timestamp: string | number | undefined): number {
	if (typeof timestamp === "number") return timestamp;
	if (typeof timestamp === "string") {
		const ms = Date.parse(timestamp);
		return Number.isFinite(ms) ? ms : 0;
	}
	return 0;
}

function blocksOf(content: unknown): Array<Record<string, unknown>> {
	return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return blocksOf(content)
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join(" ");
}

function preview(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
