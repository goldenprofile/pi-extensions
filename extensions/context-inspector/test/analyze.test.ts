import assert from "node:assert/strict";
import { test } from "node:test";
import {
	analyzeEntries,
	analyzePayload,
	analyzeSystemPrompt,
	analyzeTools,
	analyzeUsage,
	compactionInfo,
	estimateText,
	type Snapshot,
} from "../analyze.ts";
import { bar, fmtTokens, renderReport, summaryLine } from "../report.ts";

const textEstimate = (message: unknown) => {
	const m = message as { content?: unknown };
	const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
	return estimateText(text);
};

test("estimateText is chars/4 rounded up", () => {
	assert.equal(estimateText(""), 0);
	assert.equal(estimateText("abcd"), 1);
	assert.equal(estimateText("abcde"), 2);
});

test("analyzeSystemPrompt splits known parts and leaves the rest as base prompt", () => {
	const agents = "# AGENTS\n".repeat(50);
	const prompt = `BASE${agents}snippet-a snippet-b`;
	const result = analyzeSystemPrompt(prompt, {
		cwd: "C:/proj",
		contextFiles: [{ path: "C:/proj/AGENTS.md", content: agents }],
		selectedTools: ["a"],
		toolSnippets: { a: "snippet-a", b: "snippet-b" },
	});
	assert.equal(result.totalChars, prompt.length);
	const labels = result.parts.map((p) => p.label);
	assert.deepEqual(labels, ["base prompt", "./AGENTS.md", "tool snippets (1)"]);
	const agentsPart = result.parts.find((p) => p.label === "./AGENTS.md");
	assert.equal(agentsPart?.chars, agents.length);
	assert.equal(agentsPart?.detail, "C:/proj/AGENTS.md");
	const sum = result.parts.reduce((s, p) => s + p.chars, 0);
	assert.equal(sum, prompt.length);
});

test("analyzeSystemPrompt measures the real <available_skills> block when present", () => {
	const block = `<available_skills>\n${"<skill>x</skill>\n".repeat(20)}</available_skills>`;
	const prompt = `BASE\n${block}\nCurrent working directory: /p`;
	const skill = { name: "a", description: "b", filePath: "/p/a/SKILL.md", baseDir: "/p/a", sourceInfo: {}, disableModelInvocation: false };
	const result = analyzeSystemPrompt(prompt, { cwd: "/p", skills: [skill] as never });
	const part = result.parts.find((p) => p.label === "skills (1)");
	assert.equal(part?.chars, block.length);
	const heuristic = analyzeSystemPrompt("no block here", { cwd: "/p", skills: [skill] as never });
	assert.equal(heuristic.parts.find((p) => p.label === "skills (1)")?.chars, 1 + 1 + "/p/a/SKILL.md".length + 60);
});

test("analyzeSystemPrompt without options reports everything as base prompt", () => {
	const result = analyzeSystemPrompt("hello world", undefined);
	assert.equal(result.parts.length, 1);
	assert.equal(result.parts[0].chars, 11);
});

test("analyzeTools sorts active first and sums only active tokens", () => {
	const result = analyzeTools(
		[
			{ name: "small", description: "s", parameters: {} },
			{ name: "big", description: "x".repeat(400), parameters: { type: "object" } },
			{ name: "inactive", description: "y".repeat(800), parameters: {} },
		],
		["small", "big"],
	);
	assert.equal(result.activeCount, 2);
	assert.equal(result.totalCount, 3);
	assert.deepEqual(
		result.items.map((t) => t.name),
		["big", "small", "inactive"],
	);
	const activeSum = result.items.filter((t) => t.active).reduce((s, t) => s + t.tokens, 0);
	assert.equal(result.activeTokens, activeSum);
});

test("analyzeEntries groups by role and tool, finds largest, tracks compaction", () => {
	const entries = [
		{ type: "compaction", id: "c1", summary: "s".repeat(400), tokensBefore: 50_000, firstKeptEntryId: "m2" },
		{ type: "message", id: "m1", message: { role: "user", content: "hi", timestamp: 0 } },
		{
			type: "message",
			id: "m2",
			message: {
				role: "toolResult",
				toolName: "read",
				toolCallId: "t1",
				content: [{ type: "text", text: "r".repeat(4000) }],
				timestamp: 0,
			},
		},
		{
			type: "message",
			id: "m3",
			message: { role: "toolResult", toolName: "bash", toolCallId: "t2", content: [{ type: "text", text: "b".repeat(800) }], timestamp: 0 },
		},
		{ type: "message", id: "m4", message: { role: "custom", customType: "plan", content: "plan text", display: true, timestamp: 0 } },
		{ type: "model_change", id: "x", provider: "p", modelId: "m" },
	];
	const result = analyzeEntries(entries as never, textEstimate, { largest: 2 });
	assert.equal(result.count, 5);
	assert.equal(result.compaction?.summaryTokens, 100);
	assert.equal(result.compaction?.tokensBefore, 50_000);
	assert.equal(result.byRole.toolResult.count, 2);
	assert.equal(result.byTool.read.count, 1);
	assert.ok(result.byTool.read.tokens > result.byTool.bash.tokens);
	assert.ok("custom:plan" in result.byRole);
	assert.equal(result.largest.length, 2);
	assert.equal(result.largest[0].entryId, "m2");
	assert.equal(result.largest[0].toolName, "read");
	assert.ok(result.largest[0].preview.endsWith("…"));
});

test("analyzeEntries falls back to text estimate when estimator throws or returns 0", () => {
	const entries = [{ type: "message", id: "m1", message: { role: "user", content: "x".repeat(40), timestamp: 0 } }];
	const throwing = analyzeEntries(entries as never, () => {
		throw new Error("boom");
	});
	assert.equal(throwing.totalTokens, 10);
	const zero = analyzeEntries(entries as never, () => 0);
	assert.equal(zero.totalTokens, 10);
});

test("analyzePayload detects anthropic shape", () => {
	const stats = analyzePayload(
		{
			model: "claude",
			system: [{ type: "text", text: "S".repeat(400) }],
			tools: [{ name: "read", input_schema: {} }, { name: "bash", input_schema: {} }],
			messages: [{ role: "user", content: "hi" }],
		},
		123,
	);
	assert.equal(stats.shape, "anthropic-messages");
	assert.equal(stats.at, 123);
	assert.equal(stats.toolCount, 2);
	assert.equal(stats.messageCount, 1);
	assert.ok((stats.systemTokens ?? 0) >= 100);
	assert.ok(stats.bytes > 0);
});

test("analyzePayload detects openai completions system message and excludes it from messages", () => {
	const stats = analyzePayload({
		model: "gpt",
		messages: [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
		],
	});
	assert.equal(stats.shape, "openai-completions");
	assert.equal(stats.messageCount, 1);
	assert.ok((stats.systemTokens ?? 0) > 0);
});

test("analyzePayload detects openai responses and google shapes", () => {
	assert.equal(analyzePayload({ instructions: "x", input: [] }).shape, "openai-responses");
	assert.equal(analyzePayload({ systemInstruction: { parts: [] }, contents: [] }).shape, "google-generative-ai");
	assert.equal(analyzePayload("not an object").shape, "unknown");
});

test("analyzeUsage computes prompt tokens and cache percent", () => {
	const u = analyzeUsage({ input: 1000, output: 200, cacheRead: 9000, cacheWrite: 0, cost: { total: 0.01 } });
	assert.equal(u.promptTokens, 10_000);
	assert.equal(u.cachePercent, 90);
	assert.equal(u.costTotal, 0.01);
	assert.equal(analyzeUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }).cachePercent, null);
});

test("compactionInfo applies defaults and threshold", () => {
	const c = compactionInfo(200_000);
	assert.equal(c.reserveTokens, 16384);
	assert.equal(c.compactAt, 200_000 - 16384);
	assert.equal(compactionInfo(100, { reserveTokens: 500 }).compactAt, 0);
	assert.equal(compactionInfo(1000, { enabled: false }).enabled, false);
});

test("report helpers and full render do not throw and respect width", () => {
	assert.equal(fmtTokens(999), "999");
	assert.equal(fmtTokens(1234), "1.23K");
	assert.equal(fmtTokens(42_100), "42.1K");
	assert.equal(fmtTokens(2_500_000), "2.50M");
	assert.equal(fmtTokens(null), "?");
	assert.equal(bar(0.5, 10), "█████░░░░░");
	assert.equal(bar(2, 4), "████");

	const snapshot: Snapshot = {
		at: 0,
		model: { provider: "zai", id: "glm-5.3-flash", contextWindow: 200_000, maxTokens: 8192 },
		occupancy: { tokens: 42_100, contextWindow: 200_000, percent: 21 },
		compaction: compactionInfo(200_000),
		system: analyzeSystemPrompt("base", undefined),
		tools: analyzeTools([{ name: "read", description: "d", parameters: {} }], ["read"]),
		messages: analyzeEntries([], textEstimate),
		lastUsage: analyzeUsage({ input: 100, output: 10, cacheRead: 900, cacheWrite: 0 }),
		lastRequest: analyzePayload({ system: "s", messages: [], tools: [] }, 0),
	};
	const lines = renderReport(snapshot, 100);
	assert.ok(lines.length > 10);
	assert.ok(lines.some((l) => l.includes("Occupancy")));
	assert.ok(lines.some((l) => l.includes("90% cached")));
	const summary = summaryLine(snapshot);
	assert.ok(summary.startsWith("ctx 42.1K/200.0K 21%"));
	assert.ok(summary.includes("cache 90%"));
});
