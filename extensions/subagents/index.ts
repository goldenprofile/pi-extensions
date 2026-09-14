/**
 * Interactive subagents for pi — Windows edition: WezTerm/herdr panes + pwsh.
 *
 * Spawn a sub-agent into its own terminal pane (WezTerm, or herdr when pi
 * runs inside herdr), keep working in the main session, and get the result
 * steered back when it finishes. Fully non-blocking. Adapted from
 * amosblomqvist/pi-interactive-subagents (tmux) with the surface layer
 * rewritten for `wezterm cli` / `herdr pane` + PowerShell 7.
 *
 * Tools:
 *   subagent         — spawn a sub-agent in a dedicated pane (fire-and-forget)
 *   subagent_message — message by name: steers a running one, resumes a
 *                      finished one (same name either way); optional
 *                      interrupt escapes the current turn first
 *   subagent_cancel  — stop a running sub-agent: interrupt + cancel sidecar
 *   subagents_list   — list available agent definitions
 *   /subagent        — spawn from the keyboard
 *
 * One extension, two roles: in a normal session it is the orchestrator; when
 * loaded inside a subagent that may spawn children (agent frontmatter
 * `subagents:`), PI_SUBAGENT_ALLOWED restricts it to exactly those agents.
 * The child-side identity/auto-exit behavior lives in subagent-done.ts.
 *
 * Completion is detected file-first: the launcher writes a `.done` sidecar
 * with the exit code, error turns write a `.exit` sidecar, and the screen
 * sentinel `__SUBAGENT_DONE_<code>__` is the last-resort fallback. On success
 * inside herdr the pane collapses right after the result is delivered; under
 * WezTerm it stays open at a pwsh prompt — transcript visible, resume is one
 * command away.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, TruncatedText, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents, type AgentDef } from "./agents.ts";
import { activityLabel, readActivityState, type SubagentActivityState } from "./activity.ts";
import {
	displayItems,
	elapsedOf,
	emptyResult,
	batchWallTime,
	firstLines,
	formatDuration,
	formatTokens,
	formatToolCall,
	formatUsageStats,
	finalOutput,
	isFailedResult,
	isQueued,
	isRunning,
	mapWithConcurrencyLimit,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	oneline,
	progressBar,
	resultOutput,
	runHeadlessChild,
	spinnerFrame,
	substitutePrevious,
	summarizeTools,
	truncateOutput,
	type BatchMessage,
	type BatchResult,
} from "./batch.ts";
import { renderLauncherPs1, type LauncherSpec } from "./launcher.ts";
import { formatUsage, summarizeSessionFile } from "./session-read.ts";
import { readNameRegistry, registryPath, uniqueName, upsertName, type RegistryEntry } from "./registry.ts";
import {
	activeBackend,
	closePane,
	createSubagentPane,
	listPaneIds,
	paneExists,
	parseSentinel,
	readScreenTail,
	runScriptInPane,
	sendInterrupt,
	sendText,
} from "./mux.ts";
import { cancelSidecarPath, classifyExitSidecar, resolveInterrupt } from "./shared.ts";
import { readRunningWorkers, runningIndexPath } from "./running-index.ts";

const POLL_INTERVAL_MS = 1000;
// Five minutes of ZERO events — streaming deltas and tool output count as
// events (activity heartbeats), so a healthy long model stream no longer
// trips this. Only a truly silent pane does.
const STALLED_AFTER_MS = 5 * 60_000;
// After subagent_cancel, the child should honor the flag within ~1s; if the
// pane is still there after this grace period, force-close it.
const CANCEL_KILL_AFTER_MS = 10_000;
// Esc → pi aborts its turn; give it a moment to settle before typing the
// steer message into the fresh prompt.
const INTERRUPT_SETTLE_MS = 1200;
const MAX_SUMMARY_CHARS = 2000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DONE_EXTENSION_PATH = join(MODULE_DIR, "subagent-done.ts");

/**
 * Tool names that live in other extensions. Pane children with a `tools:`
 * list run with `-ne` (only done/identity extensions), so an extension tool
 * in the list (web_search/web_fetch for the researcher) would silently not
 * exist. Map them to their extension entry so we can attach it explicitly.
 */
const EXTENSION_TOOL_PATHS: Record<string, string> = {
	web_search: "web-search/index.ts",
	web_fetch: "web-search/index.ts",
};

function extensionPathsForTools(tools: string[] | undefined): string[] {
	if (!tools) return [];
	const extRoot = join(getAgentDir(), "extensions");
	const paths = new Set<string>();
	for (const tool of tools) {
		const rel = EXTENSION_TOOL_PATHS[tool];
		if (rel) {
			const full = join(extRoot, rel);
			if (existsSync(full)) paths.add(full);
		}
	}
	return [...paths];
}

// ── Types ──

interface ActivityObservation {
	state: SubagentActivityState | null;
	lastChangeAt: number;
	stalled: boolean;
}

interface RunningSubagent {
	id: string;
	name: string;
	agentName: string;
	task: string;
	paneId: string;
	startTime: number;
	sessionFile: string;
	activityFile: string;
	doneFile: string;
	exitSidecarFile: string;
	autoExit: boolean;
	agentDef: AgentDef | null;
	activity: ActivityObservation;
	/** Set by subagent_cancel — armed the pane force-close grace period. */
	cancelRequested: boolean;
	cancelStartedAt?: number;
}

interface SpawnParams {
	agent: string;
	task: string;
	name?: string;
	model?: string;
	cwd?: string;
}

interface SubagentResultSummary {
	name: string;
	task: string;
	agentName: string;
	summary: string;
	exitCode: number;
	elapsedSec: number;
	sessionFile: string;
	errorMessage?: string;
	usageText?: string;
	model?: string;
}

// ── Module state (one set per live session; reset in session_start) ──

let latestPi: ExtensionAPI | null = null;
let latestCtx: ExtensionContext | null = null;
let runningSubagents = new Map<string, RunningSubagent>();
let columnPanes: string[] = [];
let tickTimer: ReturnType<typeof setInterval> | null = null;
let pollAbort: AbortController | null = null;
let cachedPiPath: string | null = null;

/** Spawn/rename state shared with subagent-done.ts via a process-global. */
function publishRunningChildrenCount(): void {
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents/running-children-count")] =
		() => runningSubagents.size;
}
publishRunningChildrenCount();

function isChildSession(): boolean {
	return !!process.env.PI_SUBAGENT_SESSION;
}

function allowedAgentsInChild(): Set<string> | null {
	const raw = process.env.PI_SUBAGENT_ALLOWED;
	if (!raw) return null;
	const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
	return new Set(names);
}

// ── Small helpers ──

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtElapsed(sec: number): string {
	if (sec < 60) return `${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (m < 60) return `${m}m${String(s).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function safeFilePart(s: string): string {
	const cleaned = s
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return cleaned || "subagent";
}

/** Resolve the pi CLI shim (prefer pi.cmd) for launcher scripts. */
function resolvePiPath(): string {
	if (cachedPiPath) return cachedPiPath;
	try {
		const out = execFileSync("where.exe", ["pi"], { encoding: "utf8", windowsHide: true });
		const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		const cmd = lines.find((l) => l.toLowerCase().endsWith("pi.cmd"));
		cachedPiPath = cmd ?? lines[0] ?? "";
	} catch {
		cachedPiPath = "";
	}
	if (!cachedPiPath) {
		throw new Error("`pi` was not found on PATH — it must be resolvable from pwsh to spawn subagents.");
	}
	return cachedPiPath;
}

function getArtifactDir(ctx: ExtensionContext): string {
	return join(ctx.sessionManager.getSessionDir(), "artifacts", ctx.sessionManager.getSessionId());
}

function subagentSessionsRoot(): string {
	return join(getAgentDir(), "sessions", "subagents");
}

function newTextTaskFile(artifactDir: string, name: string, content: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const path = join(artifactDir, "context", `${safeFilePart(name)}-${timestamp}.md`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
	return path;
}

/** Identity is deterministic per agent name — respawn/resume overwrite, no file spam. */
function newIdentityFile(artifactDir: string, name: string, body: string): string {
	const path = join(artifactDir, "context", `${safeFilePart(name)}-identity.md`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body, "utf8");
	return path;
}

function taskWrapper(def: AgentDef | null, task: string): string {
	const autoExit = def?.autoExit !== false;
	const modeHint = autoExit
		? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
		: "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
	const summaryInstruction = autoExit
		? "Your FINAL assistant message should summarize what you accomplished."
		: "Your FINAL assistant message (before you exit the pane) should summarize what you accomplished.";
	return `${modeHint}\n\n${task}\n\n${summaryInstruction}`;
}

/** Drop closed panes from the column cache — ids left behind by auto-collapse
 *  or user closes must never become split targets (herdr pane_not_found). */
function pruneColumnPanes(): void {
	const alive = listPaneIds();
	// An empty live set is ambiguous: it can be a herdr/wezterm CLI hiccup
	// (an errored `pane list` returns an empty set) rather than "all panes
	// closed". Pruning on it would wipe the column cache for no reason; the
	// pollTick crash path removes genuinely dead panes one by one anyway.
	if (alive.size === 0 && columnPanes.length > 0) return;
	columnPanes = columnPanes.filter((id) => alive.has(id));
}

// ── Widget ──

function updateWidget(): void {
	if (!latestCtx?.hasUI) return;
	if (runningSubagents.size === 0) {
		latestCtx.ui.setWidget("subagents", undefined);
		return;
	}
	const now = Date.now();
	const lines: string[] = [];
	for (const r of runningSubagents.values()) {
		const elapsed = fmtElapsed(Math.floor((now - r.startTime) / 1000));
		let phase = "starting";
		let detail = "";
		if (r.cancelRequested) {
			// Cancelling outranks activity display — it is the newest fact.
			phase = "cancelling";
		} else if (r.activity.state) {
			phase = r.activity.state.phase;
			const label = activityLabel(r.activity.state);
			if (label) detail = ` · ${label}`;
			if (phase === "stalled") detail = " · stalled";
		}
		lines.push(`${r.name}  ${phase}${detail}  ${elapsed}`);
	}
	latestCtx.ui.setWidget("subagents", (_tui, theme) => {
		const box = new Box(1, 0, (text) => text);
		const header = theme.fg("muted", `Subagents — ${runningSubagents.size} running`);
		box.addChild(new Text(`${header}\n${lines.map((l) => theme.fg("accent", "▸ ") + l).join("\n")}`, 0, 0));
		return box;
	});
}

// ── Completion / steering ──

function completeSubagent(running: RunningSubagent, result: { exitCode: number; errorMessage?: string; crashed?: boolean; cancelled?: boolean }): void {
	runningSubagents.delete(running.id);
	publishRunningChildrenCount();

	if (tickTimer && runningSubagents.size === 0) {
		clearInterval(tickTimer);
		tickTimer = null;
	}

	// Cancel verdict: either we decided it, or a late cancel sidecar exists.
	// The sidecar is then removed so a resume of the same session file does
	// not instantly trip the new child's cancel poller.
	const cancelFile = cancelSidecarPath(running.sessionFile);
	const cancelled = result.cancelled === true || existsSync(cancelFile);
	if (cancelled) {
		try {
			rmSync(cancelFile, { force: true });
		} catch {
			// Best effort.
		}
	}

	const fallback = result.errorMessage
		? `Subagent error: ${result.errorMessage}`
		: result.crashed
			? "Subagent pane was closed before it finished."
			: result.exitCode !== 0
				? `Sub-agent exited with code ${result.exitCode}`
				: "Sub-agent exited without output";
	const { summary, usage, model } = summarizeSessionFile(running.sessionFile, fallback);
	const elapsedSec = Math.floor((Date.now() - running.startTime) / 1000);

	// session-trace integration: child card in /trace (TUI) and web viewer.
	try {
		latestPi?.appendEntry("session-trace:subagents", {
			agent: running.agentName || running.name,
			task: running.task,
			session: running.sessionFile,
			usage: usage ?? undefined,
			model: model ?? undefined,
		});
	} catch {
		// Optional integration.
	}

	const usageText = usage && (usage.input > 0 || usage.output > 0) ? formatUsage(usage) : undefined;
	const elapsedText = fmtElapsed(elapsedSec);
	const statusLine = cancelled
		? `cancelled by user after ${elapsedText}`
		: result.errorMessage
			? `failed after ${elapsedText}`
			: `finished in ${elapsedText}`;

	const content = [
		...(cancelled
			? [
					`⚠ Sub-agent "${running.name}" was CANCELLED before finishing — treat everything below as partial work, do not assume the task completed.`,
				]
			: []),
		`Sub-agent "${running.name}" (${running.agentName || "adhoc"}) ${statusLine}.`,
		usageText ? `Usage: ${usageText}.` : "",
		"",
		summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}\n… [truncated — full transcript: ${running.sessionFile}]` : summary,
		"",
		`Follow up with subagent_message({ name: "${running.name}", message: "…" }) — the same name works whether the pane is still open or has since been closed.`,
	]
		.filter((s) => s !== "")
		.join("\n");

	latestPi?.sendMessage(
		{
			customType: "subagent_result",
			content,
			display: true,
			details: {
				name: running.name,
				agent: running.agentName,
				task: running.task,
				session: running.sessionFile,
				exitCode: result.exitCode,
				elapsedSec,
				...(cancelled ? { cancelled: true } : {}),
				...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
				...(usage ? { usage } : {}),
				...(model ? { model } : {}),
			},
		} as Parameters<ExtensionAPI["sendMessage"]>[0],
		{ triggerTurn: true, deliverAs: "steer" },
	);

	// herdr: collapse the pane once the result is delivered — an exited
	// auto-exit subagent leaves a dead shell pane that only clutters the
	// workspace. The transcript lives in the session file (/trace links to
	// it) and resume recreates the pane on demand. Failed runs keep the pane
	// open for on-screen debugging; cancelled runs close like successes (a
	// cancelled pane has nothing left to inspect). WezTerm keeps the pane on
	// purpose: its pwsh prompt with the visible transcript is part of the
	// resume flow.
	if (activeBackend() === "herdr" && (cancelled || (running.autoExit && !result.errorMessage && result.exitCode === 0))) {
		closePane(running.paneId);
		columnPanes = columnPanes.filter((id) => id !== running.paneId);
	}

	updateWidget();
}

/** What the subagent was last seen doing — feeds the stall notices. */
function describeActivity(state: SubagentActivityState | null): string {
	if (state?.toolActive && state.toolName) return `tool ${state.toolName}`;
	return state?.phase ?? "unknown";
}

function notifyStalled(running: RunningSubagent, stalled: boolean): void {
	const now = Date.now();
	const elapsed = fmtElapsed(Math.floor((now - running.startTime) / 1000));
	const silentSec = Math.floor((now - running.activity.lastChangeAt) / 1000);
	const text = stalled
		? `Sub-agent "${running.name}" (${running.agentName}) looks stalled: no events for ${fmtElapsed(silentSec)} (total ${elapsed}); last seen: ${describeActivity(running.activity.state)}. ` +
			`Steer with subagent_message (it auto-interrupts stalled agents), or cancel with subagent_cancel({ name: "${running.name}" }), or ignore.`
		: `Sub-agent "${running.name}" is active again (${describeActivity(running.activity.state)}) after ${fmtElapsed(silentSec)} of silence.`;
	latestPi?.sendMessage(
		{
			customType: "subagent_status",
			content: text,
			display: true,
			details: {
				name: running.name,
				agent: running.agentName,
				stalled,
				silentMs: now - running.activity.lastChangeAt,
				phase: running.activity.state?.phase,
				toolName: running.activity.state?.toolName,
			},
		} as Parameters<ExtensionAPI["sendMessage"]>[0],
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function observeActivity(running: RunningSubagent, now: number): void {
	const read = readActivityState(running.activityFile, running.id);
	if (read.ok) {
		const obs = running.activity;
		const changed = !obs.state || read.state.sequence !== obs.state.sequence;
		if (changed) obs.lastChangeAt = now;
		// Refresh state before the notice so "active again" names the NEW
		// activity, not the one that preceded the silence.
		obs.state = read.state;
		if (changed && obs.stalled) {
			obs.stalled = false;
			if (running.autoExit) notifyStalled(running, false);
		}
	}
	const stalledCandidate =
		running.autoExit &&
		running.activity.state !== null &&
		now - running.activity.lastChangeAt > STALLED_AFTER_MS;
	if (stalledCandidate && !running.activity.stalled) {
		running.activity.stalled = true;
		notifyStalled(running, true);
	}
}

function pollTick(): void {
	if (runningSubagents.size === 0) return;
	const now = Date.now();
	const alive = listPaneIds();

	for (const running of Array.from(runningSubagents.values())) {
		// 1. Fast path: launcher-written sidecar with the exit code.
		if (existsSync(running.doneFile)) {
			let exitCode = 0;
			try {
				exitCode = Number.parseInt(readDoneFile(running.doneFile), 10);
				if (!Number.isFinite(exitCode)) exitCode = 0;
			} catch {
				exitCode = 0;
			}
			completeSubagent(running, { exitCode });
			continue;
		}

		// 2. Error/cancel sidecar written by the child extension.
		if (existsSync(running.exitSidecarFile)) {
			const verdict = classifyExitSidecar(readDoneFile(running.exitSidecarFile));
			if (verdict.kind === "cancelled") {
				// The child honored the cancel flag and exited — not an error.
				completeSubagent(running, { exitCode: 1, cancelled: true });
				continue;
			}
			const errorMessage =
				verdict.kind === "error" && verdict.errorMessage
					? verdict.errorMessage
					: "Subagent exited with stopReason=error.";
			completeSubagent(running, { exitCode: 1, errorMessage });
			continue;
		}

		// 3. Pane vanished without finishing → crashed or closed by the user.
		if (!alive.has(running.paneId)) {
			columnPanes = columnPanes.filter((id) => id !== running.paneId);
			completeSubagent(running, { exitCode: 1, crashed: true, errorMessage: "pane closed" });
			continue;
		}

		// 4. Screen sentinel fallback (sidecars failed to write).
		const sentinel = parseSentinel(readScreenTail(running.paneId, 4));
		if (sentinel !== null) {
			completeSubagent(running, { exitCode: sentinel });
			continue;
		}

		// 5. Cancel grace period: the child honors the flag within ~1s; a
		// pane still alive this long later is wedged — force-close it.
		if (running.cancelRequested && now - (running.cancelStartedAt ?? now) > CANCEL_KILL_AFTER_MS) {
			closePane(running.paneId);
			columnPanes = columnPanes.filter((id) => id !== running.paneId);
			completeSubagent(running, {
				exitCode: 1,
				cancelled: true,
				errorMessage: "cancelled — pane force-closed after grace period",
			});
			continue;
		}

		observeActivity(running, now);
	}

	updateWidget();
}

function readDoneFile(path: string): string {
	// Small sync reads once per second per subagent — fine with node:fs.
	return readFileSync(path, "utf8").trim();
}

function ensureTicker(): void {
	if (tickTimer) return;
	pollAbort = new AbortController();
	tickTimer = setInterval(() => {
		try {
			pollTick();
		} catch {
			// A broken tick must never take the session down.
		}
	}, POLL_INTERVAL_MS);
}

// ── Spawning ──

interface SpawnContext {
	defs: Map<string, AgentDef>;
	artifactDir: string;
	registryFile: string;
}

function spawnContext(ctx: ExtensionContext, knownTools?: Set<string>): SpawnContext {
	const defs = discoverAgents(ctx.cwd, getAgentDir());
	// Tool-name validation at spawn time: a typo in `tools:` (e.g. safe_bash)
	// is silently ignored by pi's --tools filter — surface it instead.
	if (knownTools) {
		for (const def of defs.values()) {
			for (const tool of def.tools ?? []) {
				if (!knownTools.has(tool)) def.warnings.push(`unknown tool "${tool}"`);
			}
		}
	}
	return {
		defs,
		artifactDir: getArtifactDir(ctx),
		registryFile: registryPath(getArtifactDir(ctx)),
	};
}

function buildLauncherSpec(opts: {
	name: string;
	id: string;
	def: AgentDef | null;
	piPath: string;
	sessionFile: string;
	taskFile: string;
	doneFile: string;
	activityFile: string;
	/** Agent identity body → written to a file → --append-system-prompt in the child. */
	identityFile?: string;
	cwd?: string;
	model?: string;
	grantSpawning: boolean;
	/** Extra extension entrypoints to load in the child (e.g. web-search for web tools). */
	extraExtensions?: string[];
}): LauncherSpec {
	const def = opts.def;
	const tools = def?.tools;
	const env: Record<string, string> = {
		PI_SUBAGENT_NAME: opts.name,
		PI_SUBAGENT_ID: opts.id,
		PI_SUBAGENT_SESSION: opts.sessionFile,
		PI_SUBAGENT_ACTIVITY_FILE: opts.activityFile,
	};
	if (def) {
		env["PI_SUBAGENT_AGENT"] = def.name;
		if (def.autoExit) env["PI_SUBAGENT_AUTO_EXIT"] = "1";
		if (def.subagents && def.subagents.length > 0) env["PI_SUBAGENT_ALLOWED"] = def.subagents.join(",");
	}

	return {
		name: opts.name,
		id: opts.id,
		piPath: opts.piPath,
		sessionFile: opts.sessionFile,
		extensionPaths: [
			DONE_EXTENSION_PATH,
			...(opts.extraExtensions ?? []),
			...(opts.grantSpawning ? [join(MODULE_DIR, "index.ts")] : []),
		],
		noExtensions: !!(tools && tools.length > 0),
		cwd: opts.cwd,
		model: opts.model,
		thinking: def?.thinking,
		tools,
		appendSystemPromptFile: opts.identityFile,
		taskFile: opts.taskFile,
		doneFile: opts.doneFile,
		env,
	};
}

function doSpawn(ctx: ExtensionContext, params: SpawnParams, sctx: SpawnContext): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
	const allowed = allowedAgentsInChild();
	if (allowed && !allowed.has(params.agent)) {
		throw new Error(
			`Agent "${params.agent}" is not in this session's spawn allowlist (${Array.from(allowed).join(", ")}).`,
		);
	}
	const def = sctx.defs.get(params.agent);
	if (!def) {
		const names = Array.from(sctx.defs.keys());
		throw new Error(
			names.length > 0
				? `Unknown agent "${params.agent}". Available: ${names.join(", ")}.`
				: `Unknown agent "${params.agent}". No agent definitions found in .pi/agents/ or ~/.pi/agent/agents/.`,
		);
	}

	const reserved = new Set<string>([...runningSubagents.keys(), ...Object.keys(readNameRegistry(sctx.registryFile))]);
	const name = uniqueName(params.name?.trim() || def.name, reserved);
	const id = `${safeFilePart(name)}-${randomUUID().slice(0, 8)}`;

	const startTime = Date.now();
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
	mkdirSync(subagentSessionsRoot(), { recursive: true });
	const sessionFile = join(subagentSessionsRoot(), `${timestamp}_${id}.jsonl`);
	const doneFile = `${sessionFile}.done`;
	const activityFile = join(sctx.artifactDir, "activity", `${id}.json`);
	const cwd = params.cwd?.trim() || ctx.cwd;
	const model = params.model?.trim() || def.model;
	const grantSpawning = !!(def.subagents && def.subagents.length > 0);

	const taskFile = newTextTaskFile(sctx.artifactDir, name, taskWrapper(def, params.task));
	const identityFile = def?.body ? newIdentityFile(sctx.artifactDir, name, def.body) : undefined;
	const scriptPath = join(sctx.artifactDir, "subagent-scripts", `${safeFilePart(name)}-${id}.ps1`);
	mkdirSync(dirname(scriptPath), { recursive: true });
	const spec = buildLauncherSpec({
		name,
		id,
		def,
		piPath: resolvePiPath(),
		sessionFile,
		taskFile,
		doneFile,
		activityFile,
		identityFile,
		cwd,
		model,
		grantSpawning,
		extraExtensions: extensionPathsForTools(def.tools),
	});
	writeFileSync(scriptPath, renderLauncherPs1(spec), "utf8");

	// Split targets must be live panes: a cached column holding ids of
	// auto-collapsed panes would make herdr fail with pane_not_found.
	pruneColumnPanes();
	const paneId = createSubagentPane({
		ps1Path: scriptPath,
		cwd,
		runningCount: columnPanes.length,
		topPane: columnPanes[0],
	});
	if (!columnPanes.includes(paneId)) columnPanes.push(paneId);

	const running: RunningSubagent = {
		id,
		name,
		agentName: def.name,
		task: params.task,
		paneId,
		startTime,
		sessionFile,
		activityFile,
		doneFile,
		exitSidecarFile: `${sessionFile}.exit`,
		autoExit: def.autoExit,
		agentDef: def,
		activity: { state: null, lastChangeAt: startTime, stalled: false },
		cancelRequested: false,
	};
	runningSubagents.set(id, running);
	publishRunningChildrenCount();

	const registryEntry: RegistryEntry & { paneId?: string } = {
		name,
		agent: def.name,
		task: params.task,
		session: sessionFile,
		cwd,
		model,
		thinking: def.thinking,
		tools: def.tools,
		noExtensions: spec.noExtensions,
		autoExit: def.autoExit,
		registeredAt: startTime,
		paneId,
	};
	upsertName(sctx.registryFile, registryEntry);

	ensureTicker();
	updateWidget();

	return {
		content: [
			{
				type: "text",
				text:
					`Sub-agent "${name}" (${def.name}) spawned in pane ${paneId}. It runs fully autonomously — ` +
					`do NOT wait for it and do NOT poll for its status. When it finishes, the harness AUTOMATICALLY delivers ` +
					`its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. ` +
					`Meanwhile: keep working on other independent tasks, or end your turn immediately. ` +
					`To send additional instructions later: subagent_message({ name: "${name}", message: "…" }).` +
				(def.warnings.length > 0 ? `\n⚠ Definition warnings for "${def.name}": ${def.warnings.join("; ")}.` : ""),
			},
		],
		details: { id, name, agent: def.name, pane: paneId, session: sessionFile },
	};
}

function doResume(ctx: ExtensionContext, sctx: SpawnContext, entry: RegistryEntry & { paneId?: string }, message: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
	const name = entry.name;
	const id = `${safeFilePart(name)}-${randomUUID().slice(0, 8)}`;
	const startTime = Date.now();
	const def = sctx.defs.get(entry.agent) ?? null;

	const taskFile = newTextTaskFile(sctx.artifactDir, name, taskWrapper(def, message));
	const identityFile = def?.body ? newIdentityFile(sctx.artifactDir, name, def.body) : undefined;
	const scriptPath = join(sctx.artifactDir, "subagent-scripts", `${safeFilePart(name)}-${id}.ps1`);
	mkdirSync(dirname(scriptPath), { recursive: true });
	const activityFile = join(sctx.artifactDir, "activity", `${id}.json`);
	const spec = buildLauncherSpec({
		name,
		id,
		def,
		piPath: resolvePiPath(),
		sessionFile: entry.session,
		taskFile,
		doneFile: `${entry.session}.done`,
		activityFile,
		identityFile,
		cwd: entry.cwd ?? ctx.cwd,
		model: entry.model,
		grantSpawning: !!(def?.subagents && def.subagents.length > 0),
	});
	// Resume replays the ORIGINAL launch configuration, not current agent defs.
	spec.noExtensions = entry.noExtensions ?? spec.noExtensions;
	spec.tools = entry.tools ?? spec.tools;
	spec.thinking = entry.thinking ?? spec.thinking;
	writeFileSync(scriptPath, renderLauncherPs1(spec), "utf8");

	// Stale sidecars from the PREVIOUS run of this session file would make
	// the first pollTick (1s) fake a completion: old `.done` re-delivers the
	// old result, old `.exit`/`.cancel` instantly "error"/"cancel" the fresh
	// run. A resume means a new run — clear all three before relaunching.
	for (const stale of [`${entry.session}.done`, `${entry.session}.exit`, cancelSidecarPath(entry.session)]) {
		try {
			rmSync(stale, { force: true });
		} catch {
			// Best effort.
		}
	}

	const paneAlive = entry.paneId ? paneExists(entry.paneId) : false;
	let paneId: string;
	if (paneAlive && entry.paneId) {
		// The pane is sitting at a pwsh prompt — run the resume launcher there.
		runScriptInPane(entry.paneId, scriptPath);
		paneId = entry.paneId;
	} else {
		// Split targets must be live panes (see doSpawn).
		pruneColumnPanes();
		paneId = createSubagentPane({
			ps1Path: scriptPath,
			cwd: entry.cwd ?? ctx.cwd,
			runningCount: columnPanes.length,
			topPane: columnPanes[0],
		});
		if (!columnPanes.includes(paneId)) columnPanes.push(paneId);
	}

	const running: RunningSubagent = {
		id,
		name,
		agentName: entry.agent,
		task: message,
		paneId,
		startTime,
		sessionFile: entry.session,
		activityFile,
		doneFile: `${entry.session}.done`,
		exitSidecarFile: `${entry.session}.exit`,
		autoExit: entry.autoExit,
		agentDef: def,
		activity: { state: null, lastChangeAt: startTime, stalled: false },
		cancelRequested: false,
	};
	runningSubagents.set(id, running);
	publishRunningChildrenCount();

	const registryEntry: RegistryEntry & { paneId?: string } = { ...entry, paneId, registeredAt: startTime };
	upsertName(sctx.registryFile, registryEntry);

	ensureTicker();
	updateWidget();

	return {
		content: [
			{
				type: "text",
				text:
					`Sub-agent "${name}" resumed from its saved session${paneAlive ? " in its existing pane" : ` in a new pane (${paneId})`}. ` +
					`Fire-and-forget: its result arrives as a steer message when it finishes — do not wait for it and do not poll.`,
			},
		],
		details: { id, name, agent: entry.agent, pane: paneId, session: entry.session, resumed: true },
	};
}

// ── Extension entry point ──

/**
 * Framed card for expanded batch results (idea No.5b): corners ╭╮╰╯ adapt to
 * the viewport width, the header rides the top border, the footer (usage)
 * sits right-aligned on the bottom border. Children render inside at
 * width−4; frame lines are cached per width and dropped on invalidate.
 */
class BatchCard extends Container {
	private readonly borderColor: (s: string) => string;
	private readonly header: string;
	private readonly footer: string | undefined;
	private frameWidth?: number;
	private frameLines?: string[];

	constructor(borderColor: (s: string) => string, header: string, footer?: string) {
		super();
		this.borderColor = borderColor;
		this.header = header;
		this.footer = footer;
	}

	override render(width: number): string[] {
		if (this.frameWidth === width && this.frameLines) return this.frameLines;
		const inner = Math.max(width - 4, 8); // "│ " on the left, " │" on the right
		const lines = [this.topLine(width)];
		for (const line of super.render(inner)) {
			const pad = Math.max(inner - visibleWidth(line), 0);
			lines.push(`${this.borderColor("│")} ${truncateToWidth(line, inner)}${" ".repeat(pad)}${this.borderColor(" │")}`);
		}
		lines.push(this.bottomLine(width));
		this.frameWidth = width;
		this.frameLines = lines;
		return lines;
	}

	override invalidate(): void {
		this.frameWidth = undefined;
		this.frameLines = undefined;
		super.invalidate();
	}

	private topLine(width: number): string {
		// ╭─ {header} ────╮
		const header = truncateToWidth(this.header, Math.max(width - 6, 1), "…");
		const fill = Math.max(width - 5 - visibleWidth(header), 1);
		return `${this.borderColor("╭─ ")}${header}${this.borderColor(` ${"─".repeat(fill)}╮`)}`;
	}

	private bottomLine(width: number): string {
		// ╰────────╯  /  ╰───── {footer} ─╯ (footer right-aligned)
		if (!this.footer) return this.borderColor(`╰${"─".repeat(Math.max(width - 2, 2))}╯`);
		const footer = truncateToWidth(this.footer, Math.max(width - 6, 1), "…");
		const fill = Math.max(width - 4 - visibleWidth(footer), 1);
		return `${this.borderColor(`╰${"─".repeat(fill)} `)}${footer}${this.borderColor(" ╯")}`;
	}
}

export default function subagentsExtension(pi: ExtensionAPI) {
	// Tool universe for spawn-time validation: everything configured right now
	// (built-ins + extension tools). Best effort — never blocks a spawn.
	const knownToolNames = new Set<string>(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
	try {
		for (const t of pi.getAllTools?.() ?? []) {
			const n = typeof t === "string" ? t : (t as { name?: string }).name;
			if (n) knownToolNames.add(n);
		}
	} catch {
		// API unavailable — built-ins only.
	}

	latestPi = pi;

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		runningSubagents = new Map();
		columnPanes = [];
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
		pollAbort = new AbortController();
		updateWidget();
	});

	pi.on("session_shutdown", () => {
		pollAbort?.abort();
		pollAbort = null;
		if (tickTimer) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
		// Running panes keep living on purpose: autonomous children finish and
		// leave their transcripts behind; their results are simply not delivered
		// to a dead parent. Nothing to clean up in the terminal itself.
		if (latestCtx?.hasUI) latestCtx.ui.setWidget("subagents", undefined);
		runningSubagents = new Map();
		columnPanes = [];
		latestCtx = null;
	});

	// ── Tool: subagent ──

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Spawn a sub-agent in a dedicated terminal pane — WezTerm, or herdr when pi runs inside herdr (async, fire-and-forget). " +
			"The call returns immediately with only an acknowledgement. When the sub-agent finishes, " +
			"the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — " +
			"you do not need to do anything to receive it. DO NOT write polling loops, sleep/wait commands, or repeatedly read session files to detect completion. " +
			"After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). " +
			"The harness will wake you with the result when it is ready.",
		parameters: Type.Object({
			agent: Type.String({ description: "Which agent to spawn (must be known and permitted)" }),
			task: Type.String({ description: "Task/prompt for the sub-agent" }),
			name: Type.Optional(
				Type.String({ description: "Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (scout, scout-2, …)" }),
			),
			model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the sub-agent. Use for role-specific subfolders." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sctx = spawnContext(ctx, knownToolNames);
			return doSpawn(ctx, params as SpawnParams, sctx);
		},
	});

	// ── Tool: subagent_message ──

	pi.registerTool({
		name: "subagent_message",
		label: "Subagent Message",
		description:
			"Message a subagent by name: steers it if running, resumes it if finished (same name either way). " +
			"`name` and `message` are both required. Steering returns immediately; resuming delivers its result later as a steer message. " +
			"A steered running subagent picks the message up at its next turn boundary — set `interrupt: true` to escape its current turn and deliver immediately " +
			"(stalled subagents are interrupted automatically). To STOP a running subagent entirely, use subagent_cancel instead. " +
			"Do not poll, sleep, or read session files to detect completion — the harness handles delivery.",
		parameters: Type.Object({
			name: Type.String({
				description:
					"Exact display name of the subagent. Steers it if it is still running; resumes its session if it has finished.",
			}),
			message: Type.String({
				description:
					"The message to deliver: a follow-up instruction for a running subagent, or the next task for a resumed session.",
			}),
			interrupt: Type.Optional(
				Type.Boolean({
					description:
						"Interrupt the subagent's current turn (Esc) before delivering the message, instead of queueing it for the next turn boundary. Defaults to auto: interrupted automatically when the subagent is flagged stalled.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sctx = spawnContext(ctx, knownToolNames);
			const name = params.name.trim();
			const message = params.message.trim();
			if (!message) throw new Error("`message` is required.");

			const running = Array.from(runningSubagents.values()).find((r) => r.name === name);
			if (running) {
				// Explicit choice wins; omitted → auto-interrupt stalled agents,
				// which would otherwise never reach the turn boundary.
				const doInterrupt = resolveInterrupt(params.interrupt, running.activity.stalled);
				if (doInterrupt) {
					// The pane may die during the settle sleep — a failed key send
					// must not surface the steer as a tool error; the next pollTick
					// completes the entry as crashed.
					try {
						sendInterrupt(running.paneId, "escape");
					} catch {
						// Pane already gone.
					}
					await sleep(INTERRUPT_SETTLE_MS);
				}
				try {
					sendText(running.paneId, message);
				} catch {
					// Pane died during the settle sleep — the next pollTick
					// completes the entry; a steer into a dead pane must not
					// surface as a tool error.
					throw new Error(
						`Could not deliver the message: pane of subagent "${name}" is already gone (it finished or crashed).`,
					);
				}
				running.activity.lastChangeAt = Date.now();
				running.activity.stalled = false;
				updateWidget();
				return {
					content: [
						{
							type: "text",
							text: doInterrupt
								? `Interrupted "${name}"'s current turn and delivered the message; it starts working on it now.`
								: `Message delivered to running subagent "${name}". It picks this up at its next turn boundary. If it exits, its result still arrives as a steer message.`,
						},
					],
					details: { name, status: "steered", ...(doInterrupt ? { interrupted: true } : {}) },
				};
			}

			const registry = readNameRegistry(sctx.registryFile) as Record<string, RegistryEntry & { paneId?: string }>;
			const entry = registry[name];
			if (!entry) {
				const known = [...new Set([...Object.keys(registry), ...runningSubagents.keys()])];
				throw new Error(
					known.length > 0
						? `No subagent named "${name}". Known names: ${known.join(", ")}.`
						: `No subagent named "${name}" is registered in this session.`,
				);
			}
			return doResume(ctx, sctx, entry, message);
		},
	});

	// ── Tool: subagent_cancel ──

	pi.registerTool({
		name: "subagent_cancel",
		label: "Subagent Cancel",
		description:
			"Cancel a running subagent by name: interrupts its current turn (Esc + Ctrl+C sent to the pane), writes a cancel flag the child honors within ~500ms, " +
			"and force-closes the pane if it has not exited after a grace period. Guaranteed: no new tool-calls run after cancel. " +
			"Finished subagents cannot be cancelled (use subagent_message to resume instead).",
		parameters: Type.Object({
			name: Type.String({ description: "Exact display name of the running subagent to cancel." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sctx = spawnContext(ctx, knownToolNames);
			const name = params.name.trim();
			const running = Array.from(runningSubagents.values()).find((r) => r.name === name);
			if (!running) {
				const registry = readNameRegistry(sctx.registryFile) as Record<string, RegistryEntry>;
				if (registry[name]) {
					return {
						content: [
							{
								type: "text",
								text: `Subagent "${name}" is not running — nothing to cancel (it already finished; use subagent_message to resume it).`,
							},
						],
					details: { name, status: "not-running" },
					};
				}
				const known = [...new Set([...Object.keys(registry), ...runningSubagents.keys()])];
				throw new Error(
					known.length > 0
						? `No subagent named "${name}". Known names: ${known.join(", ")}.`
						: `No subagent named "${name}" is registered in this session.`,
				);
			}

			// Race guard: the child may have finished between the last pollTick
			// (1s granularity) and this call — the done/error sidecars are the
			// source of truth. Arming cancel for a finished run would force-close
			// a pane whose result report is being delivered right now, and the
			// cancel sidecar would mislabel a real error as "cancelled by user".
			if (existsSync(running.doneFile) || existsSync(running.exitSidecarFile)) {
				return {
					content: [
						{
							type: "text",
							text: `Subagent "${name}" already finished — nothing to cancel (its result report is being delivered).`,
						},
					],
					details: { name, status: "already-finished" },
				};
			}

			running.cancelRequested = true;
			running.cancelStartedAt = Date.now();
			// The sidecar is the reliable path: the child polls it even while a
			// runaway turn ignores everything typed into the pane.
			try {
				writeFileSync(cancelSidecarPath(running.sessionFile), JSON.stringify({ requestedAt: Date.now() }), "utf8");
			} catch {
				// Best effort — Esc/Ctrl+C plus the grace-period kill still stop it.
			}
			// The pane can die between the two key sends (cancel sidecar honored
			// mid-grace-period) — a send into a dead pane must not surface the
			// cancel as a tool error; the next pollTick completes the entry.
			try {
				sendInterrupt(running.paneId, "escape");
			} catch {
				// Pane already gone.
			}
			await sleep(400);
			try {
				sendInterrupt(running.paneId, "ctrl-c");
			} catch {
				// Same race, one sleep later.
			}
			updateWidget();
			return {
				content: [
					{
						type: "text",
						text:
							`Cancel requested for "${name}": interrupt keys sent and cancel flag written. ` +
							`The child aborts its current work within ~500ms-1s and exits; if it is still alive after 10s the pane is force-closed. ` +
							`Its completion report still arrives as a steer message (marked as cancelled, partial work).`,
					},
				],
				details: { name, status: "cancelling" },
			};
		},
	});

	// ── Tool: subagents_list ──

	pi.registerTool({
		name: "subagents_list",
		label: "Subagents List",
		description:
			"List all available subagent definitions. Project-local agents in .pi/agents override global ones in ~/.pi/agent/agents with the same name.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const allowed = allowedAgentsInChild();
			const defs = Array.from(discoverAgents(ctx.cwd, getAgentDir()).values())
				.filter((def) => !allowed || allowed.has(def.name))
				.sort((a, b) => a.name.localeCompare(b.name));

			const lines = defs.map((def) => {
				const scope = def.scope === "project" ? "project" : "global";
				const model = def.model ? ` · ${def.model}` : "";
				const tools = def.tools ? ` · tools: ${def.tools.join(",")}` : " · tools: default";
				const mode = def.autoExit ? "auto-exit" : "interactive";
				const spawnable = def.subagents?.length ? ` · may spawn: ${def.subagents.join(",")}` : "";
				return `- ${def.name} (${scope}, ${mode}${model}${tools}${spawnable}): ${def.description}`;
			});

			return {
				content: [
					{
						type: "text",
						text:
							lines.length > 0
								? `Available subagent definitions:\n${lines.join("\n")}`
								: "No subagent definitions found. Add .md files to .pi/agents/ (project) or ~/.pi/agent/agents/ (global).",
					},
				],
				details: { count: defs.length, names: defs.map((d) => d.name) },
			};
		},
	});

	// ── Tool: task_batch ──

	const PANE_TOOLS_DENYLIST = ["subagent", "subagent_message", "subagent_cancel", "subagents_list"];

	/** Re-render cadence for the live batch UI (spinner frames, running elapsed). */
	const BATCH_TICK_MS = 150;

	/** One-line parallel progress for the model-facing content updates. */
	function parallelStatusLine(results: BatchResult[]): string {
		const queued = results.filter((r) => isQueued(r)).length;
		const running = results.filter((r) => isRunning(r)).length;
		const finished = results.length - queued - running;
		const ok = finished - results.filter((r) => !isRunning(r) && !isQueued(r) && isFailedResult(r)).length;
		const parts = [`${ok}/${results.length} done`];
		if (running > 0) parts.push(`${running} running`);
		if (queued > 0) parts.push(`${queued} queued`);
		return `Parallel: ${parts.join(" · ")}`;
	}

	interface BatchDetails {
		mode: "single" | "parallel" | "chain";
		results: BatchResult[];
		/**
		 * Chain only: size (utf8 bytes) of the {previous} output handed into
		 * step i; aligns with results by index, 0 for the first step.
		 */
		handOff?: number[];
	}

	const makeBatchDetails = (mode: BatchDetails["mode"], results: BatchResult[], handOff?: number[]): BatchDetails => ({
		mode,
		results,
		handOff,
	});

	pi.registerTool({
		name: "task_batch",
		label: "Task Batch",
			description:
			"Run headless subagent tasks in isolated pi processes (blocking, batch mode). " +
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder). " +
			"Uses JSON mode to capture structured output from subagents. " +
			"For interactive pane-based subagents (watchable, steerable, resumable) use the `subagent` tool instead.",
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
			task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String({ description: "Name of the agent to invoke" }),
						task: Type.String({ description: "Task to delegate to the agent" }),
						cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
					}),
					{ description: "Array of {agent, task} for parallel execution" },
				),
			),
			chain: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String({ description: "Name of the agent to invoke" }),
						task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
						cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
					}),
					{ description: "Array of {agent, task} for sequential execution" },
				),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const defs = discoverAgents(ctx.cwd, getAgentDir());
			const dispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinking: ctx.thinkingLevel,
			};
			const sessionsRoot = subagentSessionsRoot();
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const batchModeLabel: string = hasChain ? "chain" : hasTasks ? "parallel" : "single";

			const runSingle = async (
				agentName: string,
				task: string,
				cwd: string | undefined,
				step: number | undefined,
				onChildEvent: ((r: BatchResult) => void) | undefined,
			): Promise<BatchResult> => {
				const def = defs.get(agentName);
				if (!def) {
					const available = Array.from(defs.keys()).map((n) => `"${n}"`).join(", ") || "none";
					const r = emptyResult(agentName, task);
					r.exitCode = 1;
					r.stderr = `Unknown agent: "${agentName}". Available agents: ${available}.`;
					return r;
				}
				const result = await runHeadlessChild({
					agentName: def.name,
					agentLabel: def.name,
					task,
					cwd: cwd ?? ctx.cwd,
					model: def.model ?? dispatchDefaults.model,
					thinking: def.model ? undefined : dispatchDefaults.thinking,
					tools: def.tools,
					appendSystemPrompt: def.body || undefined,
					denyTools: PANE_TOOLS_DENYLIST,
					defaultCwd: ctx.cwd,
					sessionsRoot,
					batchMode: batchModeLabel,
					spawnerSession: ctx.sessionManager?.getSessionId?.(),
					signal,
					onEvent: onChildEvent,
					step,
				});
				if (def.warnings.length > 0) {
					result.stderr += `⚠ Agent definition warnings for "${def.name}": ${def.warnings.join("; ")}.\n`;
				}
				// /trace child card — same convention as pane-based subagents.
				try {
					pi.appendEntry("session-trace:subagents", {
						agent: def.name,
						task,
						session: result.sessionFile,
						usage: result.usage.input || result.usage.output
							? { input: result.usage.input, output: result.usage.output, cost: result.usage.cost }
							: undefined,
						model: result.model,
					});
				} catch {
					// Optional integration.
				}
				return result;
			};

			const modeCount = Number(hasChain) + Number(hasTasks) + Number(Boolean(params.agent && params.task));
			const inferredMode: BatchDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";

			if (modeCount !== 1) {
				const available = Array.from(defs.keys()).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode (agent+task, tasks, or chain).\nAvailable agents: ${available}` }],
					details: makeBatchDetails("single", []),
				};
			}

			// Live tick: advance spinner frames and running-elapsed timers even
			// when no child event fires (long tool calls inside a child, tasks
			// queued on the concurrency limit). Each mode points emitTick at its
			// own re-emit; the timer stops as soon as execute settles.
			let emitTick: (() => void) | null = null;
			const tickInterval = onUpdate ? setInterval(() => emitTick?.(), BATCH_TICK_MS) : null;
			try {
				// ── Chain ──
				if (hasChain && params.chain) {
					const results: BatchResult[] = [];
					const handOff: number[] = [];
					let previousOutput = "";

					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						// Size of what this step receives via {previous} — shown as ← +Nk.
						handOff.push(i === 0 ? 0 : Buffer.byteLength(previousOutput, "utf8"));
						const taskWithContext = substitutePrevious(step.task, previousOutput);
						let currentStep: BatchResult | null = null;
						const chainUpdate = onUpdate
							? (partial: { content?: unknown; details?: unknown }) => {
									const current = (partial.details as BatchDetails | undefined)?.results[0];
									if (current) {
										onUpdate({
											content: [{ type: "text", text: finalOutput(current.messages) || "(running...)" }],
											details: makeBatchDetails("chain", [...results, current], handOff),
										});
									}
								}
						: undefined;

						// Ticks re-emit the current step so its spinner and elapsed keep moving.
						emitTick = onUpdate
							? () => {
									const cur = currentStep;
									if (cur) chainUpdate?.({ details: makeBatchDetails("chain", [cur]) });
								}
							: null;

						const result = await runSingle(step.agent, taskWithContext, step.cwd, i + 1, (r) => {
							currentStep = r;
							chainUpdate?.({ details: makeBatchDetails("chain", [r]) });
						});
						emitTick = null;
						results.push(result);

						if (isFailedResult(result)) {
							return {
								content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${resultOutput(result)}` }],
								details: makeBatchDetails("chain", results, handOff),
								isError: true,
							};
						}
						previousOutput = finalOutput(result.messages);
					}
					return {
						content: [{ type: "text", text: finalOutput(results[results.length - 1]?.messages ?? []) || "(no output)" }],
						details: makeBatchDetails("chain", results, handOff),
					};
				}

				// ── Parallel ──
				if (hasTasks && params.tasks) {
					if (params.tasks.length > MAX_PARALLEL_TASKS) {
						return {
							content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
							details: makeBatchDetails("parallel", []),
						};
					}

					// All placeholders start queued; the runner clears the flag when a
					// concurrency slot opens and the child actually spawns.
					const allResults: BatchResult[] = params.tasks.map((t) => ({
						...emptyResult(t.agent, t.task),
						exitCode: -1,
						queued: true,
					}));

					const emitParallelUpdate = () => {
						if (!onUpdate) return;
						const busy = allResults.some((r) => isRunning(r) || isQueued(r));
						onUpdate({
							content: [{ type: "text", text: parallelStatusLine(allResults) + (busy ? "..." : "") }],
							details: makeBatchDetails("parallel", [...allResults]),
						});
					};
					emitTick = () => emitParallelUpdate();

					const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
						allResults[index] = { ...allResults[index], queued: false }; // slot open — spawning now
						emitParallelUpdate();
						const result = await runSingle(t.agent, t.task, t.cwd, undefined, (r) => {
							allResults[index] = r;
							emitParallelUpdate();
						});
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					});

					const successCount = results.filter((r) => !isFailedResult(r)).length;
					const summaries = results.map((r) => {
						const status = isFailedResult(r)
							? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
							: "completed";
						return `### [${r.agent}] ${status}\n\n${truncateOutput(resultOutput(r))}`;
					});
					return {
						content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
						details: makeBatchDetails("parallel", results),
					};
				}

				// ── Single ──
				let latestSingle: BatchResult | null = null;
				const emitSingle = () => {
					if (!onUpdate || !latestSingle) return;
					onUpdate({
						content: [{ type: "text", text: finalOutput(latestSingle.messages) || "(running...)" }],
						details: makeBatchDetails("single", [latestSingle]),
					});
				};
				emitTick = emitSingle;
				const result = await runSingle(params.agent ?? "", params.task ?? "", params.cwd, undefined, (r) => {
					latestSingle = r;
					emitSingle();
				});
				if (isFailedResult(result)) {
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${resultOutput(result)}` }],
						details: makeBatchDetails("single", [result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: finalOutput(result.messages) || "(no output)" }],
					details: makeBatchDetails("single", [result]),
				};
			} finally {
				if (tickInterval) clearInterval(tickInterval);
			}
		},

		renderCall(args, theme, _context) {
			const chain = args.chain as Array<{ agent: string; task: string }> | undefined;
			const tasks = args.tasks as Array<{ agent: string; task: string }> | undefined;
			if (chain && chain.length > 0) {
				// Pipeline on one line: research ─▶ analyze ─▶ report (+2)
				const shown = chain.slice(0, 4).map((s) => theme.fg("accent", s.agent));
				const rest = chain.length - shown.length;
				const pipeline =
					shown.join(theme.fg("muted", " ─▶ ")) + (rest > 0 ? theme.fg("muted", ` (+${rest})`) : "");
				return new Text(theme.fg("toolTitle", theme.bold("task_batch ")) + theme.fg("muted", "chain: ") + pipeline, 0, 0);
			}
			if (tasks && tasks.length > 0) {
				// Agent chips: roles are what matters, task texts truncate meaninglessly.
				const names = tasks.map((t) => t.agent);
				const shown = names.slice(0, 6);
				const rest = names.length - shown.length;
				const list = shown.join(theme.fg("muted", " · ")) + (rest > 0 ? theme.fg("muted", ` +${rest}`) : "");
				return new Text(
					theme.fg("toolTitle", theme.bold("task_batch ")) + theme.fg("muted", `parallel (${tasks.length}): `) + list,
					0,
					0,
				);
			}
			const agentName = (args.agent as string) || "...";
			const task = (args.task as string) || "";
			// oneline flattens multiline tasks; TruncatedText cuts at the real
			// viewport width instead of a hard-coded 60 chars.
			const preview = task ? oneline(task, 400) : "...";
			const text =
				theme.fg("toolTitle", theme.bold("task_batch ")) +
				theme.fg("accent", agentName) +
				`\n  ${theme.fg("dim", preview)}`;
			return new TruncatedText(text, 0, 0);
		},

		renderResult(result, options, theme, _context) {
			const expanded = options.expanded;
			const details = result.details as BatchDetails | undefined;
			if (!details || details.results.length === 0) {
				const first = result.content[0] as { type?: string; text?: string } | undefined;
				return new Text(first?.type === "text" ? first.text ?? "(no output)" : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const statusIcon = (r: BatchResult): string => {
				if (isQueued(r)) return theme.fg("dim", "○");
				if (isRunning(r)) return theme.fg("warning", spinnerFrame());
				if (isFailedResult(r)) return theme.fg("error", "✗");
				return theme.fg("success", "✓");
			};
			const elapsedTag = (r: BatchResult): string => {
				const ms = elapsedOf(r);
				return ms === undefined ? "" : ` ${theme.fg("dim", formatDuration(ms))}`;
			};
			// Verdict chip: reads before any text does. bg resets only itself, so
			// the tail after the chip stays unhighlighted.
			const chip = (kind: "running" | "ok" | "fail", label: string): string => {
				const [bg, fg] =
					kind === "running"
						? (["toolPendingBg", "accent"] as const)
						: kind === "fail"
							? (["toolErrorBg", "error"] as const)
							: (["toolSuccessBg", "success"] as const);
				return theme.bg(bg, theme.fg(fg, ` ${label} `));
			};
			const errorLine = (msg: string): string =>
				theme.bg("toolErrorBg", theme.fg("error", ` Error: ${oneline(msg, 120)} `));
			const stderrExcerpt = (r: BatchResult): string =>
				isFailedResult(r) && r.stderr ? firstLines(r.stderr, 3) : "";
			// One line per task for the collapsed parallel view (No.7).
			const taskLine = (r: BatchResult): string => {
				const head = `${statusIcon(r)} ${theme.fg("accent", r.agent)}${elapsedTag(r)}`;
				if (isQueued(r)) return `${head} ${theme.fg("muted", "queued")}`;
				const bits: string[] = [];
				if (isFailedResult(r)) {
					const reason = oneline(r.errorMessage || r.stopReason || `exit ${r.exitCode}`);
					bits.push(theme.fg("error", `failed (${reason})`));
				} else {
					const tools = summarizeTools(displayItems(r.messages));
					if (tools) bits.push(theme.fg("muted", tools));
					if (!isRunning(r)) {
						const out = finalOutput(r.messages);
						if (out) bits.push(theme.fg("dim", `→ ${formatTokens(out.length)}`));
					}
				}
				return bits.length > 0 ? `${head} ${bits.join(" ")}` : head;
			};
			const collapsedItems = (items: ReturnType<typeof displayItems>, limit: number): string => {
				const toShow = items.slice(-limit);
				const skipped = items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text ?? "" : (item.text ?? "").split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name ?? "", item.args ?? {}, theme.fg)}\n`;
					}
				}
				return text.trimEnd();
			};
			const childCard = (container: Container, r: BatchResult, header: string): void => {
				const usageStr = formatUsageStats(r.usage, r.model);
				const card = new BatchCard((s) => theme.fg("borderMuted", s), header, usageStr || undefined);
				card.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				for (const item of displayItems(r.messages)) {
					if (item.type === "toolCall") {
						card.addChild(
							new Text(theme.fg("muted", "→ ") + formatToolCall(item.name ?? "", item.args ?? {}, theme.fg), 0, 0),
						);
					}
				}
				const output = finalOutput(r.messages);
				if (output) {
					card.addChild(new Spacer(1));
					card.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
				}
				container.addChild(new Spacer(1));
				container.addChild(card);
			};
			const aggregateUsage = (results: BatchResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};
			// Done-state header tail: cost · wall time, then failed agent names.
			const costWallTag = (results: BatchResult[]): string => {
				const usage = aggregateUsage(results);
				const bits: string[] = [];
				if (usage.cost > 0) bits.push(`$${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(2)}`);
				const wall = batchWallTime(results);
				if (wall !== undefined) bits.push(formatDuration(wall));
				return theme.fg("dim", bits.join(" · "));
			};
			const failedTag = (results: BatchResult[]): string => {
				const failed = results.filter((r) => !isRunning(r) && !isQueued(r) && isFailedResult(r));
				if (failed.length === 0) return "";
				const names = failed.map((r) => r.agent);
				const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
				return theme.fg("error", `${failed.length} failed: ${shown}`);
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const isBusy = isRunning(r);
				const icon = isBusy ? theme.fg("warning", spinnerFrame()) : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const items = displayItems(r.messages);
				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${elapsedTag(r)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage) container.addChild(new Text(errorLine(r.errorMessage), 0, 0));
					const stderr = stderrExcerpt(r);
					if (stderr) container.addChild(new Text(theme.fg("dim", stderr), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					const output = finalOutput(r.messages);
					if (items.length === 0 && !output) {
						container.addChild(new Text(theme.fg("muted", isBusy ? "(running...)" : "(no output)"), 0, 0));
					} else {
						for (const item of items) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(item.name ?? "", item.args ?? {}, theme.fg), 0, 0),
								);
							}
						}
						if (output) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${elapsedTag(r)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) {
					text += `\n${errorLine(r.errorMessage)}`;
					const stderr = stderrExcerpt(r);
					if (stderr) text += `\n${theme.fg("dim", stderr)}`;
				} else if (items.length === 0) text += `\n${theme.fg("muted", isBusy ? "(running...)" : "(no output)")}`;
				else text += `\n${collapsedItems(items, 10)}`;
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "chain") {
				const activeCount = details.results.filter((r) => isRunning(r) || isQueued(r)).length;
				const successCount = details.results.filter((r) => !isRunning(r) && !isQueued(r) && !isFailedResult(r)).length;
				const doneCount = details.results.length - activeCount;
				const total = details.results.length;
				const kind = activeCount > 0 ? "running" : doneCount > successCount ? "fail" : "ok";
				const head = chip(
					kind,
					activeCount > 0 ? `${spinnerFrame()} CHAIN ${doneCount}/${total}` : `CHAIN ${successCount}/${total}`,
				);
				const bar = theme.fg("muted", `[${progressBar(doneCount, total)}] `);
				const tailBits = activeCount > 0 ? [] : [costWallTag(details.results), failedTag(details.results)].filter((s) => s.length > 0);
				if (expanded) {
					const container = new Container();
					container.addChild(new Text(`${head} ${bar}${tailBits.map((s) => ` ${s}`).join("")}`, 0, 0));
					// Frames supersede the No.6 rail glyphs; ← +Nk still marks the flow.
					for (let i = 0; i < details.results.length; i++) {
						const r = details.results[i];
						const handIn = details.handOff?.[i] ?? 0;
						const hand =
							i > 0 && handIn > 0 ? theme.fg("muted", ` ← +${formatTokens(handIn)}`) : "";
						const stepHeader = `${statusIcon(r)} ${theme.fg("muted", `Step ${r.step ?? i + 1} ·`)} ${theme.fg(
							"accent",
							r.agent,
						)}${hand}${elapsedTag(r)}`;
						childCard(container, r, stepHeader);
					}
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}
				let text = `${head} ${bar}${tailBits.map((s) => ` ${s}`).join("")}`;
				for (const r of details.results) {
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${statusIcon(r)}${elapsedTag(r)}`;
					const items = displayItems(r.messages);
					text += items.length === 0 ? `\n${theme.fg("muted", "(no output)")}` : `\n${collapsedItems(items, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				return new Text(text, 0, 0);
			}

			// parallel
			const queuedCount = details.results.filter((r) => isQueued(r)).length;
			const runningCount = details.results.filter((r) => isRunning(r)).length;
			const doneCount = details.results.length - queuedCount - runningCount;
			const failCount = details.results.filter((r) => !isRunning(r) && !isQueued(r) && isFailedResult(r)).length;
			const successCount = doneCount - failCount;
			const total = details.results.length;
			const isRunningBatch = runningCount > 0 || queuedCount > 0;
			const head = chip(
				isRunningBatch ? "running" : failCount > 0 ? "fail" : "ok",
				isRunningBatch ? `${spinnerFrame()} PARALLEL ${doneCount}/${total}` : `PARALLEL ${successCount}/${total}`,
			);
			const bar = theme.fg("muted", `[${progressBar(doneCount, total)}] `);
			let tail: string;
			if (isRunningBatch) {
				const live = [runningCount > 0 ? `${runningCount} running` : "", queuedCount > 0 ? `${queuedCount} queued` : ""]
					.filter(Boolean)
					.join(" · ");
				tail = `${bar}${live ? ` ${theme.fg("muted", live)}` : ""}`;
			} else {
				const bits = [costWallTag(details.results), failedTag(details.results)].filter((s) => s.length > 0);
				tail = bar + bits.map((s) => ` ${s}`).join("");
			}
			if (expanded && !isRunningBatch) {
				const container = new Container();
				container.addChild(new Text(`${head} ${tail}`, 0, 0));
				for (const r of details.results) {
					container.addChild(new Spacer(1));
					childCard(
						container,
						r,
						`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${statusIcon(r)}${elapsedTag(r)}`,
					);
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
				}
				return container;
			}
			// Collapsed: one line per task — status, duration, tools, output size.
			let text = `${head} ${tail}`;
			for (const r of details.results) {
				text += `\n${taskLine(r)}`;
			}
			if (!isRunningBatch) {
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n${theme.fg("dim", `Total: ${usageStr}`)}`;
			}
			if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});

	// ── Command: /subagent ──

	pi.registerCommand("subagent", {
		description: "Spawn a subagent (agent + task)",
		getArgumentCompletions: (prefix: string) => {
			const cwd = latestCtx?.cwd;
			if (!cwd) return null;
			const defs = Array.from(discoverAgents(cwd, getAgentDir()).keys())
				.filter((n) => n.startsWith(prefix))
				.map((n) => ({ value: n, label: n }));
			return defs.length > 0 ? defs : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const agentName = parts.shift() ?? "";
			const taskText = parts.join(" ").trim();

			if (!agentName) {
				ctx.ui.notify("Usage: /subagent <agent> <task>", "warning");
				return;
			}
			if (!taskText) {
				ctx.ui.notify("Usage: /subagent <agent> <task>", "warning");
				return;
			}
			try {
				const result = doSpawn(ctx, { agent: agentName, task: taskText }, spawnContext(ctx, knownToolNames));
				ctx.ui.notify(`Spawned ${agentName} in pane ${String(result.details["pane"])}`, "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});

	// ── Command: /workers — global view of live headless workers ──

	const formatElapsed = (ms: number): string => {
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
		return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
	};

	/** Terminate a worker's whole process tree. Windows needs taskkill /T. */
	const killWorkerTree = (pid: number): void => {
		if (process.platform === "win32") {
			execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				// Already gone — fine.
			}
		}
	};

	pi.registerCommand("workers", {
		description: "Live headless task_batch workers across all sessions (subagents)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "kill") {
				const target = parts[1];
			if (!target) {
					ctx.ui.notify("Usage: /workers kill <id|pid>", "warning");
					return;
			}
				const { workers } = readRunningWorkers(runningIndexPath(subagentSessionsRoot()));
			const worker =
					workers.find((w) => w.id === target) ?? workers.find((w) => String(w.pid) === target);
			if (!worker) {
					ctx.ui.notify(`No live worker matching "${target}".`, "error");
					return;
			}
			try {
					killWorkerTree(worker.pid);
					ctx.ui.notify(`Killed ${worker.label} (pid ${worker.pid}). The batch tool will report the exit.`, "info");
			} catch (err) {
					ctx.ui.notify(`Failed to kill pid ${worker.pid}: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
				return;
			}

			const { workers, reaped } = readRunningWorkers(runningIndexPath(subagentSessionsRoot()));
			if (workers.length === 0) {
				ctx.ui.notify(reaped > 0 ? `No live workers (${reaped} stale record(s) reaped).` : "No live workers.", "info");
				return;
			}
			const now = Date.now();
			const lines = workers.map((w) => {
				const stepTag = w.step !== undefined ? ` step ${w.step}` : "";
				const modeTag = w.mode ? ` ${w.mode}${stepTag}` : "";
				return `${w.id} · pid ${w.pid} · ${formatElapsed(now - w.startedAt)} · ${w.model ?? "?"}${modeTag}\n  ${oneline(w.task, 90)}\n  ${w.sessionFile}`;
			});
			ctx.ui.notify(`Live workers (${workers.length}):

${lines.join("\n\n")}\n
/workers kill <id|pid> to terminate.`, "info");
		},
	});

	// ── Renderer for results ──

	pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
		const details = (message.details ?? {}) as {
			name?: string;
			agent?: string;
			exitCode?: number;
			elapsedSec?: number;
			errorMessage?: string;
			cancelled?: boolean;
		};
		// Cancelled outranks failed: a force-closed cancel carries an
		// errorMessage too, but the verdict the reader needs is "cancelled".
		const status = details.cancelled
			? theme.fg("error", "cancelled")
			: details.errorMessage
				? theme.fg("error", `failed (${details.errorMessage})`)
				: theme.fg("success", "finished");
		const header = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", details.name ?? "?")}${theme.fg("muted", ` · ${status}`)}`;
		const body = typeof message.content === "string" ? message.content : "";
		const text = options.expanded ? `${header}\n${theme.fg("dim", body)}` : `${header}\n${body.split("\n\n").slice(1).join("\n\n")}`;
		return new Text(text, options.outputPad ?? 0, 0);
	});
}
