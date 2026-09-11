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
