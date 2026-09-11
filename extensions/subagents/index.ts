/**
 * Interactive subagents for pi — Windows edition: WezTerm panes + pwsh.
 *
 * Spawn a sub-agent into its own WezTerm pane, keep working in the main
 * session, and get the result steered back when it finishes. Fully
 * non-blocking. Adapted from amosblomqvist/pi-interactive-subagents (tmux)
 * with the surface layer rewritten for `wezterm cli` + PowerShell 7.
 *
 * Tools:
 *   subagent         — spawn a sub-agent in a dedicated pane (fire-and-forget)
 *   subagent_message — message by name: steers a running one, resumes a
 *                      finished one (same name either way)
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
 * sentinel `__SUBAGENT_DONE_<code>__` is the last-resort fallback. Finished
 * panes stay open at a pwsh prompt — transcript visible, resume is one
 * command away.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents, type AgentDef } from "./agents.ts";
import { activityLabel, readActivityState, type SubagentActivityState } from "./activity.ts";
import {
	displayItems,
	emptyResult,
	formatToolCall,
	formatUsageStats,
	finalOutput,
	isFailedResult,
	isRunning,
	mapWithConcurrencyLimit,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	resultOutput,
	runHeadlessChild,
	substitutePrevious,
	truncateOutput,
	type BatchMessage,
	type BatchResult,
} from "./batch.ts";
import { renderLauncherPs1, type LauncherSpec } from "./launcher.ts";
import { formatUsage, summarizeSessionFile } from "./session-read.ts";
import { readNameRegistry, registryPath, uniqueName, upsertName, type RegistryEntry } from "./registry.ts";
import {
	createSubagentPane,
	listPaneIds,
	paneExists,
	parseSentinel,
	readScreenTail,
	runScriptInPane,
	sendText,
} from "./wezterm.ts";

const POLL_INTERVAL_MS = 1000;
const STALLED_AFTER_MS = 60_000;
const MAX_SUMMARY_CHARS = 2000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DONE_EXTENSION_PATH = join(MODULE_DIR, "subagent-done.ts");

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
		if (r.activity.state) {
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

function completeSubagent(running: RunningSubagent, result: { exitCode: number; errorMessage?: string; crashed?: boolean }): void {
	runningSubagents.delete(running.id);
	publishRunningChildrenCount();

	if (tickTimer && runningSubagents.size === 0) {
		clearInterval(tickTimer);
		tickTimer = null;
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
	const statusLine = result.errorMessage
		? `failed after ${elapsedText}`
		: `finished in ${elapsedText}`;

	const content = [
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
				...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
				...(usage ? { usage } : {}),
				...(model ? { model } : {}),
			},
		} as Parameters<ExtensionAPI["sendMessage"]>[0],
		{ triggerTurn: true, deliverAs: "steer" },
	);

	updateWidget();
}

function notifyStalled(running: RunningSubagent, stalled: boolean): void {
	const elapsed = fmtElapsed(Math.floor((Date.now() - running.startTime) / 1000));
	const text = stalled
		? `Sub-agent "${running.name}" looks stalled: no activity for a while (total ${elapsed}). You can steer it with subagent_message({ name: "${running.name}", message: "…" }) or ignore it.`
		: `Sub-agent "${running.name}" is active again after stalling.`;
	latestPi?.sendMessage(
		{
			customType: "subagent_status",
			content: text,
			display: true,
			details: { name: running.name, stalled },
		} as Parameters<ExtensionAPI["sendMessage"]>[0],
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

function observeActivity(running: RunningSubagent, now: number): void {
	const read = readActivityState(running.activityFile, running.id);
	if (read.ok) {
		const obs = running.activity;
		if (!obs.state || read.state.sequence !== obs.state.sequence) {
			obs.lastChangeAt = now;
			if (obs.stalled) {
				obs.stalled = false;
				if (running.autoExit) notifyStalled(running, false);
			}
		}
		obs.state = read.state;
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

		// 2. Error sidecar written by the child extension on stopReason=error.
		if (existsSync(running.exitSidecarFile)) {
			let errorMessage = "Subagent exited with stopReason=error.";
			try {
				const parsed = JSON.parse(readDoneFile(running.exitSidecarFile)) as { errorMessage?: string };
				if (parsed?.errorMessage) errorMessage = parsed.errorMessage;
			} catch {
				// Keep default message.
			}
			completeSubagent(running, { exitCode: 1, errorMessage });
			continue;
		}

		// 3. Pane vanished without finishing → crashed or closed by the user.
		if (!alive.has(running.paneId)) {
			completeSubagent(running, { exitCode: 1, crashed: true, errorMessage: "pane closed" });
			continue;
		}

		// 4. Screen sentinel fallback (sidecars failed to write).
		const sentinel = parseSentinel(readScreenTail(running.paneId, 4));
		if (sentinel !== null) {
			completeSubagent(running, { exitCode: sentinel });
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

function spawnContext(ctx: ExtensionContext): SpawnContext {
	return {
		defs: discoverAgents(ctx.cwd, getAgentDir()),
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
		extensionPaths: [DONE_EXTENSION_PATH, ...(opts.grantSpawning ? [join(MODULE_DIR, "index.ts")] : [])],
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
	});
	writeFileSync(scriptPath, renderLauncherPs1(spec), "utf8");

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
					`Sub-agent "${name}" (${def.name}) spawned in WezTerm pane ${paneId}. It runs fully autonomously — ` +
					`do NOT wait for it and do NOT poll for its status. When it finishes, the harness AUTOMATICALLY delivers ` +
					`its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. ` +
					`Meanwhile: keep working on other independent tasks, or end your turn immediately. ` +
					`To send additional instructions later: subagent_message({ name: "${name}", message: "…" }).`,
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

	const paneAlive = entry.paneId ? paneExists(entry.paneId) : false;
	let paneId: string;
	if (paneAlive && entry.paneId) {
		// The pane is sitting at a pwsh prompt — run the resume launcher there.
		runScriptInPane(entry.paneId, scriptPath);
		paneId = entry.paneId;
	} else {
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

export default function subagentsExtension(pi: ExtensionAPI) {
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
			"Spawn a sub-agent in a dedicated WezTerm pane (async, fire-and-forget). " +
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
			const sctx = spawnContext(ctx);
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
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sctx = spawnContext(ctx);
			const name = params.name.trim();
			const message = params.message.trim();
			if (!message) throw new Error("`message` is required.");

			const running = Array.from(runningSubagents.values()).find((r) => r.name === name);
			if (running) {
				sendText(running.paneId, message);
				running.activity.lastChangeAt = Date.now();
				running.activity.stalled = false;
				updateWidget();
				return {
					content: [
						{
							type: "text",
							text: `Message delivered to running subagent "${name}". It picks this up at its next turn boundary. If it exits, its result still arrives as a steer message.`,
						},
					],
					details: { name, status: "steered" },
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

	const PANE_TOOLS_DENYLIST = ["subagent", "subagent_message", "subagents_list"];

	interface BatchDetails {
		mode: "single" | "parallel" | "chain";
		results: BatchResult[];
	}

	const makeBatchDetails = (mode: BatchDetails["mode"], results: BatchResult[]): BatchDetails => ({ mode, results });

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
					signal,
					onEvent: onChildEvent,
					step,
				});
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

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const inferredMode: BatchDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : "single";

			if (modeCount !== 1) {
				const available = Array.from(defs.keys()).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode (agent+task, tasks, or chain).\nAvailable agents: ${available}` }],
					details: makeBatchDetails("single", []),
				};
			}

			// ── Chain ──
			if (hasChain && params.chain) {
				const results: BatchResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = substitutePrevious(step.task, previousOutput);
					const chainUpdate = onUpdate
						? (partial: { content?: unknown; details?: unknown }) => {
								const current = (partial.details as BatchDetails | undefined)?.results[0];
								if (current) {
									onUpdate({
										content: [{ type: "text", text: finalOutput(current.messages) || "(running...)" }],
										details: makeBatchDetails("chain", [...results, current]),
									});
								}
							}
					: undefined;

					const result = await runSingle(step.agent, taskWithContext, step.cwd, i + 1, (r) =>
						chainUpdate?.({ details: makeBatchDetails("chain", [r]) }),
					);
					results.push(result);

					if (isFailedResult(result)) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${resultOutput(result)}` }],
							details: makeBatchDetails("chain", results),
							isError: true,
						};
					}
					previousOutput = finalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: finalOutput(results[results.length - 1]?.messages ?? []) || "(no output)" }],
					details: makeBatchDetails("chain", results),
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

				const allResults: BatchResult[] = params.tasks.map((t) => ({
					...emptyResult(t.agent, t.task),
					exitCode: -1,
				}));

				const emitParallelUpdate = () => {
					if (!onUpdate) return;
					const running = allResults.filter((r) => isRunning(r)).length;
					const done = allResults.length - running;
					onUpdate({
						content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
						details: makeBatchDetails("parallel", [...allResults]),
					});
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
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
			const result = await runSingle(
				params.agent ?? "",
				params.task ?? "",
				params.cwd,
				undefined,
				onUpdate
					? (r) =>
							onUpdate({
								content: [{ type: "text", text: finalOutput(r.messages) || "(running...)" }],
								details: makeBatchDetails("single", [r]),
							})
					: undefined,
			);
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
		},

		renderCall(args, theme, _context) {
			const chain = args.chain as Array<{ agent: string; task: string }> | undefined;
			const tasks = args.tasks as Array<{ agent: string; task: string }> | undefined;
			if (chain && chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("task_batch ")) +
					theme.fg("accent", `chain (${chain.length} steps)`);
				for (let i = 0; i < Math.min(chain.length, 3); i++) {
					const step = chain[i];
					const cleanTask = (step.task as string).replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text += "\n  " + theme.fg("muted", `${i + 1}.`) + " " + theme.fg("accent", step.agent) + theme.fg("dim", ` ${preview}`);
				}
				if (chain.length > 3) text += `\n  ${theme.fg("muted", `... +${chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (tasks && tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("task_batch ")) +
					theme.fg("accent", `parallel (${tasks.length} tasks)`);
				for (const t of tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = (args.agent as string) || "...";
			const task = (args.task as string) || "";
			const preview = task ? (task.length > 60 ? `${task.slice(0, 60)}...` : task) : "...";
			const text =
				theme.fg("toolTitle", theme.bold("task_batch ")) +
				theme.fg("accent", agentName) +
				`\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, _context) {
			const expanded = options.expanded;
			const details = result.details as BatchDetails | undefined;
			if (!details || details.results.length === 0) {
				const first = result.content[0] as { type?: string; text?: string } | undefined;
				return new Text(first?.type === "text" ? first.text ?? "(no output)" : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
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
			const childCard = (container: Container, r: BatchResult, label: string): void => {
				const rIcon = isRunning(r)
					? theme.fg("warning", "⏳")
					: isFailedResult(r)
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				container.addChild(new Spacer(1));
				container.addChild(new Text(`${theme.fg("muted", label)}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				for (const item of displayItems(r.messages)) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(theme.fg("muted", "→ ") + formatToolCall(item.name ?? "", item.args ?? {}, theme.fg), 0, 0),
						);
					}
				}
				const output = finalOutput(r.messages);
				if (output) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
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

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const items = displayItems(r.messages);
				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					const output = finalOutput(r.messages);
					if (items.length === 0 && !output) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
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
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (items.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else text += `\n${collapsedItems(items, 10)}`;
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => !isFailedResult(r)).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon + " " + theme.fg("toolTitle", theme.bold("chain ")) + theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);
					for (const r of details.results) {
						childCard(container, r, `─── Step ${r.step}: `);
					}
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}
				let text = icon + " " + theme.fg("toolTitle", theme.bold("chain ")) + theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓")}`;
					const items = displayItems(r.messages);
					text += items.length === 0 ? `\n${theme.fg("muted", "(no output)")}` : `\n${collapsedItems(items, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				return new Text(text, 0, 0);
			}

			// parallel
			const running = details.results.filter((r) => isRunning(r)).length;
			const successCount = details.results.filter((r) => !isRunning(r) && !isFailedResult(r)).length;
			const failCount = details.results.filter((r) => !isRunning(r) && isFailedResult(r)).length;
			const isRunningBatch = running > 0;
			const icon = isRunningBatch
				? theme.fg("warning", "⏳")
				: failCount > 0
					? theme.fg("warning", "◐")
					: theme.fg("success", "✓");
			const status = isRunningBatch
				? `${successCount + failCount}/${details.results.length} done, ${running} running`
				: `${successCount}/${details.results.length} tasks`;
			if (expanded && !isRunningBatch) {
				const container = new Container();
				container.addChild(
					new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
				);
				for (const r of details.results) {
					childCard(container, r, "─── ");
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
				}
				return container;
			}
			let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
			for (const r of details.results) {
				const rIcon = isRunning(r) ? theme.fg("warning", "⏳") : isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const items = displayItems(r.messages);
				text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
				text +=
					items.length === 0
						? `\n${theme.fg("muted", isRunning(r) ? "(running...)" : "(no output)")}`
						: `\n${collapsedItems(items, 5)}`;
			}
			if (!isRunningBatch) {
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
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
				const result = doSpawn(ctx, { agent: agentName, task: taskText }, spawnContext(ctx));
				ctx.ui.notify(`Spawned ${agentName} in pane ${String(result.details["pane"])}`, "info");
			} catch (err) {
				ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
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
		};
		const status = details.errorMessage
			? theme.fg("error", `failed (${details.errorMessage})`)
			: theme.fg("success", "finished");
		const header = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", details.name ?? "?")}${theme.fg("muted", ` · ${status}`)}`;
		const body = typeof message.content === "string" ? message.content : "";
		const text = options.expanded ? `${header}\n${theme.fg("dim", body)}` : `${header}\n${body.split("\n\n").slice(1).join("\n\n")}`;
		return new Text(text, options.outputPad ?? 0, 0);
	});
}
