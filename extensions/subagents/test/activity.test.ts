import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActivityRecorder, readActivityState } from "../activity.ts";

function tmpActivityFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-act-"));
	return join(dir, "activity", "a1.json");
}

test("recorder: phase transitions land on disk immediately", () => {
	const file = tmpActivityFile();
	const rec = createActivityRecorder({ runningChildId: "c1", activityFile: file, throttleMs: 0 });

	rec.sessionStart();
	assert.ok(existsSync(file), "sessionStart must write synchronously");
	const started = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(started.phase, "starting");
	assert.equal(started.runningChildId, "c1");

	rec.agentStart();
	const active = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(active.phase, "active");
	assert.equal(active.agentActive, true);
	assert.ok(active.activeSince > 0);

	rec.toolExecutionStart("t1", "bash");
	const tooling = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(tooling.toolActive, true);
	assert.equal(tooling.toolName, "bash");

	rec.toolExecutionEnd();
	rec.agentEndWaiting();
	const waiting = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(waiting.phase, "waiting");
	assert.equal(waiting.toolActive, false);
	assert.ok(waiting.waitingSince > 0);

	rec.agentEndDone();
	const done = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(done.phase, "done");

	rmSync(join(file, "..", ".."), { recursive: true, force: true });
});

test("recorder: throttles intermediate writes (sequence still bumps)", () => {
	const file = tmpActivityFile();
	const rec = createActivityRecorder({ runningChildId: "c1", activityFile: file, throttleMs: 60_000 });
	rec.sessionStart();
	const first = JSON.parse(readFileSync(file, "utf8"));
	rec.toolExecutionStart("t1", "grep");
	rec.toolExecutionEnd("t1");
	// Throttled: disk still shows the last flushed state, but the in-memory
	// sequence advanced — verify via a forced flush.
	rec.agentEndWaiting();
	const latest = JSON.parse(readFileSync(file, "utf8"));
	assert.ok(latest.sequence > first.sequence);
	rmSync(join(file, "..", ".."), { recursive: true, force: true });
});

test("readActivityState: missing/invalid/wrong-id reasons", () => {
	const file = tmpActivityFile();
	assert.equal(readActivityState(file, "c1").reason, "missing");

	const rec = createActivityRecorder({ runningChildId: "c1", activityFile: file });
	rec.sessionStart();
	const ok = readActivityState(file, "c1");
	assert.equal(ok.ok, true);
	if (ok.ok) assert.equal(ok.state.runningChildId, "c1");

	assert.equal(readActivityState(file, "c2").reason, "wrong-id");

	writeFileSync(file, "not json", "utf8");
	assert.equal(readActivityState(file, "c1").reason, "invalid");

	rmSync(join(file, "..", ".."), { recursive: true, force: true });
});

test("recorder: no-op without child identity (normal session)", () => {
	// A broken recorder would write a ".tmp" file into the cwd via an empty path.
	const cwdBefore = existsSync(".tmp");
	const rec = createActivityRecorder({ runningChildId: "", activityFile: "" });
	rec.sessionStart();
	rec.agentStart();
	rec.toolExecutionStart("t", "bash");
	rec.toolExecutionEnd();
	rec.agentEndWaiting();
	rec.agentEndDone();
	assert.equal(existsSync(".tmp"), cwdBefore, "no-op recorder must not touch the filesystem");
});
