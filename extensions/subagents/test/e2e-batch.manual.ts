// Manual E2E for task_batch's headless runner with a REAL pi child.
// Run: node extensions/subagents/test/e2e-batch.manual.ts
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { finalOutput, runHeadlessChild } from "../batch.ts";

const where = execFileSync("where.exe", ["pi"], { encoding: "utf8" });
const piPath = where.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith("pi.cmd")) ?? "";
if (!piPath) {
	console.error("pi.cmd not found");
	process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "pi-batch-e2e-"));
const t0 = Date.now();
const result = await runHeadlessChild({
	agentName: "e2e",
	agentLabel: "e2e-headless",
	task: "Reply with exactly one line: HEADLESS_OK_7. Then stop.",
	cwd: dir,
	defaultCwd: dir,
	sessionsRoot: join(dir, "sessions"),
	appendSystemPrompt: "You are a test subagent. Follow the task literally.",
	denyTools: ["subagent", "subagent_message", "subagents_list"],
	piPath,
});
const elapsed = Date.now() - t0;
console.log("exitCode:", result.exitCode, "| elapsed:", elapsed + "ms");
console.log("output:", finalOutput(result.messages));
console.log("model:", result.model, "| usage:", `${result.usage.input} in / ${result.usage.output} out / $${result.usage.cost.toFixed(4)}`);
console.log("session:", result.sessionFile, "| exists:", result.sessionFile ? existsSync(result.sessionFile) : false);
if (result.stderr.trim()) console.log("stderr:", result.stderr.trim().slice(0, 300));
const ok = result.exitCode === 0 && finalOutput(result.messages).includes("HEADLESS_OK_7");
rmSync(dir, { recursive: true, force: true });
console.log(ok ? "E2E BATCH OK" : "E2E BATCH FAILED");
process.exit(ok ? 0 : 1);
