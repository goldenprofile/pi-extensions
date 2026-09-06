/**
 * context-inspector: чистые функции разбора того, что модель реально видит в запросе.
 *
 * Ничего не импортирует из pi во время выполнения (только типы), поэтому тестируется
 * обычным `node --test` без установки pi в проект. Оценки токенов везде chars/4,
 * как в самом pi (см. core/compaction estimateTokens); точные числа даёт только
 * usage из ответа провайдера.
 */
import type { BuildSystemPromptOptions, SessionEntry } from "@earendil-works/pi-coding-agent";

export type EstimateText = (text: string) => number;
export type EstimateMessage = (message: unknown) => number;

export const estimateText: EstimateText = (text) => Math.ceil(text.length / 4);

export interface Part {
	label: string;
	tokens: number;
	chars: number;
	detail?: string;
}

export interface SystemBreakdown {
	totalTokens: number;
	totalChars: number;
	parts: Part[];
}

export interface ToolStat {
	name: string;
	tokens: number;
	active: boolean;
}

export interface ToolsBreakdown {
	activeTokens: number;
	activeCount: number;
	totalCount: number;
	items: ToolStat[];
}

export interface MessageStat {
	index: number;
	entryId?: string;
	role: string;
	toolName?: string;
	tokens: number;
	preview: string;
}

export interface GroupStat {
	count: number;
	tokens: number;
}

export interface MessagesBreakdown {
	totalTokens: number;
	count: number;
	byRole: Record<string, GroupStat>;
	byTool: Record<string, GroupStat>;
	largest: MessageStat[];
	compaction?: { summaryTokens: number; tokensBefore: number };
}

export interface RequestStats {
	at: number;
	bytes: number;
	tokensEst: number;
	shape: string;
	systemTokens?: number;
	toolsTokens?: number;
	toolCount?: number;
	messagesTokens?: number;
	messageCount?: number;
}

export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: { total: number };
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Токены промпта, которые реально ушли провайдеру: input + cacheRead + cacheWrite. */
	promptTokens: number;
	/** Доля промпта, прочитанная из кэша, в процентах. null, если промпт нулевой. */
	cachePercent: number | null;
	costTotal?: number;
}

export interface CompactionInfo {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	/** Порог автокомпакции: contextWindow - reserveTokens. */
	compactAt: number;
}

export interface Snapshot {
	at: number;
	model?: { provider: string; id: string; contextWindow: number; maxTokens: number };
	occupancy?: { tokens: number | null; contextWindow: number; percent: number | null };
	compaction: CompactionInfo;
	system: SystemBreakdown;
	tools: ToolsBreakdown;
	messages: MessagesBreakdown;
	lastRequest?: RequestStats;
	lastUsage?: UsageStats;
}

interface ToolLike {
	name: string;
	description: string;
	parameters: unknown;
}

export function analyzeSystemPrompt(
	systemPrompt: string,
	options: BuildSystemPromptOptions | undefined,
	estimate: EstimateText = estimateText,
): SystemBreakdown {
	const totalChars = systemPrompt.length;
	const parts: Part[] = [];
	let accounted = 0;

	const tokensFor = (chars: number) => Math.ceil(chars / 4);
	const push = (label: string, chars: number, detail?: string) => {
		if (chars <= 0) return;
		parts.push({ label, chars, tokens: tokensFor(chars), detail });
		accounted += chars;
	};

	if (options) {
		if (options.customPrompt) {
			push("custom prompt", options.customPrompt.length);
		}
		for (const file of options.contextFiles ?? []) {
			push(shortPath(file.path, options.cwd), file.content.length, file.path);
		}
		const skills = options.skills ?? [];
		if (skills.length > 0) {
			// pi сериализует навыки блоком <available_skills>…</available_skills>; берём его точную длину,
			// а если блока нет (например, нет инструмента чтения файлов), оцениваем по полям.
			const exact = blockLength(systemPrompt, "<available_skills>", "</available_skills>");
			const chars =
				exact ?? skills.reduce((sum, s) => sum + s.name.length + s.description.length + s.filePath.length + 60, 0);
			push(`skills (${skills.length})`, chars);
		}
		const selected = new Set(options.selectedTools ?? []);
		const snippets = Object.entries(options.toolSnippets ?? {}).filter(
			([name]) => selected.size === 0 || selected.has(name),
		);
		if (snippets.length > 0) {
			push(
				`tool snippets (${snippets.length})`,
				snippets.reduce((sum, [name, text]) => sum + name.length + text.length + 4, 0),
			);
		}
		const guidelines = options.promptGuidelines ?? [];
		if (guidelines.length > 0) {
			push(
				`guidelines (${guidelines.length})`,
				guidelines.reduce((sum, g) => sum + g.length + 3, 0),
			);
		}
		if (options.appendSystemPrompt) {
			push("--append-system-prompt", options.appendSystemPrompt.length);
		}
	}

	const rest = Math.max(0, totalChars - accounted);
	parts.unshift({
		label: options?.customPrompt ? "glue" : "base prompt",
		chars: rest,
		tokens: tokensFor(rest),
	});

	return { totalTokens: estimate(systemPrompt), totalChars, parts };
}

export function analyzeTools(all: ToolLike[], active: string[], estimate: EstimateText = estimateText): ToolsBreakdown {
	const activeSet = new Set(active);
	const items = all
		.map<ToolStat>((tool) => ({
			name: tool.name,
			tokens: estimate(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })),
			active: activeSet.has(tool.name),
		}))
		.sort((a, b) => Number(b.active) - Number(a.active) || b.tokens - a.tokens);
	const activeItems = items.filter((t) => t.active);
	return {
		activeTokens: activeItems.reduce((sum, t) => sum + t.tokens, 0),
		activeCount: activeItems.length,
		totalCount: items.length,
		items,
	};
}

export function analyzeEntries(
	entries: SessionEntry[],
	estimateMessage: EstimateMessage,
	options: { largest?: number; estimate?: EstimateText } = {},
): MessagesBreakdown {
	const estimate = options.estimate ?? estimateText;
	const limit = options.largest ?? 10;
	const byRole: Record<string, GroupStat> = {};
	const byTool: Record<string, GroupStat> = {};
	const stats: MessageStat[] = [];
	let compaction: MessagesBreakdown["compaction"];
	let index = 0;

	const add = (group: Record<string, GroupStat>, key: string, tokens: number) => {
		const g = (group[key] ??= { count: 0, tokens: 0 });
		g.count += 1;
		g.tokens += tokens;
	};

	for (const entry of entries) {
		if (entry.type === "compaction") {
			const tokens = estimate(entry.summary);
			compaction = { summaryTokens: tokens, tokensBefore: entry.tokensBefore };
			add(byRole, "compaction", tokens);
			stats.push({ index: index++, entryId: entry.id, role: "compaction", tokens, preview: preview(entry.summary) });
			continue;
		}
		if (entry.type === "branch_summary") {
			const tokens = estimate(entry.summary);
			add(byRole, "branchSummary", tokens);
			stats.push({ index: index++, entryId: entry.id, role: "branchSummary", tokens, preview: preview(entry.summary) });
			continue;
		}
		if (entry.type !== "message") continue;

		const message = entry.message as { role: string; toolName?: string; content?: unknown; customType?: string };
		const tokens = safeEstimate(message, estimateMessage, estimate);
		const role = message.role === "custom" ? `custom:${message.customType ?? "?"}` : message.role;
		add(byRole, role, tokens);
		if (message.role === "toolResult" && message.toolName) add(byTool, message.toolName, tokens);
		stats.push({
			index: index++,
			entryId: entry.id,
			role,
			toolName: message.role === "toolResult" ? message.toolName : undefined,
			tokens,
			preview: preview(messageText(message)),
		});
	}

	return {
		totalTokens: stats.reduce((sum, s) => sum + s.tokens, 0),
		count: stats.length,
		byRole,
		byTool,
		largest: [...stats].sort((a, b) => b.tokens - a.tokens).slice(0, limit),
		compaction,
	};
}

export function analyzePayload(payload: unknown, at = Date.now(), estimate: EstimateText = estimateText): RequestStats {
	const json = JSON.stringify(payload) ?? "";
	const stats: RequestStats = {
		at,
		bytes: Buffer.byteLength(json, "utf8"),
		tokensEst: estimate(json),
		shape: "unknown",
	};
	if (!payload || typeof payload !== "object") return stats;
	const body = payload as Record<string, unknown>;

	let messages: unknown[] | undefined;
	if (Array.isArray(body.messages)) {
		messages = body.messages;
		stats.shape = "system" in body ? "anthropic-messages" : "openai-completions";
	} else if (Array.isArray(body.input)) {
		messages = body.input;
		stats.shape = "openai-responses";
	} else if (Array.isArray(body.contents)) {
		messages = body.contents;
		stats.shape = "google-generative-ai";
	}

	let system: unknown = body.system ?? body.instructions ?? body.systemInstruction;
	if (system === undefined && messages && stats.shape === "openai-completions") {
		const head = messages[0] as { role?: string } | undefined;
		if (head && (head.role === "system" || head.role === "developer")) {
			system = head;
			messages = messages.slice(1);
		}
	}
	if (system !== undefined) stats.systemTokens = estimate(stringify(system));

	if (Array.isArray(body.tools)) {
		stats.toolCount = body.tools.length;
		stats.toolsTokens = estimate(JSON.stringify(body.tools));
	}
	if (messages) {
		stats.messageCount = messages.length;
		stats.messagesTokens = estimate(JSON.stringify(messages));
	}
	return stats;
}

export function analyzeUsage(usage: UsageLike): UsageStats {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		promptTokens,
		cachePercent: promptTokens > 0 ? Math.round((usage.cacheRead / promptTokens) * 1000) / 10 : null,
		costTotal: usage.cost?.total,
	};
}

export function compactionInfo(
	contextWindow: number,
	settings: Partial<{ enabled: boolean; reserveTokens: number; keepRecentTokens: number }> = {},
): CompactionInfo {
	const reserveTokens = settings.reserveTokens ?? 16384;
	return {
		enabled: settings.enabled ?? true,
		reserveTokens,
		keepRecentTokens: settings.keepRecentTokens ?? 20000,
		compactAt: Math.max(0, contextWindow - reserveTokens),
	};
}

function safeEstimate(message: unknown, estimateMessage: EstimateMessage, estimate: EstimateText): number {
	try {
		const n = estimateMessage(message);
		if (Number.isFinite(n) && n > 0) return n;
	} catch {
		// fall through to text estimate
	}
	return estimate(messageText(message as { content?: unknown }));
}

function messageText(message: { content?: unknown; role?: string }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
		else if (block.type === "toolCall") parts.push(`→ ${String(block.name)} ${JSON.stringify(block.arguments ?? {})}`);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

/** Длина фрагмента от открывающего до закрывающего маркера включительно, или undefined. */
function blockLength(text: string, open: string, close: string): number | undefined {
	const start = text.indexOf(open);
	if (start < 0) return undefined;
	const end = text.indexOf(close, start + open.length);
	if (end < 0) return undefined;
	return end + close.length - start;
}

function stringify(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function preview(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function shortPath(path: string, cwd: string): string {
	const normalized = path.replace(/\\/g, "/");
	const base = cwd.replace(/\\/g, "/").replace(/\/$/, "");
	if (normalized.startsWith(`${base}/`)) return `./${normalized.slice(base.length + 1)}`;
	const home = (process.env.HOME ?? process.env.USERPROFILE ?? "").replace(/\\/g, "/");
	if (home && normalized.startsWith(home)) return `~${normalized.slice(home.length)}`;
	return normalized;
}
