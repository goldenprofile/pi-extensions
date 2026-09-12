/**
 * Pure helpers shared by the mux backends: completion sentinel parsing and
 * split-layout math. No child_process, no env reads — safe to unit-test.
 */

// ── Completion detection ──

export const SENTINEL_PATTERN = /__SUBAGENT_DONE_(\d+)__/;

/** Extract an exit code from a `__SUBAGENT_DONE_<code>__` sentinel line, or null. */
export function parseSentinel(screenText: string): number | null {
	const match = SENTINEL_PATTERN.exec(screenText);
	if (!match) return null;
	const code = Number.parseInt(match[1] ?? "", 10);
	return Number.isFinite(code) ? code : null;
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

// ── Cancel / interrupt ──

/** Sidecar file whose presence tells the child its run was cancelled. */
export function cancelSidecarPath(sessionFile: string): string {
	return `${sessionFile}.cancel`;
}

/** Verdict of an `.exit` sidecar body — what pollTick should do with it. */
export type ExitSidecarVerdict =
	| { kind: "error"; errorMessage?: string }
	| { kind: "cancelled" }
	| { kind: "unknown" };

/**
 * Classify a raw `.exit` sidecar body written by the child extension:
 * {type:"cancelled"} → cancelled; an object with a non-empty string
 * errorMessage → error; anything else (bad JSON, empty/missing message) →
 * unknown — the caller then falls back to its generic error text.
 */
export function classifyExitSidecar(raw: string): ExitSidecarVerdict {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "unknown" };
	}
	if (parsed === null || typeof parsed !== "object") return { kind: "unknown" };
	const obj = parsed as { type?: unknown; errorMessage?: unknown };
	if (obj.type === "cancelled") return { kind: "cancelled" };
	if (typeof obj.errorMessage === "string" && obj.errorMessage.length > 0) {
		return { kind: "error", errorMessage: obj.errorMessage };
	}
	return { kind: "unknown" };
}

/**
 * Resolve the `interrupt` flag of subagent_message. Explicit true/false wins;
 * when omitted, a stalled subagent is interrupted automatically — steering a
 * stalled worker is pointless if it only lands at the next turn boundary,
 * which is exactly what "stalled" says never comes.
 */
export function resolveInterrupt(interrupt: boolean | undefined, stalled: boolean): boolean {
	if (interrupt === true) return true;
	if (interrupt === false) return false;
	return stalled;
}
