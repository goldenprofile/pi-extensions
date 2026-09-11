// Manual E2E for the WezTerm surface (not part of npm test: opens real panes).
// Run: node extensions/subagents/test/e2e-surface.manual.ts
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { renderLauncherPs1 } from "../launcher.ts";
import { createSubagentPane, readScreenTail, parseSentinel, listPaneIds, runScriptInPane } from "../wezterm.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-subagents-e2e-"));
const doneFile = join(dir, "session.jsonl.done");
const taskFile = join(dir, "task.md");
writeFileSync(taskFile, "fake task", "utf8");

// Fake "pi": sleeps briefly, prints a summary, writes sidecars exactly like a real launcher.
const spec = {
	name: "e2e-test",
	id: "e2e-001",
	piPath: "pwsh",
	sessionFile: join(dir, "session.jsonl"),
	extensionPaths: [],
	noExtensions: false,
	taskFile,
	doneFile,
	env: { PI_SUBAGENT_NAME: "e2e-test" },
} as const;
const rendered = renderLauncherPs1({ ...spec, appendSystemPrompt: undefined, tools: undefined, excludeTools: undefined, model: undefined, thinking: undefined, cwd: dir } as never)
	.replace(/^& 'pwsh'.*$/m, [
		"Write-Host 'E2E_SUBAGENT_WORKING'",
		"Start-Sleep -Seconds 2",
		"Write-Host 'E2E_SUBAGENT_SUMMARY all good'",
		"$code = 0",
	].join("\r\n"));
const scriptPath = join(dir, "launcher.ps1");
writeFileSync(scriptPath, rendered, "utf8");

const t0 = Date.now();
const pane = createSubagentPane({ ps1Path: scriptPath, cwd: dir, runningCount: 0 });
console.log("pane:", pane);

let exitCode: number | null = null;
let viaSentinel = false;
for (let i = 0; i < 30; i++) {
	await new Promise((r) => setTimeout(r, 500));
	if (existsSync(doneFile)) {
		exitCode = Number.parseInt(readFileSync(doneFile, "utf8").trim(), 10) || 0;
		break;
	}
	const sentinel = parseSentinel(readScreenTail(pane, 4));
	if (sentinel !== null) { exitCode = sentinel; viaSentinel = true; break; }
}
const screen = readScreenTail(pane, 12);
console.log("exitCode:", exitCode, "| via:", viaSentinel ? "sentinel" : "done-file", "| elapsed:", Date.now() - t0 + "ms");
console.log("working marker visible:", screen.includes("E2E_SUBAGENT_WORKING"));
console.log("summary visible:", screen.includes("E2E_SUBAGENT_SUMMARY all good"));

// Parked pwsh prompt → resume path must work
const probeScript = join(dir, "probe.ps1");
writeFileSync(probeScript, "Write-Host 'E2E_RESUME_PROMPT_ALIVE'", "utf8");
runScriptInPane(pane, probeScript);
await new Promise((r) => setTimeout(r, 1500));
console.log("prompt alive for resume:", readScreenTail(pane, 6).includes("E2E_RESUME_PROMPT_ALIVE"));

execSync(`wezterm cli kill-pane --pane-id ${pane}`);
console.log("pane cleaned:", !listPaneIds().has(pane));
rmSync(dir, { recursive: true, force: true });
if (exitCode !== 0 || !screen.includes("E2E_SUBAGENT_SUMMARY all good")) {
	console.error("E2E FAILED");
	process.exit(1);
}
console.log("E2E SURFACE OK");
