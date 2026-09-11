/**
 * herdr surface layer — https://herdr.dev
 *
 * herdr is a terminal multiplexer for coding agents with server-owned PTYs.
 * When pi runs inside a herdr pane (HERDR_ENV=1), herdr owns the terminal
 * surface: splitting through wezterm fails ("pane_id N invalid") because the
 * inherited WEZTERM_PANE belongs to the herdr client's pane, not to a pane
 * this process may manage. Everything here therefore goes through the
 * `herdr` CLI, which talks to the session socket the pane was created with.
 *
 * Mapping from the wezterm surface:
 *   split-pane  → `pane split` (right/down, --ratio 0..1, --no-focus — herdr
 *                 never steals focus, so no activate-pane dance is needed),
 *                 then `pane run` to launch the pwsh launcher in the new pane
 *   send-text   → `pane run` (types the text and presses Enter atomically)
 *   get-text    → `pane read --source recent --lines N`
 *   list        → `pane list` (JSON, .result.panes[].pane_id, e.g. "w1:p2")
 *   kill-pane   → `pane close`
 *
 * Live-verified against herdr 0.9.0:
 *   - `pane split` answers {"result":{"pane":{"pane_id":"w6:p2",…}}}
 *   - `pane run <id> <text…>` types text + Enter; do NOT pass a `--`
 *     separator (it is typed into the pane literally); leading "-" is fine
 *     when steering a TUI — the text is delivered, whatever the shell makes
 *     of it afterwards
 *   - `pane read` answers with plain text
 *   - herdr never reuses closed pane ids, so stale registry paneIds from
 *     finished sessions reliably report as gone
 */
import { execFileSync } from "node:child_process";
import { computeStackPercent } from "./shared.ts";

const HERDR = "herdr";
const PWSH = "pwsh";

let herdrBinaryProbe: boolean | null = null;

/** True when the process runs inside a herdr-managed pane. */
export function isHerdrEnv(): boolean {
	return process.env.HERDR_ENV === "1";
}

/** HERDR_ENV=1 with the herdr CLI actually on PATH. */
export function isHerdrAvailable(): boolean {
	if (!isHerdrEnv()) return false;
	if (herdrBinaryProbe !== null) return herdrBinaryProbe;
	try {
		execFileSync(HERDR, ["--version"], { stdio: "ignore", timeout: 10_000, windowsHide: true });
		herdrBinaryProbe = true;
	} catch {
		herdrBinaryProbe = false;
	}
	return herdrBinaryProbe;
}

/** The parent pi's own herdr pane id (e.g. "w1:p2"). Empty when not in herdr. */
export function parentPaneId(): string {
	return process.env.HERDR_PANE_ID ?? "";
}

function runHerdr(args: string[], timeoutMs = 15_000): string {
	return execFileSync(HERDR, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
}

// ── Response parsing (exported for tests; shapes captured from 0.9.0) ──

/** Extract `.result.pane.pane_id` from a `pane split` response. */
export function parseSplitPaneId(out: string): string {
	const parsed = JSON.parse(out) as {
		result?: { pane?: { pane_id?: unknown }; pane_id?: unknown };
	};
	const id = parsed.result?.pane?.pane_id ?? parsed.result?.pane_id;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error(`Unexpected herdr pane split response: ${out.slice(0, 200)}`);
	}
	return id;
}

/** Extract pane ids from a `pane list` response. Tolerates shape drift. */
export function parsePaneListIds(out: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(out);
	} catch {
		return [];
	}
	const result = (parsed as { result?: unknown }).result;
	const panes = Array.isArray(result)
		? result
		: Array.isArray((result as { panes?: unknown })?.panes)
			? (result as { panes: unknown[] }).panes
			: [];
	const ids: string[] = [];
	for (const pane of panes) {
		const id = (pane as { pane_id?: unknown } | null)?.pane_id;
		if (typeof id === "string" && id.length > 0) ids.push(id);
	}
	return ids;
}

// ── Surface primitives ──

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
 * Create a pane for a subagent.
 *
 * First subagent: a right split off the parent pi's pane (50/50). Subsequent
 * subagents split the top pane of that column downward with an even-stack
 * ratio (computeStackPercent / 100). The split runs with --no-focus — herdr
 * keeps the user's keyboard where it is, unlike wezterm's split-pane.
 *
 * Returns the new pane id (e.g. "w1:p2").
 */
export function createSubagentPane(opts: CreatePaneOptions): string {
	if (!isHerdrAvailable()) {
		throw new Error("pi looks like it runs inside herdr (HERDR_ENV=1) but the `herdr` CLI was not found on PATH.");
	}
	const stacking = opts.runningCount > 0 && opts.topPane;
	const target = stacking ? opts.topPane : parentPaneId();
	if (!target) {
		throw new Error("herdr pane id of the parent session is unknown (HERDR_PANE_ID is empty).");
	}

	const out = runHerdr([
		"pane",
		"split",
		"--pane",
		target,
		"--direction",
		stacking ? "down" : "right",
		"--ratio",
		(computeStackPercent(opts.runningCount) / 100).toFixed(2),
		"--cwd",
		opts.cwd,
		"--no-focus",
	]);
	const paneId = parseSplitPaneId(out);
	launchScript(paneId, opts.ps1Path);
	return paneId;
}

/** Type a launcher invocation into the pane; pwsh stays open after the child exits. */
function launchScript(paneId: string, ps1Path: string): void {
	// Windows paths cannot contain `"`, so double quotes are unambiguous and
	// work under pwsh, cmd and bash alike. One argv element on purpose: herdr
	// joins COMMAND args with spaces, so quoting must survive on our side.
	runHerdr([
		"pane",
		"run",
		paneId,
		`${PWSH} -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "${ps1Path}"`,
	]);
}

/** Send text to a pane and submit it (pane run = text + Enter, one write). */
export function sendText(paneId: string, text: string): void {
	const flattened = text.replace(/\r?\n/g, " ").trim();
	runHerdr(["pane", "run", paneId, flattened]);
}

/** Run a launcher script in a pane that is sitting at a shell prompt (resume). */
export function runScriptInPane(paneId: string, scriptPath: string): void {
	launchScript(paneId, scriptPath);
}

/** Read the last `lines` lines of a pane's output. Returns "" when the pane is gone. */
export function readScreenTail(paneId: string, lines = 6): string {
	try {
		return runHerdr(["pane", "read", paneId, "--source", "recent", "--lines", String(Math.max(1, lines))]);
	} catch {
		return "";
	}
}

/** Ids of all panes in the caller's herdr workspace (all workspaces if unknown). */
export function listPaneIds(): Set<string> {
	try {
		const args = ["pane", "list"];
		const workspace = process.env.HERDR_WORKSPACE_ID;
		if (workspace) args.push("--workspace", workspace);
		return new Set(parsePaneListIds(runHerdr(args)));
	} catch {
		return new Set();
	}
}

export function paneExists(paneId: string, known?: Set<string>): boolean {
	const ids = known ?? listPaneIds();
	return ids.has(paneId);
}

/** Close a pane. Best-effort: a closing pane must never break the parent. */
export function closePane(paneId: string): void {
	try {
		runHerdr(["pane", "close", paneId]);
	} catch {
		// Pane may already be gone.
	}
}

/** No-op: herdr splits run with --no-focus, so the user never loses focus. */
export function activatePane(_paneId: string): void {}
