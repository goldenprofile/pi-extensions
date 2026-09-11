/**
 * Result extraction from a finished subagent's session file (JSONL).
 *
 * The parent never talks to the child's process graph — it reads the transcript
 * the child left behind: the last assistant message becomes the reported
 * summary, usage is totaled across assistant messages (same shape session-ledger
 * consumes: usage.input / usage.output / usage.cost.total).
 *
 * Deliberately dependency-free so tests can run standalone.
 */
import { readFileSync } from "node:fs";

export interface SessionUsageTotals {
	input: number;
	output: number;
	cost: number;
}

export interface SessionSummary {
	summary: string;
	usage: SessionUsageTotals | null;
	model: string | null;
}

interface AssistantMessage {
	role?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: Array<{ type?: string; text?: string }>;
	usage?: {
		input?: number;
		output?: number;
		cost?: { total?: number };
	};
}

function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => (part.text ?? "").trim())
		.filter(Boolean)
		.join("\n\n");
}

/**
 * Summarize a session file. `fallback` is returned as the summary when the
 * file is missing, unreadable, or has no assistant text (crashed before the
 * first response, for instance).
 */
export function summarizeSessionFile(jsonlPath: string, fallback: string): SessionSummary {
	let raw: string;
	try {
		raw = readFileSync(jsonlPath, "utf8");
	} catch {
		return { summary: fallback, usage: null, model: null };
	}

	let lastText = "";
	let lastModel: string | null = null;
	let lastError: string | null = null;
	const usage: SessionUsageTotals = { input: 0, output: 0, cost: 0 };
	let sawUsage = false;

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: { type?: string; message?: AssistantMessage };
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const message = entry.message;
		const text = assistantText(message);
		if (text) {
			lastText = text;
			lastError = null;
		}
		if (message.stopReason === "error") {
			lastError = message.errorMessage?.trim() || "assistant turn ended with stopReason=error";
		}
		if (message.model) lastModel = message.model;
		if (message.usage && (message.usage.input != null || message.usage.output != null)) {
			usage.input += message.usage.input ?? 0;
			usage.output += message.usage.output ?? 0;
			usage.cost += message.usage.cost?.total ?? 0;
			sawUsage = true;
		}
	}

	const summary =
		lastText ||
		(lastError ? `Subagent error: ${lastError}` : "") ||
		fallback;

	return {
		summary,
		usage: sawUsage ? usage : null,
		model: lastModel,
	};
}

/** Compact "12.3k in / 4.5k out / $0.0123" formatting for steer messages. */
export function formatUsage(usage: SessionUsageTotals): string {
	const k = (n: number): string =>
		n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
	const parts = [`${k(usage.input)} in`, `${k(usage.output)} out`];
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" / ");
}
