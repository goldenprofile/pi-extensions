/**
 * WezTerm surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create a pane, type into it, read its screen, check liveness, close it.
 * Keeping the wezterm calls isolated here means index.ts stays testable
 * without a terminal multiplexer running.
 *
 * Panes are identified by WezTerm pane ids (e.g. "3"). Splits always start
 * from the parent pi's pane (`WEZTERM_PANE`), so they follow the agent rather
 * than the user's focus.
 *
 * Windows specifics:
 *   - All calls go through execFileSync with an args array (no shell), so no
 *     quoting/escaping is needed for paths with spaces.
 *   - `wezterm cli split-pane` steals keyboard focus in every known version.
 *     We immediately hand focus back to the parent pane via `activate-pane`.
 *   - There is no layout command like tmux's even-horizontal. Even stacking is
 *     approximated by always splitting the top pane of the subagent column
 *     downward with percent k/(k+1) — see computeStackPercent().
 */
import { execFileSync } from "node:child_process";

const WEZTERM = "wezterm";
const PWSH = "pwsh";

let weztermAvailable: boolean | null = null;
let pwshAvailable: boolean | null = null;

function probe(command: string, cache: { value: boolean | null }): boolean {
	if (cache.value !== null) return cache.value;
	try {
		execFileSync(command, ["--version"], { stdio: "ignore" });
		cache.value = true;
	} catch {
		cache.value = false;
	}
	return cache.value;
}

const weztermProbe = { value: null as boolean | null };
const pwshProbe = { value: null as boolean | null };

/**
 * True when running inside WezTerm (WEZTERM_PANE is set by WezTerm in every
 * process it spawns) with the wezterm CLI on PATH.
 */
export function isWezTermAvailable(): boolean {
	if (!process.env.WEZTERM_PANE) return false;
	return probe(WEZTERM, weztermProbe);
}

/** True when pwsh (PowerShell 7+) is on PATH. */
export function isPwshAvailable(): boolean {
	return probe(PWSH, pwshProbe);
}

export function muxSetupHint(): string {
	return "Start pi inside WezTerm and make sure `wezterm` and `pwsh` are on PATH.";
}

/**
 * The parent pi's own pane id ("1", "42", …). Empty string when not in WezTerm.
 */
export function parentPaneId(): string {
	return process.env.WEZTERM_PANE ?? "";
}

function runWezterm(args: string[], timeoutMs = 15_000): string {
	return execFileSync(WEZTERM, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true });
}

// ── Pane liveness ──

/** Ids of all panes WezTerm currently knows about. */
export function listPaneIds(): Set<string> {
	try {
		const out = runWezterm(["cli", "list", "--format", "json"]);
		const panes: Array<{ pane_id: number }> = JSON.parse(out);
		return new Set(panes.map((p) => String(p.pane_id)));
	} catch {
		return new Set();
	}
}

export function paneExists(paneId: string, known?: Set<string>): boolean {
	const ids = known ?? listPaneIds();
	return ids.has(paneId);
}

// ── Layout math ──

/**
 * Percent for splitting the top pane of an existing, evenly stacked column of
 * `runningCount` panes so that the new stack stays even.
 *
 * A column of k equal panes has each pane at height H/k; the new pane must get
 * H/(k+1), which is k/(k+1) of the split target: k=1 → 50%, k=2 → 67%,
 * k=3 → 75%, k=4 → 80%.
 */
export function computeStackPercent(runningCount: number): number {
	if (runningCount < 1) return 50;
	return Math.round((runningCount * 100) / (runningCount + 1));
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
 * First subagent: a right split off the parent pi's pane (50/50) — the parent
 * keeps a full-height column, subagents stack in the right one. Subsequent
 * subagents split the top pane of that column downward with an even-stack
 * percent. After every split, focus is handed back to the parent pane
 * (WezTerm's split-pane always focuses the new pane).
 *
 * Returns the new pane id (e.g. "7").
 */
export function createSubagentPane(opts: CreatePaneOptions): string {
	if (!isWezTermAvailable()) {
		throw new Error(`WezTerm is required for subagents. ${muxSetupHint()}`);
	}
	if (!isPwshAvailable()) {
		throw new Error("pwsh (PowerShell 7+) is required for subagents but was not found on PATH.");
	}

	const parent = parentPaneId();
	const args = ["cli", "split-pane"];

	if (opts.runningCount > 0 && opts.topPane) {
		args.push("--pane-id", opts.topPane, "--bottom", "--percent", String(computeStackPercent(opts.runningCount)));
	} else {
		args.push("--pane-id", parent, "--right", "--percent", "50");
	}

	args.push("--cwd", opts.cwd);
	args.push(
		"--",
		PWSH,
		"-NoLogo",
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-NoExit",
		"-File",
		opts.ps1Path,
	);

	const out = runWezterm(args).trim();
	if (!/^\d+$/.test(out)) {
		throw new Error(`Unexpected wezterm split-pane output: ${out}`);
	}

	// split-pane focuses the new pane; give the parent its keyboard back.
	activatePane(parent);
	return out;
}

/**
 * Send text to a pane as a bracketed paste followed by Enter.
 * Bracketed paste is what pi's editor and PSReadLine both handle cleanly;
 * the trailing newline submits.
 */
export function sendText(paneId: string, text: string): void {
	const flattened = text.replace(/\r?\n/g, " ").trim();
	runWezterm(["cli", "send-text", "--pane-id", paneId, `${flattened}\n`]);
}

/**
 * Run a script in a pane that is sitting at a pwsh prompt (finished subagent).
 */
export function runScriptInPane(paneId: string, scriptPath: string): void {
	sendText(paneId, `& ${ps1SingleQuote(scriptPath)}`);
}

/** PowerShell single-quote escaping ('' for a literal quote). */
export function ps1SingleQuote(s: string): string {
	return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * Read the last `lines` lines of a pane's screen.
 * Returns "" when the pane is gone.
 */
export function readScreenTail(paneId: string, lines = 6): string {
	try {
		return runWezterm(["cli", "get-text", "--pane-id", paneId, "--start-line", String(-Math.max(1, lines))]);
	} catch {
		return "";
	}
}

/** Close a pane. Best-effort: a closing pane must never break the parent. */
export function closePane(paneId: string): void {
	try {
		runWezterm(["cli", "kill-pane", "--pane-id", paneId]);
	} catch {
		// Pane may already be gone.
	}
}

/** Focus a pane (used to hand focus back to the parent after splits). */
export function activatePane(paneId: string): void {
	try {
		runWezterm(["cli", "activate-pane", "--pane-id", paneId]);
	} catch {
		// Cosmetic — ignore.
	}
}

// ── Completion detection ──

export const SENTINEL_PATTERN = /__SUBAGENT_DONE_(\d+)__/;

/** Extract an exit code from a `__SUBAGENT_DONE_<code>__` sentinel line, or null. */
export function parseSentinel(screenText: string): number | null {
	const match = SENTINEL_PATTERN.exec(screenText);
	if (!match) return null;
	const code = Number.parseInt(match[1] ?? "", 10);
	return Number.isFinite(code) ? code : null;
}
