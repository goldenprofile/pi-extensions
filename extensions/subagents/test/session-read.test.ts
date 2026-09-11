import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatUsage, summarizeSessionFile } from "../session-read.ts";

function writeSession(entries: unknown[]): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagents-read-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
	return file;
}

function cleanup(file: string): void {
	rmSync(join(file, ".."), { recursive: true, force: true });
}

test("summarizeSessionFile: last assistant text, usage totals, model", () => {
	const file = writeSession([
		{ type: "session", version: 3, id: "s1" },
		{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "go" }] } },
		{
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				model: "glm-5.3-flash",
				content: [{ type: "text", text: "intermediate" }],
				usage: { input: 1000, output: 100, cost: { total: 0.001 } },
			},
		},
		{ type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "more" }] } },
		{
			type: "message",
			id: "a2",
			message: {
				role: "assistant",
				model: "glm-5.3-flash",
				content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "## Done\nAll set." }],
				usage: { input: 2000, output: 50, cost: { total: 0.002 } },
			},
		},
	]);
	try {
		const result = summarizeSessionFile(file, "fallback");
		assert.equal(result.summary, "## Done\nAll set.");
		assert.equal(result.model, "glm-5.3-flash");
		assert.deepEqual(result.usage, { input: 3000, output: 150, cost: 0.003 });
	} finally {
		cleanup(file);
	}
});

test("summarizeSessionFile: error turn wins over fallback, not over text", () => {
	const file = writeSession([
		{
			type: "message",
			id: "a1",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial answer" }],
				stopReason: "error",
				errorMessage: "provider overloaded",
			},
		},
	]);
	try {
		const result = summarizeSessionFile(file, "fallback");
		assert.equal(result.summary, "partial answer");
	} finally {
		cleanup(file);
	}
});

test("summarizeSessionFile: error without text reports the error", () => {
	const file = writeSession([
		{
			type: "message",
			id: "a1",
			message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
		},
	]);
	try {
		const result = summarizeSessionFile(file, "fallback");
		assert.equal(result.summary, "Subagent error: boom");
	} finally {
		cleanup(file);
	}
});

test("summarizeSessionFile: missing file → fallback", () => {
	const result = summarizeSessionFile(join(tmpdir(), "no-such", "x.jsonl"), "fallback");
	assert.equal(result.summary, "fallback");
	assert.equal(result.usage, null);
	assert.equal(result.model, null);
});

test("formatUsage: compact rendering", () => {
	assert.equal(formatUsage({ input: 12300, output: 4500, cost: 0.0123 }), "12.3k in / 4.5k out / $0.0123");
	assert.equal(formatUsage({ input: 120, output: 30, cost: 0 }), "120 in / 30 out");
});
