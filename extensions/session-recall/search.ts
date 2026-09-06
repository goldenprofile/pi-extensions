/**
 * session-recall: полнотекстовый поиск по всем сессиям pi.
 *
 * Единица поиска — одно сообщение (user, assistant, tool, custom, summary) с датой, проектом и id записи.
 * Чистый модуль без runtime-зависимостей от pi: работает в расширении, CLI и тестах.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type UnitRole = "user" | "assistant" | "tool" | "custom" | "summary";

export interface Unit {
	file: string;
	sessionId: string;
	sessionName?: string;
	project: string;
	cwd: string;
	entryId: string;
	role: UnitRole;
	/** Имя инструмента для role === "tool". */
	tool?: string;
	timestamp: number;
	text: string;
}

export interface Hit {
	unit: Unit;
	/** Число вхождений всех термов. */
	score: number;
	/** Фрагмент вокруг первого вхождения. */
	snippet: string;
	/** Позиция первого вхождения в тексте. */
	position: number;
}

export interface Query {
	terms: string[];
	role?: UnitRole;
	project?: string;
	tool?: string;
}

export interface IndexEntry {
	mtimeMs: number;
	size: number;
	units: Unit[];
}

export type IndexCache = Map<string, IndexEntry>;

export const ROLES: UnitRole[] = ["user", "assistant", "tool", "custom", "summary"];

/**
 * Разбор строки запроса: слова через пробел (все должны встретиться), "фраза в кавычках" как один терм,
 * фильтры role:user, project:name, tool:edit.
 */
export function parseQuery(input: string): Query {
	const query: Query = { terms: [] };
	const re = /"([^"]+)"|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input)) !== null) {
		const token = match[1] ?? match[2] ?? "";
		const filter = /^(role|project|tool):(.+)$/.exec(token);
		if (filter && !match[1]) {
			const [, key, value] = filter;
			if (key === "role" && (ROLES as string[]).includes(value.toLowerCase())) query.role = value.toLowerCase() as UnitRole;
			else if (key === "project") query.project = value;
			else if (key === "tool") query.tool = value.toLowerCase();
			continue;
		}
		if (token) query.terms.push(token);
	}
	return query;
}

interface RawEntry {
	type?: string;
	id?: string;
	timestamp?: string | number;
	cwd?: string;
	name?: string;
	summary?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
		customType?: string;
	};
}

export function extractUnits(text: string, file: string): Unit[] {
	const units: Unit[] = [];
	let sessionId = "";
	let cwd = "";
	let project = "";
	let sessionName: string | undefined;
	let headerSeen = false;

	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: RawEntry;
		try {
			entry = JSON.parse(line) as RawEntry;
		} catch {
			continue;
		}
		if (!headerSeen) {
			if (entry.type !== "session") return [];
			headerSeen = true;
			sessionId = entry.id ?? "";
			cwd = entry.cwd ?? "";
			project = projectName(cwd);
			continue;
		}
		const base = { file, sessionId, project, cwd, entryId: entry.id ?? "", timestamp: toMs(entry.timestamp) };

		if (entry.type === "session_info") {
			sessionName = entry.name || undefined;
			continue;
		}
		if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.summary) {
			units.push({ ...base, role: "summary", text: entry.summary });
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "user") {
			const t = textOf(message.content);
			if (t) units.push({ ...base, role: "user", text: t });
		} else if (message.role === "assistant") {
			const t = assistantText(message.content);
			if (t) units.push({ ...base, role: "assistant", text: t });
		} else if (message.role === "toolResult") {
			const t = textOf(message.content);
			if (t) units.push({ ...base, role: "tool", tool: message.toolName ?? "?", text: t });
		} else if (message.role === "custom") {
			const t = textOf(message.content);
			if (t) units.push({ ...base, role: "custom", tool: message.customType, text: t });
		}
	}
	// Имя сессии становится известно позже первых сообщений, поэтому проставляем в конце.
	if (sessionName) for (const u of units) u.sessionName = sessionName;
	return units;
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
			try {
				if (statSync(full).isDirectory()) walk(full);
				else if (name.endsWith(".jsonl")) out.push(full);
			} catch {
				// файл исчез между readdir и stat
			}
		}
	};
	walk(root);
	return out.sort();
}

/** Обновляет кэш индекса: перечитывает только новые и изменившиеся файлы, удаляет пропавшие. */
export function refreshIndex(root: string, cache: IndexCache, options: { exclude?: string } = {}): { units: Unit[]; files: number; reparsed: number } {
	const files = discoverSessionFiles(root).filter((f) => !options.exclude || f !== options.exclude);
	const seen = new Set(files);
	for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);

	let reparsed = 0;
	for (const file of files) {
		let mtimeMs = 0;
		let size = 0;
		try {
			const st = statSync(file);
			mtimeMs = st.mtimeMs;
			size = st.size;
		} catch {
			continue;
		}
		const cached = cache.get(file);
		if (cached && cached.mtimeMs === mtimeMs && cached.size === size) continue;
		try {
			cache.set(file, { mtimeMs, size, units: extractUnits(readFileSync(file, "utf8"), file) });
			reparsed += 1;
		} catch {
			cache.delete(file);
		}
	}
	const units: Unit[] = [];
	for (const file of files) {
		const entry = cache.get(file);
		if (entry) units.push(...entry.units);
	}
	return { units, files: files.length, reparsed };
}

export function search(units: Unit[], query: Query, options: { limit?: number; snippetRadius?: number } = {}): { hits: Hit[]; total: number } {
	const limit = options.limit ?? 50;
	const radius = options.snippetRadius ?? 60;
	const terms = query.terms.map((t) => t.toLowerCase()).filter(Boolean);
	const project = query.project?.toLowerCase();
	const hits: Hit[] = [];

	for (const unit of units) {
		if (query.role && unit.role !== query.role) continue;
		if (project && !unit.project.toLowerCase().includes(project) && !unit.cwd.toLowerCase().includes(project)) continue;
		if (query.tool && (unit.tool ?? "").toLowerCase() !== query.tool) continue;
		if (terms.length === 0) {
			hits.push({ unit, score: 0, snippet: makeSnippet(unit.text, 0, 0, radius), position: 0 });
			continue;
		}
		const lower = unit.text.toLowerCase();
		let score = 0;
		let first = -1;
		let firstLen = 0;
		let ok = true;
		for (const term of terms) {
			let idx = lower.indexOf(term);
			if (idx < 0) {
				ok = false;
				break;
			}
			if (first < 0 || idx < first) {
				first = idx;
				firstLen = term.length;
			}
			while (idx >= 0) {
				score += 1;
				idx = lower.indexOf(term, idx + term.length);
			}
		}
		if (!ok) continue;
		hits.push({ unit, score, snippet: makeSnippet(unit.text, first, firstLen, radius), position: first });
	}

	hits.sort((a, b) => b.unit.timestamp - a.unit.timestamp || b.score - a.score);
	return { hits: hits.slice(0, limit), total: hits.length };
}

export function makeSnippet(text: string, position: number, length: number, radius: number): string {
	const start = Math.max(0, position - radius);
	const end = Math.min(text.length, position + length + radius);
	const raw = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${raw}${end < text.length ? "…" : ""}`;
}

/** Подсветка термов в строке через переданную функцию стиля. */
export function highlight(text: string, terms: string[], style: (s: string) => string): string {
	let out = text;
	for (const term of terms) {
		if (!term) continue;
		const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
		out = out.replace(re, (m) => style(m));
	}
	return out;
}

export function projectName(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	return normalized.split("/").filter(Boolean).at(-1) ?? "?";
}

export function formatDate(ms: number): string {
	if (!ms) return "????-??-??";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
	if (typeof content === "string") return content.trim();
	return blocksOf(content)
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => (b.text as string).trim())
		.filter(Boolean)
		.join("\n");
}

function assistantText(content: unknown): string {
	const parts: string[] = [];
	for (const block of blocksOf(content)) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text.trim());
		else if (block.type === "toolCall") parts.push(`→ ${String(block.name)} ${JSON.stringify(block.arguments ?? {})}`);
	}
	return parts.filter(Boolean).join("\n");
}
