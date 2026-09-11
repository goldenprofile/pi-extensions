/**
 * Terminal multiplexer dispatch — herdr OR wezterm.
 *
 * Detection precedence: HERDR_ENV=1 wins unconditionally. herdr-managed panes
 * inherit WEZTERM_PANE from the herdr client's own WezTerm pane, but that pane
 * belongs to herdr's client process — splitting through wezterm from inside a
 * herdr pane fails with "pane_id N invalid". Inside herdr, the surface is
 * herdr. Only when HERDR_ENV is absent does WEZTERM_PANE select wezterm.
 *
 * The exported surface mirrors the old wezterm.ts API one-to-one, so callers
 * (index.ts, manual e2e scripts) stay backend-agnostic.
 */
import { parseSentinel, SENTINEL_PATTERN } from "./shared.ts";
import * as herdr from "./herdr.ts";
import * as wezterm from "./wezterm.ts";

export type MuxBackend = "herdr" | "wezterm";

export interface CreatePaneOptions {
	/** Launcher script the new pane executes. */
	ps1Path: string;
	/** Working directory for the pane and its program. */
	cwd: string;
	/** Number of subagents already running (decides right-split vs stack). */
	runningCount: number;
	/** Top pane of the existing subagent column (required when runningCount > 0). */
	topPane?: string;
}

/**
 * Pure selection logic — exported for tests. The regression case: both
 * HERDR_ENV=1 and WEZTERM_PANE set (pi inside a herdr pane) must pick herdr.
 */
export function selectBackend(
	env: Pick<NodeJS.ProcessEnv, "HERDR_ENV" | "WEZTERM_PANE">,
	herdrOk: boolean,
	weztermOk: boolean,
): MuxBackend | null {
	if (env.HERDR_ENV === "1") return herdrOk ? "herdr" : null;
	if (env.WEZTERM_PANE) return weztermOk ? "wezterm" : null;
	return null;
}

let cachedBackend: MuxBackend | null | undefined;

/** The backend this session drives, or null when no mux is usable. */
export function activeBackend(): MuxBackend | null {
	if (cachedBackend === undefined) {
		cachedBackend = selectBackend(process.env, herdr.isHerdrAvailable(), wezterm.isWezTermAvailable());
	}
	return cachedBackend;
}

/** Setup advice tailored to the environment the user actually runs pi in. */
export function muxSetupHint(): string {
	if (herdr.isHerdrEnv()) {
		return "pi is running inside herdr (HERDR_ENV=1) — make sure the `herdr` CLI is on PATH.";
	}
	if (process.env.WEZTERM_PANE) {
		return "Start pi inside WezTerm and make sure `wezterm` and `pwsh` are on PATH.";
	}
	return "Start pi inside WezTerm or herdr (https://herdr.dev) and make sure the matching CLI (`wezterm`/`herdr`) and `pwsh` are on PATH.";
}

function requireBackend(): MuxBackend {
	const backend = activeBackend();
	if (!backend) throw new Error(`No terminal multiplexer available. ${muxSetupHint()}`);
	return backend;
}

/**
 * Create a pane for a subagent. First subagent: a right split off the parent
 * pane (50/50); subsequent ones stack downward with an even-stack percent.
 * Throws when no mux surface is available.
 */
export function createSubagentPane(opts: CreatePaneOptions): string {
	const backend = requireBackend();
	return backend === "herdr" ? herdr.createSubagentPane(opts) : wezterm.createSubagentPane(opts);
}

/** Ids of all panes the mux currently knows about. */
export function listPaneIds(): Set<string> {
	const backend = activeBackend();
	if (!backend) return new Set();
	return backend === "herdr" ? herdr.listPaneIds() : wezterm.listPaneIds();
}

export function paneExists(paneId: string, known?: Set<string>): boolean {
	const backend = activeBackend();
	if (!backend) return false;
	return backend === "herdr" ? herdr.paneExists(paneId, known) : wezterm.paneExists(paneId, known);
}

/** Read the last `lines` lines of a pane's output ("" when the pane is gone). */
export function readScreenTail(paneId: string, lines = 6): string {
	const backend = activeBackend();
	if (!backend) return "";
	return backend === "herdr" ? herdr.readScreenTail(paneId, lines) : wezterm.readScreenTail(paneId, lines);
}

/** Send text to a pane as a single submission (paste + Enter semantics). */
export function sendText(paneId: string, text: string): void {
	const backend = requireBackend();
	if (backend === "herdr") herdr.sendText(paneId, text);
	else wezterm.sendText(paneId, text);
}

/** Run a launcher script in a pane sitting at a shell prompt (resume). */
export function runScriptInPane(paneId: string, scriptPath: string): void {
	const backend = requireBackend();
	if (backend === "herdr") herdr.runScriptInPane(paneId, scriptPath);
	else wezterm.runScriptInPane(paneId, scriptPath);
}

/** Close a pane. Best-effort: must never break the parent. */
export function closePane(paneId: string): void {
	const backend = activeBackend();
	if (!backend) return;
	if (backend === "herdr") herdr.closePane(paneId);
	else wezterm.closePane(paneId);
}

/** Focus hand-back after splits (wezterm needs it; herdr is a no-op). */
export function activatePane(paneId: string): void {
	const backend = activeBackend();
	if (!backend) return;
	if (backend === "herdr") herdr.activatePane(paneId);
	else wezterm.activatePane(paneId);
}

// ── Completion detection (backend-independent) ──

export { parseSentinel, SENTINEL_PATTERN };
