// Manual E2E with a REAL pi child (not part of npm test: opens a pane, spends a few cents).
// Regression: multi-line identity used to be passed inline and pi.cmd truncated
// the command line at the first newline — the child sat in an empty TUI with no
// task and no session file. Identity now goes through a file.
// Run: node extensions/subagents/test/e2e-pi.manual.ts
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { renderLauncherPs1 } from "../launcher.ts";
import { createSubagentPane, listPaneIds, readScreenTail, parseSentinel } from "../wezterm.ts";
import { summarizeSessionFile } from "../session-read.ts";

const where = execFileSync("where.exe", ["pi"], { encoding: "utf8" });
const piPath = where.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith("pi.cmd")) ?? "";
if (!piPath) {
	console.error("pi.cmd not found");
	process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "pi-subagents-pi-"));
const agentDir = join(dir, "agent");
const sessionFile = join(agentDir, "sessions", "subagents", "e2e-child.jsonl");
mkdirSync(dirname(sessionFile), { recursive: true });
const taskFile = join(dir, "task.md");
writeFileSync(taskFile, "Reply with exactly one line: E2E_OK_42. Then stop.", "utf8");

// Multi-line identity — the exact shape that used to break pi.cmd.
const identityFile = join(dir, "identity.md");
writeFileSync(
	identityFile,
	[
		"You are a test subagent with a deliberately multi-line identity.",
		"",
		"Follow these principles:",
		"- Follow the task literally",
		"- Never improvise beyond the task",
		"",
		"When unsure, still follow the task literally.",
	].join("\n"),
	"utf8",
);
const doneExt = "D:/Projects/pi-extensions/extensions/subagents/subagent-done.ts";

const spec = {
	name: "pi-e2e",
	id: "pie2e-001",
	piPath,
	sessionFile,
	extensionPaths: [doneExt],
	noExtensions: false,
	taskFile,
	doneFile: `${sessionFile}.done`,
	activityFile: join(dir, "activity.json"),
	appendSystemPromptFile: identityFile,
	cwd: dir,
	env: {
		PI_SUBAGENT_NAME: "pi-e2e",
		PI_SUBAGENT_AGENT: "adhoc",
		PI_SUBAGENT_AUTO_EXIT: "1",
		PI_SUBAGENT_ID: "pie2e-001",
		PI_SUBAGENT_SESSION: sessionFile,
		PI_SUBAGENT_ACTIVITY_FILE: join(dir, "activity.json"),
	},
} as never;
const scriptPath = join(dir, "launcher.ps1");
writeFileSync(scriptPath, renderLauncherPs1(spec), "utf8");

// Guard: the invocation line must have balanced single quotes (no inline newlines).
const invocationLine = readFileSync(scriptPath, "utf8")
	.split("\r\n")
	.find((l) => l.startsWith("& "));
if (!invocationLine || ((invocationLine.match(/'/g) ?? []).length) % 2 !== 0) {
	console.error("INVOCATION LINE BROKEN:", invocationLine);
	process.exit(1);
}

const pane = createSubagentPane({ ps1Path: scriptPath, cwd: dir, runningCount: 0 });
console.log("pane:", pane);

let exitCode: number | null = null;
const t0 = Date.now();
for (let i = 0; i < 240; i++) {
	await new Promise((r) => setTimeout(r, 500));
	if (existsSync(`${sessionFile}.done`)) {
		exitCode = Number.parseInt(readFileSync(`${sessionFile}.done`, "utf8").trim(), 10) || 0;
		break;
	}
	if (existsSync(`${sessionFile}.exit`)) {
		console.log("EXIT SIDECAR:", readFileSync(`${sessionFile}.exit`, "utf8"));
		exitCode = 1;
		break;
	}
	const s = parseSentinel(readScreenTail(pane, 4));
	if (s !== null) {
		exitCode = s;
		break;
	}
}
console.log("exitCode:", exitCode, "| elapsed:", Math.round((Date.now() - t0) / 1000) + "s");

if (existsSync(sessionFile)) {
	const { summary, usage, model } = summarizeSessionFile(sessionFile, "none");
	console.log("summary:", summary.slice(0, 200));
	console.log("model:", model, "| usage:", usage ? `${usage.input} in / ${usage.output} out` : "none");
	console.log("contains E2E_OK_42:", summary.includes("E2E_OK_42"));
} else {
	console.log("NO SESSION FILE");
}

execSync(`wezterm cli kill-pane --pane-id ${pane}`).toString();
console.log("pane cleaned:", !listPaneIds().has(pane));
const ok = exitCode === 0 && existsSync(sessionFile);
rmSync(dir, { recursive: true, force: true });
console.log(ok ? "E2E PI OK" : "E2E PI FAILED");
process.exit(ok ? 0 : 1);
