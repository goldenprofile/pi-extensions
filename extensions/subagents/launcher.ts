/**
 * Launcher script generation.
 *
 * A subagent pane runs:  pwsh -NoExit -File <launcher.ps1>
 *
 * The launcher carries everything the child needs — env identity, cwd, the
 * full pi command — so the pane itself is a plain interactive pwsh before and
 * after the run. That gives us, for free:
 *   - no shell-ready race at spawn (the script IS the pane's first program),
 *   - a persistent transcript after pi exits (-NoExit keeps the pane),
 *   - a prompt to type steering and resume commands into.
 *
 * Long tasks are NOT inlined: the task is written to an artifact file and
 * handed over as `@<file>`, which keeps the command line short and preserves
 * the exact prompt for debugging.
 *
 * Deliberately dependency-free so tests can run standalone.
 */

/** PowerShell single-quoted string literal ('' escapes a quote). */
export function ps1Literal(s: string): string {
	return "'" + String(s).replace(/'/g, "''") + "'";
}

export interface LauncherSpec {
	name: string;
	id: string;
	/** Absolute path of the pi CLI shim (pi.cmd) resolved by the parent. */
	piPath: string;
	sessionFile: string;
	/** -e extension paths loaded into the child (done extension, orchestrator for nested). */
	extensionPaths: string[];
	/** Disable extension discovery (-ne): used when the agent has a tool allowlist. */
	noExtensions: boolean;
	cwd?: string;
	model?: string;
	thinking?: string;
	/** Tool allowlist → --tools. */
	tools?: string[];
	/** Tool denylist → -xt. */
	excludeTools?: string[];
	/**
	 * Path of a file whose contents are appended to the child's system prompt.
	 * Identity MUST go through a file: a .cmd shim truncates the command line at
	 * the first newline, so multi-line prompt text passed inline silently
	 * amputates every argument after it (the task file included).
	 */
	appendSystemPromptFile?: string;
	/** Task file handed to the child as @file. */
	taskFile: string;
	/** Sidecar written by the launcher when pi exits: its content is the exit code. */
	doneFile: string;
	/** PI_* environment for the child. */
	env: Record<string, string>;
}

interface Token {
	value: string;
	/** Flags pass through bare, everything else is single-quoted. */
	bare: boolean;
}

function buildPiArgs(spec: LauncherSpec): Token[] {
	const tokens: Token[] = [{ value: spec.piPath, bare: false }];
	tokens.push({ value: "--session", bare: true }, { value: spec.sessionFile, bare: false });
	for (const ext of spec.extensionPaths) {
		tokens.push({ value: "-e", bare: true }, { value: ext, bare: false });
	}
	if (spec.noExtensions) tokens.push({ value: "-ne", bare: true });
	if (spec.model) tokens.push({ value: "--model", bare: true }, { value: spec.model, bare: false });
	if (spec.thinking) tokens.push({ value: "--thinking", bare: true }, { value: spec.thinking, bare: false });
	if (spec.tools && spec.tools.length > 0) {
		tokens.push({ value: "--tools", bare: true }, { value: spec.tools.join(","), bare: false });
	}
	if (spec.excludeTools && spec.excludeTools.length > 0) {
		tokens.push({ value: "-xt", bare: true }, { value: spec.excludeTools.join(","), bare: false });
	}
	if (spec.appendSystemPromptFile) {
		tokens.push({ value: "--append-system-prompt", bare: true }, { value: spec.appendSystemPromptFile, bare: false });
	}
	tokens.push({ value: `@${spec.taskFile}`, bare: false });
	return tokens;
}

/**
 * Render the launcher. Ends with the screen sentinel (crash detection via
 * get-text) and the `.done` sidecar carrying the exit code (the fast,
 * race-free completion path).
 */
export function renderLauncherPs1(spec: LauncherSpec): string {
	const lines: string[] = [];
	lines.push(`# pi subagent launcher — ${spec.name} (${spec.id})`);
	lines.push(`# Generated: ${new Date().toISOString()}`);
	lines.push(`# Session: ${spec.sessionFile}`);
	// Resume race: a resume in an existing pane inherits the PREVIOUS run's
	// __SUBAGENT_DONE_*__ sentinel on screen — the parent's screen check
	// right after the resume would read it as THIS run already finishing.
	// Clear the pane before anything else.
	lines.push("Clear-Host");
	lines.push(`try { $Host.UI.RawUI.WindowTitle = ${ps1Literal(`pi:${spec.name}`)} } catch {}`);
	for (const [key, value] of Object.entries(spec.env)) {
		lines.push(`$env:${key} = ${ps1Literal(value)}`);
	}
	if (spec.cwd) {
		lines.push(`Set-Location -LiteralPath ${ps1Literal(spec.cwd)}`);
	}
	const argLine = buildPiArgs(spec)
		.map((t) => (t.bare ? t.value : ps1Literal(t.value)))
		.join(" ");
	lines.push(`& ${argLine}`);
	lines.push("$code = $LASTEXITCODE");
	lines.push(`Write-Host "__SUBAGENT_DONE_\${code}__"`);
	lines.push(`Set-Content -LiteralPath ${ps1Literal(spec.doneFile)} -Value $code -NoNewline`);
	lines.push("");
	return lines.join("\r\n");
}
