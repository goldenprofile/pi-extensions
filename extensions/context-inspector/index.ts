/**
 * context-inspector: что модель реально видит в запросе.
 *
 *   /context          отчёт: занятость окна, кэш, system prompt по частям, схемы инструментов,
 *                     сообщения по ролям и инструментам, самые тяжёлые записи
 *   /context status   включить/выключить строку в футере (ctx 42K/200K 21% · cache 91% …)
 *   /context log      включить/выключить запись снимков в .pi/context-inspector.jsonl
 *
 * Источники: before_agent_start (структура system prompt), before_provider_request (реальный
 * payload), message_end (usage провайдера), sessionManager.buildContextEntries() (что в контексте).
 * Ничего не блокирует и не меняет.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type BuildSystemPromptOptions,
	CONFIG_DIR_NAME,
	estimateTokens,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	analyzeEntries,
	analyzePayload,
	analyzeSystemPrompt,
	analyzeTools,
	analyzeUsage,
	compactionInfo,
	type RequestStats,
	type Snapshot,
	type UsageStats,
} from "./analyze.ts";
import { renderReport, summaryLine } from "./report.ts";
import { ReportView } from "./view.ts";

const STATUS_KEY = "context-inspector";

interface CompactionSettingsLike {
	enabled?: boolean;
	reserveTokens?: number;
	keepRecentTokens?: number;
}

function readCompactionSettings(cwd: string): CompactionSettingsLike {
	const result: CompactionSettingsLike = {};
	for (const file of [join(getAgentDir(), "settings.json"), join(cwd, CONFIG_DIR_NAME, "settings.json")]) {
		try {
			if (!existsSync(file)) continue;
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { compaction?: CompactionSettingsLike };
			Object.assign(result, parsed.compaction ?? {});
		} catch {
			// повреждённый settings.json не должен ломать инспектор
		}
	}
	return result;
}

export default function (pi: ExtensionAPI) {
	let systemPrompt: string | undefined;
	let systemPromptOptions: BuildSystemPromptOptions | undefined;
	let lastRequest: RequestStats | undefined;
	let lastUsage: UsageStats | undefined;
	let showStatus = true;
	let logEnabled = false;

	const estimateMessage = (message: unknown) => estimateTokens(message as Parameters<typeof estimateTokens>[0]);

	const buildSnapshot = (ctx: ExtensionContext, commandCtx?: ExtensionCommandContext): Snapshot => {
		const prompt = commandCtx ? ctx.getSystemPrompt() : (systemPrompt ?? ctx.getSystemPrompt());
		const options = commandCtx?.getSystemPromptOptions?.() ?? systemPromptOptions;
		const model = ctx.model;
		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;

		return {
			at: Date.now(),
			model: model
				? { provider: model.provider, id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens }
				: undefined,
			occupancy: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : undefined,
			compaction: compactionInfo(contextWindow, readCompactionSettings(ctx.cwd)),
			system: analyzeSystemPrompt(prompt, options),
			tools: analyzeTools(pi.getAllTools(), pi.getActiveTools()),
			messages: analyzeEntries(ctx.sessionManager.buildContextEntries(), estimateMessage),
			lastRequest,
			lastUsage,
		};
	};

	const updateStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!showStatus) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		try {
			ctx.ui.setStatus(STATUS_KEY, summaryLine(buildSnapshot(ctx)));
		} catch {
			// статус вторичен; ошибки оценки не должны мешать работе
		}
	};

	const logSnapshot = (ctx: ExtensionContext, reason: string) => {
		if (!logEnabled) return;
		try {
			const file = join(ctx.cwd, CONFIG_DIR_NAME, "context-inspector.jsonl");
			mkdirSync(dirname(file), { recursive: true });
			const snapshot = buildSnapshot(ctx);
			appendFileSync(file, `${JSON.stringify({ reason, session: ctx.sessionManager.getSessionFile(), ...snapshot })}\n`, "utf8");
		} catch {
			// лог опционален
		}
	};

	pi.on("before_agent_start", (event) => {
		systemPrompt = event.systemPrompt;
		systemPromptOptions = event.systemPromptOptions;
	});

	pi.on("before_provider_request", (event) => {
		lastRequest = analyzePayload(event.payload);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const message = event.message as { usage?: Parameters<typeof analyzeUsage>[0]; stopReason?: string };
		if (!message.usage || message.stopReason === "aborted" || message.stopReason === "error") return;
		lastUsage = analyzeUsage(message.usage);
		updateStatus(ctx);
		logSnapshot(ctx, "message_end");
	});

	pi.on("session_start", (_event, ctx) => {
		lastRequest = undefined;
		lastUsage = undefined;
		updateStatus(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		updateStatus(ctx);
		logSnapshot(ctx, "session_compact");
	});

	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("context", {
		description: "Context inspector: what the model actually sees (system prompt, tools, messages, cache)",
		getArgumentCompletions: (prefix) => {
			const items = ["status", "log"].filter((v) => v.startsWith(prefix)).map((v) => ({ value: v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();

			if (arg === "status") {
				showStatus = !showStatus;
				updateStatus(ctx);
				ctx.ui.notify(`context-inspector: footer status ${showStatus ? "on" : "off"}`, "info");
				return;
			}
			if (arg === "log") {
				logEnabled = !logEnabled;
				ctx.ui.notify(
					`context-inspector: snapshot log ${logEnabled ? `on → ${join(CONFIG_DIR_NAME, "context-inspector.jsonl")}` : "off"}`,
					"info",
				);
				return;
			}

			const snapshot = buildSnapshot(ctx, ctx);
			if (ctx.mode !== "tui") {
				const text = renderReport(snapshot, 120).join("\n");
				ctx.ui.notify(ctx.hasUI ? summaryLine(snapshot) : text, "info");
				if (!ctx.hasUI) process.stdout.write(`${text}\n`);
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				return new ReportView({
					tui,
					theme,
					snapshot,
					refresh: () => buildSnapshot(ctx, ctx),
					onClose: () => done(),
				});
			});
		},
	});
}
