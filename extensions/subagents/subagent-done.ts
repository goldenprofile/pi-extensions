/**
 * Extension loaded into every subagent (alongside the orchestrator when the
 * agent may spawn children).
 *
 * Responsibilities:
 *   - Record the activity heartbeat the parent's widget consumes (activity.ts).
 *     Streaming deltas (message_update / tool_execution_update) count as
 *     activity, so a healthy long model stream is never misread as a stall.
 *   - Show the agent identity as a one-line widget above the editor.
 *   - Auto-exit: when the agent loop ends cleanly and nothing is in flight,
 *     shut the pi process down so the parent's watcher sees completion.
 *     Interactive agents (auto-exit: false) stay open for the human instead.
 *   - Surface stopReason:"error" turns to the parent via the `<session>.exit`
 *     sidecar so a crashed run is reported as an error, not a clean summary.
 *   - Honor the `<session>.cancel` sidecar written by subagent_cancel: poll
 *     it, abort the running operation, and exit unconditionally on agent_end
 *     — pi has no other API that reaches into a busy runaway turn.
 *
 * Subagents do NOT self-terminate via a tool. A subagent that spawned its own
 * children stays open until they have reported back (runningChildrenCount),
 * otherwise it would strand them before their results arrive.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, writeFileSync } from "node:fs";
import { createActivityRecorder } from "./activity.ts";
import { cancelSidecarPath } from "./shared.ts";

/** True when at least one child subagent of this session is still running. */
export function runningChildrenCount(): number {
	const fn = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents/running-children-count")];
	return typeof fn === "function" ? (fn() as number) : 0;
}

/**
 * Decide auto-exit from the finished agent run:
 *   - last assistant turn completed normally → exit,
 *   - aborted by the user (Esc) → stay open for inspection / another prompt,
 *   - manual input during an interactive session is ignored on purpose:
 *     auto-exit is decided by the turn outcome, not by who typed last.
 */
export function shouldAutoExitOnAgentEnd(messages: Array<{ role?: string; stopReason?: string }> | undefined): boolean {
	if (messages) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.role === "assistant") return msg.stopReason !== "aborted";
		}
	}
	return true;
}

export interface SubagentErrorInfo {
	errorMessage: string;
}

/**
 * Error details from the latest assistant turn, when it ended with
 * stopReason:"error" (auto-retry exhausted, provider overload, …).
 * Returns null for normal or aborted turns.
 */
export function findLatestAssistantError(messages: Array<{ role?: string; stopReason?: string; errorMessage?: string }> | undefined): SubagentErrorInfo | null {
	if (!messages) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason !== "error") return null;
		const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
		return { errorMessage: raw || "agent loop ended with stopReason=error (no errorMessage field)" };
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
	const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
	const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
	const sessionFile = process.env.PI_SUBAGENT_SESSION ?? "";

	const recorder = createActivityRecorder({
		runningChildId: process.env.PI_SUBAGENT_ID ?? "",
		activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE ?? "",
	});

	// The parent drops this sidecar when the user cancels the run. A file
	// poll is the one channel that reaches a busy child: typed steer messages
	// only land at the next turn boundary, which a runaway turn never hits.
	const cancelFile = sessionFile ? cancelSidecarPath(sessionFile) : "";
	let lastCtx: ExtensionContext | null = null;
	let cancelRequested = false;
	let cancelPoll: ReturnType<typeof setInterval> | null = null;

	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		recorder.sessionStart();
		if (cancelFile) {
			cancelPoll = setInterval(() => {
				if (cancelRequested || !lastCtx) return;
				if (!existsSync(cancelFile)) return;
				cancelRequested = true;
				// Kill whatever is in flight: abort a running turn (agent_end below
				// then exits the process), or shut an already-idle one down now.
				if (!lastCtx.isIdle()) lastCtx.abort();
				else lastCtx.shutdown();
			}, 500);
		}
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			"subagent-identity",
			(_tui, theme) => {
				const label = subagentAgent || subagentName || "subagent";
				const mode = autoExit ? "auto" : "interactive";
				return new Text(theme.fg("accent", `[${label}]`) + theme.fg("dim", ` subagent · ${mode}`), 0, 0);
			},
			{ placement: "aboveEditor" },
		);
	});

	pi.on("session_shutdown", () => {
		// The process is going down anyway — just stop the cancel poller.
		if (cancelPoll) {
			clearInterval(cancelPoll);
			cancelPoll = null;
		}
	});

	pi.on("agent_start", () => {
		recorder.agentStart();
	});

	// Streaming and long-running tool output are the liveness pulse: a phase
	// can legitimately produce no lifecycle events for minutes while the
	// child is fine — these deltas keep the parent's stall detector quiet.
	pi.on("message_update", () => {
		recorder.heartbeat();
	});

	pi.on("tool_execution_update", () => {
		recorder.heartbeat();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		// Defense in depth: no new tool work once a cancel has been honored —
		// the abort may race a tool call that was already accepted.
		if (cancelRequested) {
			ctx.abort();
			return;
		}
		recorder.toolExecutionStart(event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_end", () => {
		recorder.toolExecutionEnd();
	});

	pi.on("agent_end", (event, ctx) => {
		lastCtx = ctx;
		const messages = (event as { messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string }> }).messages;

		// Cancelled run: report and exit unconditionally. The normal logic
		// below would keep an aborted turn's pane open for inspection — exactly
		// wrong for a cancel, where the user asked for the pane to go away.
		if (cancelRequested) {
			if (sessionFile) {
				try {
					writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "cancelled" }));
				} catch {
					// Best effort — the parent force-closes the pane if this is lost.
				}
			}
			recorder.agentEndDone();
			ctx.shutdown();
			return;
		}

		// Stay open while work is in flight: children still reporting back.
		const hasPendingChildren = runningChildrenCount() > 0;
		const shouldExit =
			autoExit && !hasPendingChildren && shouldAutoExitOnAgentEnd(messages);

		if (shouldExit) {
			// Report error turns through the sidecar so the parent's watcher
			// can tell a crash from a clean completion.
			const errorInfo = findLatestAssistantError(messages);
			if (errorInfo && sessionFile) {
				try {
					writeFileSync(
						`${sessionFile}.exit`,
						JSON.stringify({ type: "error", errorMessage: errorInfo.errorMessage }),
					);
				} catch {
					// Best effort — the watcher falls back to the transcript.
				}
			}
			recorder.agentEndDone();
			ctx.shutdown();
			return;
		}

		recorder.agentEndWaiting();
	});
}
