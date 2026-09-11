/**
 * Extension loaded into every subagent (alongside the orchestrator when the
 * agent may spawn children).
 *
 * Responsibilities:
 *   - Record the activity heartbeat the parent's widget consumes (activity.ts).
 *   - Show the agent identity as a one-line widget above the editor.
 *   - Auto-exit: when the agent loop ends cleanly and nothing is in flight,
 *     shut the pi process down so the parent's watcher sees completion.
 *     Interactive agents (auto-exit: false) stay open for the human instead.
 *   - Surface stopReason:"error" turns to the parent via the `<session>.exit`
 *     sidecar so a crashed run is reported as an error, not a clean summary.
 *
 * Subagents do NOT self-terminate via a tool. A subagent that spawned its own
 * children stays open until they have reported back (runningChildrenCount),
 * otherwise it would strand them before their results arrive.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { createActivityRecorder } from "./activity.ts";

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

	pi.on("session_start", (_event, ctx) => {
		recorder.sessionStart();
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

	pi.on("agent_start", () => {
		recorder.agentStart();
	});

	pi.on("tool_execution_start", (event) => {
		recorder.toolExecutionStart(event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_end", () => {
		recorder.toolExecutionEnd();
	});

	pi.on("agent_end", (event, ctx) => {
		const messages = (event as { messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string }> }).messages;

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
