// Manual E2E for the herdr surface (not part of npm test: opens real panes).
// Fake child — no pi, no tokens: the launcher just prints lines, writes a
// .done sidecar and the screen sentinel, then leaves the pane at a prompt.
// Run INSIDE herdr (HERDR_ENV=1):  node extensions/subagents/test/e2e-herdr.manual.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeBackend, createSubagentPane, listPaneIds, readScreenTail, sendText, closePane, parseSentinel } from "../mux.ts";

if (process.env.HERDR_ENV !== "1") {
	console.error("HERDR_ENV=1 required — run this from a pi/terminal session inside herdr.");
	process.exit(1);
}
console.log("backend:", activeBackend());

const dir = mkdtempSync(join(tmpdir(), "pi-subagents-herdr-"));
const ps1Path = join(dir, "launcher.ps1");
writeFileSync(
	ps1Path,
	[
		"param()",
		"Write-Output 'HERDR_E2E_HELLO'",
		"Start-Sleep -Milliseconds 300",
		"Set-Content -Path (Join-Path $PSScriptRoot 'child.done') -Value '0'",
		"Write-Output '__SUBAGENT_DONE_0__'",
		"",
	].join("\r\n"),
	"utf8",
);

const fail = (msg: string): never => {
	console.error("FAIL:", msg);
	process.exit(1);
};

// 1. Split + launch.
const paneId = createSubagentPane({ ps1Path, cwd: dir, runningCount: 0 });
if (!/^w\d+:p\d+$/.test(paneId)) fail(`unexpected pane id: ${paneId}`);
console.log("pane:", paneId);

// 2. Launcher output shows up.
const until = (needle: string, what: () => string, timeoutMs = 15_000): void => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (what().includes(needle)) return;
		const sleepUntil = Date.now() + 500;
		while (Date.now() < sleepUntil) {}
	}
	fail(`timeout waiting for "${needle}"`);
};
until("HERDR_E2E_HELLO", () => readScreenTail(paneId, 10));
console.log("launcher output: OK");

// 3. Steering: text + Enter reaches the pane's shell.
sendText(paneId, "echo STEER_OK_$((6 * 7))");
until("STEER_OK_", () => readScreenTail(paneId, 10));
console.log("steer: OK");

// 4. Sentinel parsing from the screen.
if (parseSentinel(readScreenTail(paneId, 8)) !== 0) fail("sentinel not parsed from screen");
console.log("sentinel: OK");

// 5. Liveness via pane list.
if (!listPaneIds().has(paneId)) fail("pane missing from pane list");
console.log("pane list: OK");

// 6. Close and confirm disappearance.
closePane(paneId);
const goneDeadline = Date.now() + 10_000;
while (Date.now() < goneDeadline && listPaneIds().has(paneId)) {
	const sleepUntil = Date.now() + 500;
	while (Date.now() < sleepUntil) {}
}
if (listPaneIds().has(paneId)) fail("pane still listed after close");
console.log("close: OK");

console.log("E2E_OK (herdr surface)");
