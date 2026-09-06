/**
 * session-trace — разбор JSONL-сессий pi в нормализованную ленту для графа.
 * Формат файла: ~/.pi/agent/sessions/<--path-->/<ts>_<uuid>.jsonl, версия 3.
 * См. docs/session-format.md в дистрибутиве pi.
 */

export interface Chip {
	callId: string;
	name: string;
	label: string;
	status: "running" | "ok" | "error";
	startMs: number;
	endMs?: number;
}

export interface TurnItem {
	kind: "turn";
	index: number;
	startMs: number;
	model?: string;
	tokensOut?: number;
	cost?: number;
	text?: string;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	chips: Chip[];
}

export interface UserItem {
	kind: "user";
	ts: number;
	text: string;
}

export interface BashItem {
	kind: "bash";
	ts: number;
	command: string;
	exitCode?: number;
}

export interface MarkerItem {
	kind: "marker";
	ts: number;
	icon: string;
	text: string;
}

export interface ChildItem {
	kind: "child";
	ts: number;
	agent: string;
	task: string;
	session: string;
	model?: string;
	tokensOut?: number;
	cost?: number;
}

export type Item = TurnItem | UserItem | BashItem | MarkerItem | ChildItem;

// ---------- форматирование ----------

export function fmtK(n: number): string {
	if (!Number.isFinite(n) || n === 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtDur(ms?: number): string {
	if (ms === undefined || !Number.isFinite(ms)) return "";
	if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export function fmtClock(ms: number): string {
	const d = new Date(ms);
	const p = (x: number) => String(x).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtMoney(c: number): string {
	if (!Number.isFinite(c) || c === 0) return "";
	return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

export function oneLine(s: unknown, max = 80): string {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function entryMs(e: any): number {
	const t = e?.message?.timestamp;
	if (typeof t === "number") return t;
	const p = Date.parse(e?.timestamp ?? "");
	return Number.isFinite(p) ? p : 0;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: any) => b?.type === "text")
			.map((b: any) => b.text ?? "")
			.join(" ");
	}
	return "";
}

function chipLabel(args: any): string {
	const a = args ?? {};
	if (typeof a.agent === "string" && a.agent && a.task) return oneLine(`${a.agent}: ${a.task}`, 60); // subagent
	if (typeof a.path === "string" && a.path) return oneLine(a.path, 42);
	if (typeof a.file_path === "string" && a.file_path) return oneLine(a.file_path, 42);
	if (typeof a.command === "string" && a.command) return oneLine(a.command, 48);
	if (typeof a.query === "string" && a.query) return oneLine(a.query, 42);
	if (typeof a.url === "string" && a.url) return oneLine(a.url, 42);
	try {
		return oneLine(JSON.stringify(a), 42);
	} catch {
		return "";
	}
}

// ---------- модель ----------

export class GraphModel {
	items: Item[] = [];
	sessionName?: string;
	cwd?: string;
	totals = { input: 0, output: 0, cost: 0 };
	/** итого по моделям: model -> [turns, input, output, cost] */
	models = new Map<string, { turns: number; input: number; output: number; cost: number }>();
	version = 0;

	private turnNo = 0;
	private byCallId = new Map<string, { turn: TurnItem; chip: Chip }>();

	feedEntry(e: any): void {
		this.version++;
		if (!e || typeof e !== "object") return;
		const ts = entryMs(e);
		switch (e.type) {
			case "session":
				this.cwd = e.cwd;
				break;
			case "session_info":
				if (e.name) this.sessionName = e.name;
				break;
			case "model_change":
				this.marker(ts, "⚙", `model → ${e.provider}/${e.modelId}`);
				break;
			case "thinking_level_change":
				this.marker(ts, "✦", `thinking: ${e.thinkingLevel}`);
				break;
			case "compaction": {
				const k = e.tokensBefore ? ` · ${fmtK(e.tokensBefore)} tok` : "";
				this.marker(ts, "↻", `compaction${k}`);
				break;
			}
			case "branch_summary":
				this.marker(ts, "⑂", oneLine(e.summary ?? "branch", 90));
				break;
			case "label":
				if (e.label) this.marker(ts, "⚑", oneLine(e.label, 60));
				break;
			case "custom":
				// session-trace:subagents — связка «главная сессия → сессии субагентов».
				// Старое имя pitrace:subagents принято для сессий, записанных до переименования.
				if ((e.customType === "session-trace:subagents" || e.customType === "pitrace:subagents") && e.data?.session) {
					this.items.push({
						kind: "child",
						ts,
						agent: String(e.data.agent ?? "?"),
						task: oneLine(e.data.task ?? "", 90),
						session: String(e.data.session),
						model: e.data.model,
						tokensOut: e.data.usage?.output,
						cost: e.data.usage?.cost,
					});
				}
				break;
			case "message":
				this.feedMessage(e, ts);
				break;
			default:
				break; // custom, custom_message, … — пока не рисуем
		}
	}

	private marker(ts: number, icon: string, text: string): void {
		this.items.push({ kind: "marker", ts, icon, text });
	}

	private feedMessage(e: any, ts: number): void {
		const m = e.message;
		if (!m) return;
		switch (m.role) {
			case "user": {
				const text = oneLine(contentText(m.content), 100);
				if (text) this.items.push({ kind: "user", ts, text });
				break;
			}
			case "bashExecution": {
				this.items.push({
					kind: "bash",
					ts,
					command: oneLine(m.command, 90),
					exitCode: m.exitCode,
				});
				break;
			}
			case "assistant":
				this.feedAssistant(m, ts);
				break;
			case "toolResult":
				this.resolveChip(m, ts);
				break;
			default:
				break;
		}
	}

	private feedAssistant(m: any, ts: number): void {
		this.turnNo++;
		const turn: TurnItem = {
			kind: "turn",
			index: this.turnNo,
			startMs: ts,
			model: m.model,
			tokensOut: m.usage?.output,
			cost: m.usage?.cost?.total,
			stopReason: m.stopReason,
			errorMessage: m.errorMessage,
			chips: [],
		};
		this.totals.input += m.usage?.input ?? 0;
		this.totals.output += m.usage?.output ?? 0;
		this.totals.cost += m.usage?.cost?.total ?? 0;
		const mk = m.model || "?";
		const agg = this.models.get(mk) ?? { turns: 0, input: 0, output: 0, cost: 0 };
		agg.turns++;
		agg.input += m.usage?.input ?? 0;
		agg.output += m.usage?.output ?? 0;
		agg.cost += m.usage?.cost?.total ?? 0;
		this.models.set(mk, agg);

		if (Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b?.type === "toolCall" && b.id) {
					const chip: Chip = {
						callId: b.id,
						name: b.name ?? "?",
						label: chipLabel(b.arguments),
						status: "running",
						startMs: ts,
					};
					turn.chips.push(chip);
					this.byCallId.set(b.id, { turn, chip });
				} else if (b?.type === "thinking") {
					turn.thinking = oneLine(b.thinking, 96);
				} else if (b?.type === "text" && !turn.text) {
					turn.text = oneLine(b.text, 96);
				}
			}
		}
		this.items.push(turn);
	}

	private resolveChip(m: any, ts: number): void {
		const hit = this.byCallId.get(m.toolCallId);
		if (!hit) return;
		hit.chip.status = m.isError ? "error" : "ok";
		hit.chip.endMs = ts;
	}
}
