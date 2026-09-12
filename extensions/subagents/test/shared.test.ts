import assert from "node:assert/strict";
import { test } from "node:test";
import { cancelSidecarPath, classifyExitSidecar, resolveInterrupt } from "../shared.ts";

test("cancelSidecarPath: appends .cancel to the session file", () => {
	assert.equal(cancelSidecarPath("/tmp/sessions/2025-01-01_scout-abc.jsonl"), "/tmp/sessions/2025-01-01_scout-abc.jsonl.cancel");
	assert.equal(cancelSidecarPath("s.jsonl"), "s.jsonl.cancel");
});

// Truth table for subagent_message's interrupt param: explicit wins,
// undefined → auto-interrupt stalled agents only.
test("resolveInterrupt: explicit true/false wins", () => {
	assert.equal(resolveInterrupt(true, false), true);
	assert.equal(resolveInterrupt(true, true), true);
	assert.equal(resolveInterrupt(false, true), false);
	assert.equal(resolveInterrupt(false, false), false);
});

test("resolveInterrupt: undefined → auto-interrupt stalled agents only", () => {
	assert.equal(resolveInterrupt(undefined, true), true);
	assert.equal(resolveInterrupt(undefined, false), false);
});

// ── classifyExitSidecar — the pollTick exit-sidecar verdict ──

test("classifyExitSidecar: cancelled type", () => {
	assert.deepEqual(classifyExitSidecar('{"type":"cancelled"}'), { kind: "cancelled" });
});

test("classifyExitSidecar: error with message", () => {
	assert.deepEqual(classifyExitSidecar('{"errorMessage":"boom"}'), { kind: "error", errorMessage: "boom" });
	// Real child-ext shape (subagent-done.ts writes type:"error").
	assert.deepEqual(classifyExitSidecar('{"type":"error","errorMessage":"API 500"}'), {
		kind: "error",
		errorMessage: "API 500",
	});
});

test("classifyExitSidecar: empty or missing errorMessage → unknown", () => {
	// Empty string means unknown per spec — the caller falls back to its
	// generic error text, same as the old truthiness check.
	assert.deepEqual(classifyExitSidecar('{"errorMessage":""}'), { kind: "unknown" });
	assert.deepEqual(classifyExitSidecar("{}"), { kind: "unknown" });
});

test("classifyExitSidecar: garbage input → unknown", () => {
	assert.deepEqual(classifyExitSidecar("not json at all"), { kind: "unknown" });
	assert.deepEqual(classifyExitSidecar('"just a string"'), { kind: "unknown" });
	assert.deepEqual(classifyExitSidecar('[1,2]'), { kind: "unknown" });
});

test("classifyExitSidecar: empty string → unknown", () => {
	assert.deepEqual(classifyExitSidecar(""), { kind: "unknown" });
});
