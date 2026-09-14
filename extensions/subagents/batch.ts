/**
 * Headless batch execution of subagent tasks (the `task_batch` tool).
 *
 * Blocking counterpart to the pane-based `subagent` tool: children run as
 * isolated `pi --mode json -p` processes, the tool waits, and all results come
 * back in the tool response. Modes: single, parallel (up to 8, concurrency 4),
 * chain (sequential, `{previous}` placeholder pipes output between steps).
 *
 * Every child gets a pre-created session file under the agent dir so /trace
 * can render it as a child card, and a native `-xt` denylist that removes the
 * pane tools — they are useless without a watchable pane and only burn child
 * context. (The old fork tried env vars for this; pi never honored them.)
 *
 * Pure logic (event ingestion, chaining, formatting) is separated from the
 * thin process runner so tests run without spawning anything.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { addRunningWorker, removeRunningWorker, runningIndexPath } from "./running-index.ts";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

// ── Types ──

export interface BatchUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export function emptyUsage(): BatchUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Structural subset of pi's assistant/user/toolResult messages we rely on. */
export interface BatchMessage {
	role?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
		totalTokens?: number;
	};
	content?: Array<{ type?: string; text?: string; name?: string; arguments?: Record<string, unknown> }>;
}

export interface BatchResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: BatchMessage[];
	stderr: string;
	usage: BatchUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	sessionFile?: string;
	/** Parallel placeholder whose concurrency slot has not opened yet. */
	queued?: boolean;
	/** Unix ms when the child spawn was attempted (drives live elapsed). */
	startedAt?: number;
	/** Wall-clock duration of the child run; set on exit. */
	elapsedMs?: number;
	/** Unix ms when the child exited (batch wall time = max end − min start). */
	finishedAt?: number;
}

export function emptyResult(agent: string, task: string): BatchResult {
	return { agent, task, exitCode: 0, messages: [], stderr: "", usage: emptyUsage() };
}

/** Exit code -1 marks a placeholder; `queued` distinguishes not-yet-started. */
export function isRunning(r: BatchResult): boolean {
	return r.exitCode === -1 && r.queued !== true;
}

/** Parallel placeholder waiting for a concurrency slot (no child spawned yet). */
export function isQueued(r: BatchResult): boolean {
	return r.exitCode === -1 && r.queued === true;
}

export function isFailedResult(r: BatchResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

// ── Pure logic ──

export function finalOutput(messages: BatchMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content ?? []) {
			if (part.type === "text") return part.text ?? "";
		}
	}
	return "";
}

export function resultOutput(r: BatchResult): string {
	if (isFailedResult(r)) {
		return r.errorMessage || r.stderr || finalOutput(r.messages) || "(no output)";
	}
	return finalOutput(r.messages) || "(no output)";
}

export function substitutePrevious(task: string, previousOutput: string): string {
	return task.replace(/\{previous\}/g, previousOutput);
}

export function truncateOutput(output: string, cap = PER_TASK_OUTPUT_CAP): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= cap) return output;
	let truncated = output.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

/**
 * Ingest one `pi --mode json` stdout event into the accumulating result.
 * Handles `message_end` (collect messages, per-assistant usage/turns, model,
 * stopReason, errors) and `tool_result_end`. Returns true when something was
 * ingested (callers emit a progress update then).
 */
export function ingestBatchEvent(r: BatchResult, event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: string }).type;

	if (type === "message_end" && (event as { message?: BatchMessage }).message) {
		const msg = (event as { message: BatchMessage }).message;
		r.messages.push(msg);
		if (msg.role === "assistant") {
			r.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				r.usage.input += usage.input || 0;
				r.usage.output += usage.output || 0;
				r.usage.cacheRead += usage.cacheRead || 0;
				r.usage.cacheWrite += usage.cacheWrite || 0;
				r.usage.cost += usage.cost?.total || 0;
				r.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!r.model && msg.model) r.model = msg.model;
			if (msg.stopReason) r.stopReason = msg.stopReason;
			if (msg.errorMessage) r.errorMessage = msg.errorMessage;
		}
		return true;
	}

	if (type === "tool_result_end" && (event as { message?: BatchMessage }).message) {
		r.messages.push((event as { message: BatchMessage }).message);
		return true;
	}

	return false;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ── Formatting (shared by renderers) ──

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export { formatTokens };

/** Flatten to one line and cap length: “failed (reason)” material. */
export function oneline(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(max - 1, 0))}…` : flat;
}

/** First non-empty lines, with a “[+N more lines]” marker when trimmed. */
export function firstLines(text: string, max = 3): string {
	const lines = text
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim().length > 0);
	if (lines.length === 0) return "";
	const shown = lines.slice(0, max);
	const rest = lines.length - shown.length;
	return shown.join("\n") + (rest > 0 ? `\n[+${rest} more lines]` : "");
}

/** Tool-call summary for a compact task line: “bash ×3, read ×2”. */
export function summarizeTools(items: DisplayItem[]): string {
	const counts = new Map<string, number>();
	for (const item of items) {
		if (item.type !== "toolCall") continue;
		const name = item.name ?? "?";
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
}

/**
 * Batch wall time: earliest spawn to latest exit (running batches project to
 * `now`). Tasks overlap under concurrency — never sum the per-task durations.
 */
export function batchWallTime(results: BatchResult[], now: number = Date.now()): number | undefined {
	const starts = results.map((r) => r.startedAt).filter((t): t is number => typeof t === "number");
	if (starts.length === 0) return undefined;
	const ends = results.map((r) => r.finishedAt).filter((t): t is number => typeof t === "number");
	// Any started-but-unfinished task keeps the batch open: end = now.
	const hasUnfinished = results.some((r) => r.startedAt !== undefined && r.finishedAt === undefined);
	const end = hasUnfinished ? Math.max(now, ...ends, 0) : Math.max(...ends);
	return Math.max(0, end - Math.min(...starts));
}

export function formatUsageStats(
	usage: BatchUsage,
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cost > 0) parts.push(`$${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(2)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

// ── Live progress: spinner, bar, durations ──

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Spinner frame for a point in time; renders advance via the batch tick. */
export function spinnerFrame(now: number = Date.now()): string {
	return SPINNER_FRAMES[Math.floor(now / 140) % SPINNER_FRAMES.length] ?? "⠋";
}

/** Fraction bar: progressBar(3, 8, 8) → "▰▰▰▱▱▱▱▱"; clamps out-of-range input. */
export function progressBar(done: number, total: number, width = 12): string {
	const safeTotal = Math.max(total, 0);
	const ratio = safeTotal === 0 ? 0 : Math.min(Math.max(done, 0), safeTotal) / safeTotal;
	const filled = Math.round(ratio * width);
	return "▰".repeat(filled) + "▱".repeat(Math.max(width - filled, 0));
}

/** Compact duration: 400ms → "<1s", 42s → "42s", 64.2s → "1m04s". */
export function formatDuration(ms: number): string {
	if (ms < 1000) return "<1s";
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const min = Math.floor(totalSec / 60);
	return `${min}m${String(totalSec % 60).padStart(2, "0")}s`;
}

/**
 * Elapsed time for display: finished tasks report the measured duration,
 * running ones project from startedAt (grows across tick re-renders).
 */
export function elapsedOf(r: BatchResult, now: number = Date.now()): number | undefined {
	if (r.elapsedMs !== undefined) return r.elapsedMs;
	if (r.exitCode === -1 && r.startedAt !== undefined) return Math.max(0, now - r.startedAt);
	return undefined;
}

type ThemeFg = (color: string, text: string) => string;

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: ThemeFg,
): string {
	const shortenPath = (p: string) => {
		const home = (typeof process !== "undefined" ? process.env.USERPROFILE || process.env.HOME : "") ?? "";
		return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

/** Tool calls + text items for TUI rendering. */
export interface DisplayItem {
	type: "text" | "toolCall";
	text?: string;
	name?: string;
	args?: Record<string, unknown>;
}

export function displayItems(messages: BatchMessage[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content ?? []) {
			if (part.type === "text") items.push({ type: "text", text: part.text });
			else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
		}
	}
	return items;
}

// ── Process runner ──

/**
 * Prefer launching pi the way the current process was launched
 * (`node <pi.js>`), falling back to the `pi` shim on PATH — the shim can be
 * missing inside restricted environments, while argv[1] always points at the
 * running CLI script.
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript) && currentScript.toLowerCase().endsWith(".js")) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

/**
 * Windows: pi on PATH is an npm .cmd shim, and Node refuses to spawn .cmd
 * files directly (EINVAL since 18.20+). Parse the shim and return the real
 * entry (node + the .js it wraps). Returns null when the shim can't be parsed.
 */
export function resolvePiEntry(piCmdPath: string): { command: string; args: string[] } | null {
	if (!/\.cmd$/i.test(piCmdPath)) return null;
	try {
		const content = readFileSync(piCmdPath, "utf8");
		const jsPaths = [...content.matchAll(/"([^"\r\n]+\.js)"/g)].map((m) => m[1] ?? "");
		const raw = jsPaths.at(-1);
		if (!raw) return null;
		const base = dirname(piCmdPath);
		const script = raw.replace(/^%~dp0\\?/i, base + "\\").replace(/^%dp0%\\?/i, base + "\\");
		if (!existsSync(script)) return null;
		return { command: process.execPath, args: [script] };
	} catch {
		return null;
	}
}

export interface HeadlessChildOptions {
	agentName: string;
	agentLabel: string;
	task: string;
	cwd: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	appendSystemPrompt?: string;
	denyTools?: string[];
	defaultCwd: string;
	sessionsRoot: string;
	/** Batch mode label (single | parallel | chain) for the running index. */
	batchMode?: string;
	/** Spawner session id, recorded in the running index. */
	spawnerSession?: string;
	/** Absolute pi CLI path; preferred on Windows where spawning .cmd shims directly fails (EINVAL). */
	piPath?: string;
	signal?: AbortSignal;
	onEvent?: (r: BatchResult) => void;
	step?: number;
}

/**
 * Run one headless child: `pi --mode json -p --session <pre-created>` with the
 * task as the prompt. The session file is created before spawn so the parent
 * knows the path up front (no race between parallel children). Also registers
 * in the global running index for the duration of the run, so /workers and
 * /trace can discover live children from any session.
 */
export async function runHeadlessChild(opts: HeadlessChildOptions): Promise<BatchResult> {
	mkdirSync(opts.sessionsRoot, { recursive: true });
	const childSession = join(
		opts.sessionsRoot,
		`${new Date().toISOString().replace(/[:.]/g, "-")}_${opts.agentName.replace(/[^\w-]/g, "")}_${randomUUID().slice(0, 8)}.jsonl`,
	);
	writeFileSync(
		childSession,
		JSON.stringify({
			type: "session",
			version: 3,
			id: randomUUID(),
			timestamp: new Date().toISOString(),
			cwd: opts.cwd,
		}) + "\n",
	);

	const args: string[] = ["--mode", "json", "-p", "--session", childSession];
	if (opts.model) args.push("--model", opts.model);
	if (opts.thinking) args.push("--thinking", opts.thinking);
	if (opts.tools && opts.tools.length > 0) {
		args.push("--tools", opts.tools.join(","));
	} else if (opts.denyTools && opts.denyTools.length > 0) {
		// Native denylist — actually removes the tools (env-based attempts were
		// never honored by pi). Keeps task_batch itself available for nesting.
		args.push("-xt", opts.denyTools.join(","));
	}
	let promptFile: string | null = null;
	if (opts.appendSystemPrompt) {
		// Identity via a temp file: system prompts can be long, and Windows
		// command lines are not.
		promptFile = join(opts.sessionsRoot, `.identity-${randomUUID().slice(0, 8)}.md`);
		writeFileSync(promptFile, opts.appendSystemPrompt, "utf8");
		args.push("--append-system-prompt", promptFile);
	}
	args.push(`Task: ${opts.task}`);

	const result = emptyResult(opts.agentLabel, opts.task);
	result.step = opts.step;
	result.sessionFile = childSession;
	result.startedAt = Date.now();
	const workerId = `${opts.agentName.replace(/[^\w-]/g, "")}-${randomUUID().slice(0, 8)}`;
	const indexPath = runningIndexPath(opts.sessionsRoot);
	const unregister = () => removeRunningWorker(indexPath, workerId);
	const markElapsed = () => {
		if (result.startedAt !== undefined) {
			result.finishedAt = Date.now();
			result.elapsedMs = result.finishedAt - result.startedAt;
		}
	};

	try {
		await new Promise<void>((resolve) => {
			// Resolve the spawn target: explicit piPath (resolving .cmd shims to
			// node + their .js entry), else argv-based invocation, else "pi".
			let command: string;
			let spawnArgs: string[];
			if (opts.piPath && /\.cmd$/i.test(opts.piPath)) {
				const entry = resolvePiEntry(opts.piPath);
				if (entry) {
					command = entry.command;
					spawnArgs = [...entry.args, ...args];
				} else {
					command = opts.piPath;
					spawnArgs = args;
				}
			} else if (opts.piPath) {
				command = opts.piPath;
				spawnArgs = args;
			} else {
				const inv = getPiInvocation(args);
				command = inv.command;
				spawnArgs = inv.args;
			}

			let proc: ReturnType<typeof spawn>;
			try {
				proc = spawn(command, spawnArgs, {
					cwd: opts.cwd ?? opts.defaultCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				// Registered only after a successful spawn: a PID-less record is
				// unusable for liveness checks.
				addRunningWorker(indexPath, {
					id: workerId,
					pid: proc.pid ?? -1,
					label: opts.agentLabel,
					task: opts.task,
					model: opts.model,
					mode: opts.batchMode,
					step: opts.step,
					startedAt: result.startedAt ?? Date.now(),
					sessionFile: childSession,
					spawnerSession: opts.spawnerSession,
					cwd: opts.cwd,
				});
			} catch (err) {
				// Sync spawn failure (e.g. EINVAL on an unspawnable shim).
				result.exitCode = 1;
				result.errorMessage = `failed to spawn ${command}: ${err instanceof Error ? err.message : String(err)}`;
				markElapsed();
				resolve();
				return;
			}

			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const event = JSON.parse(line);
					if (ingestBatchEvent(result, event)) opts.onEvent?.(result);
				} catch {
					// Non-JSON line — ignore.
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				result.exitCode = code ?? 0;
				markElapsed();
				resolve();
			});
			proc.on("error", (err) => {
				result.exitCode = 1;
				result.errorMessage = `failed to spawn ${command}: ${err.message}`;
				markElapsed();
				resolve();
			});

			if (opts.signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (opts.signal.aborted) kill();
				else opts.signal.addEventListener("abort", kill, { once: true });
			}
		});
	} finally {
		unregister();
		if (promptFile) {
			try {
				unlinkSync(promptFile);
			} catch {
				// Best effort.
			}
		}
	}

	return result;
}

/** Append-only reader used by tests to mirror live ingestion from a file. */
export function ingestJsonlFile(path: string, r: BatchResult): void {
	const raw = readFileSync(path, "utf8");
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			ingestBatchEvent(r, JSON.parse(trimmed));
		} catch {
			// Skip malformed lines.
		}
	}
}
