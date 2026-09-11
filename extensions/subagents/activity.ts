/**
 * Subagent activity heartbeat.
 *
 * The child side (loaded into every subagent) records what it is doing to a
 * JSON file — phase (starting/active/waiting/done), current tool, a monotonic
 * sequence number — throttled to at most one write per interval so a burst of
 * streaming events stays cheap.
 *
 * The parent side reads that file once per tick to render the live widget and
 * to detect stalled subagents (no sequence bump for a while). The child id is
 * stored inside the file so a stale file from a previous run of the same
 * session is ignored instead of misattributed.
 *
 * Deliberately dependency-free so tests can run standalone.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SubagentActivityPhase = "starting" | "active" | "waiting" | "done";

export interface SubagentActivityState {
	version: 1;
	runningChildId: string;
	createdAt: number;
	updatedAt: number;
	/** Monotonic bump on every recorded event — the stall detector's pulse. */
	sequence: number;
	latestEvent: string;
	phase: SubagentActivityPhase;
	agentActive: boolean;
	toolActive: boolean;
	toolName?: string;
	toolStartedAt?: number;
	activeSince?: number;
	waitingSince?: number;
}

export type ActivityReadResult =
	| { ok: true; state: SubagentActivityState }
	| { ok: false; reason: "missing" | "invalid" | "wrong-id" };

const DEFAULT_THROTTLE_MS = 500;

// ── Child side ──

export interface ActivityRecorder {
	sessionStart(): void;
	agentStart(): void;
	agentEndDone(): void;
	agentEndWaiting(): void;
	toolExecutionStart(toolCallId?: string, toolName?: string): void;
	toolExecutionEnd(): void;
}

/**
 * Create a recorder for a subagent session. All methods are best-effort:
 * an unwritable activity file must never take the subagent down.
 */
export function createActivityRecorder(options: {
	runningChildId: string;
	activityFile: string;
	throttleMs?: number;
}): ActivityRecorder {
	const { runningChildId, activityFile } = options;
	const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;

	// Not running as a subagent (extension loaded in a normal session):
	// the recorder must be a silent no-op, never write to an empty path.
	if (!runningChildId || !activityFile) {
		const noop = () => {};
		return {
			sessionStart: noop,
			agentStart: noop,
			agentEndDone: noop,
			agentEndWaiting: noop,
			toolExecutionStart: noop,
			toolExecutionEnd: noop,
		};
	}

	let state: SubagentActivityState = {
		version: 1,
		runningChildId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		sequence: 0,
		latestEvent: "created",
		phase: "starting",
		agentActive: false,
		toolActive: false,
	};
	let lastWriteAt = 0;
	let dirty = false;

	function record(latestEvent: string, patch: Partial<SubagentActivityState> = {}): void {
		state = {
			...state,
			...patch,
			sequence: state.sequence + 1,
			latestEvent,
			updatedAt: Date.now(),
		};
		dirty = true;
		flush();
	}

	function flush(force = false): void {
		if (!dirty) return;
		const now = Date.now();
		if (!force && now - lastWriteAt < throttleMs) return;
		try {
			mkdirSync(dirname(activityFile), { recursive: true });
			const tmp = `${activityFile}.tmp`;
			writeFileSync(tmp, JSON.stringify(state));
			renameSync(tmp, activityFile);
			dirty = false;
			lastWriteAt = now;
		} catch {
			// Best effort.
		}
	}

	return {
		sessionStart() {
			record("session_start", { phase: "starting" });
			flush(true);
		},
		agentStart() {
			record("agent_start", { phase: "active", agentActive: true, waitingSince: undefined, activeSince: Date.now() });
			flush(true);
		},
		agentEndDone() {
			record("agent_end_done", { phase: "done", agentActive: false, toolActive: false, toolName: undefined });
			flush(true);
		},
		agentEndWaiting() {
			record("agent_end_waiting", {
				phase: "waiting",
				agentActive: false,
				toolActive: false,
				toolName: undefined,
				activeSince: undefined,
				waitingSince: Date.now(),
			});
			flush(true);
		},
		toolExecutionStart(toolCallId?: string, toolName?: string) {
			void toolCallId;
			record("tool_execution_start", { toolActive: true, toolName, toolStartedAt: Date.now() });
		},
		toolExecutionEnd() {
			record("tool_execution_end", { toolActive: false, toolName: undefined, toolStartedAt: undefined });
		},
	};
}

// ── Parent side ──

/**
 * Read and validate a subagent's activity snapshot. Returns reason "wrong-id"
 * when the file belongs to a previous incarnation of the same name — the
 * caller treats that like "missing".
 */
export function readActivityState(activityFile: string, runningChildId: string): ActivityReadResult {
	let raw: string;
	try {
		raw = readFileSync(activityFile, "utf8");
	} catch {
		return { ok: false, reason: "missing" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "invalid" };
	}
	const state = parsed as SubagentActivityState;
	if (
		!state ||
		typeof state !== "object" ||
		state.version !== 1 ||
		typeof state.sequence !== "number"
	) {
		return { ok: false, reason: "invalid" };
	}
	if (state.runningChildId !== runningChildId) {
		return { ok: false, reason: "wrong-id" };
	}
	return { ok: true, state };
}

/**
 * Human label for the widget: what the subagent is doing right now.
 */
export function activityLabel(state: SubagentActivityState): string | null {
	if (state.toolActive && state.toolName) return state.toolName;
	return null;
}
