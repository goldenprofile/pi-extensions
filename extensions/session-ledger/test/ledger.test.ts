import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLedger, cachePercent, dayOf, groupRows, inPeriod, parseArgs, parseSessionText, periodStart, projectName, topSessions } from "../ledger.ts";
import { fmtCost, fmtTokens, renderLedger, renderTable, summaryLine } from "../report.ts";

const usage = (input: number, output: number, cacheRead = 0, cost = 0.01) => ({
	input,
	output,
	cacheRead,
	cacheWrite: 0,
	totalTokens: input + output + cacheRead,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

function sessionText(opts: { cwd?: string; start?: string; model?: string } = {}): string {
	const start = opts.start ?? "2026-09-05T12:00:00.000Z";
	const model = opts.model ?? "glm-5.3-flash";
	const lines = [
		{ type: "session", version: 3, id: "s1", timestamp: start, cwd: opts.cwd ?? "C:\\Proj\\alpha" },
		{ type: "model_change", id: "a", parentId: null, timestamp: start, provider: "zai", modelId: model },
		{ type: "message", id: "u1", parentId: "a", timestamp: start, message: { role: "user", content: [{ type: "text", text: "  fix   the bug in auth  " }] } },
		{
			type: "message",
			id: "m1",
			parentId: "u1",
			timestamp: "2026-09-05T12:00:05.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
				provider: "zai",
				model,
				usage: usage(1000, 50, 0, 0.01),
				stopReason: "toolUse",
			},
		},
		{ type: "message", id: "t1", parentId: "m1", timestamp: "2026-09-05T12:00:06.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "x" }], isError: false } },
		{
			type: "message",
			id: "m2",
			parentId: "t1",
			timestamp: "2026-09-05T12:00:10.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c2", name: "edit", arguments: {} }],
				provider: "zai",
				model,
				usage: usage(200, 40, 1800, 0.02),
				stopReason: "toolUse",
			},
		},
		{ type: "message", id: "t2", parentId: "m2", timestamp: "2026-09-05T12:00:11.000Z", message: { role: "toolResult", toolCallId: "c2", toolName: "edit", content: [{ type: "text", text: "oldText not found" }], isError: true } },
		{ type: "compaction", id: "k1", parentId: "t2", timestamp: "2026-09-05T12:00:12.000Z", summary: "s", firstKeptEntryId: "m2", tokensBefore: 3000, usage: usage(500, 100, 0, 0.005) },
		{ type: "branch_summary", id: "b1", parentId: "k1", timestamp: "2026-09-05T12:00:13.000Z", fromId: "u1", summary: "branch", usage: usage(300, 20, 0, 0.002) },
		{
			type: "message",
			id: "m3",
			parentId: "k1",
			timestamp: "2026-09-06T01:00:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "done" }], provider: "zai", model, usage: usage(100, 10, 0, 0.001), stopReason: "error", errorMessage: "boom" },
		},
		{ type: "session_info", id: "n1", parentId: "m3", timestamp: "2026-09-06T01:00:01.000Z", name: "Auth fix" },
	];
	return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

test("parseSessionText aggregates tokens, cost, tools, compactions and errors", () => {
	const s = parseSessionText(sessionText(), "/x/s1.jsonl");
	assert.ok(s);
	assert.equal(s.project, "alpha");
	assert.equal(s.name, "Auth fix");
	assert.equal(s.firstPrompt, "fix the bug in auth");
	assert.equal(s.userMessages, 1);
	assert.equal(s.stats.turns, 3);
	assert.equal(s.stats.input, 1000 + 200 + 500 + 300 + 100);
	assert.equal(s.stats.cacheRead, 1800);
	assert.equal(s.stats.output, 50 + 40 + 100 + 20 + 10);
	assert.ok(Math.abs(s.stats.cost - 0.038) < 1e-9);
	assert.equal(s.stats.toolCalls, 2);
	assert.equal(s.stats.toolErrors, 1);
	assert.equal(s.stats.compactions, 1);
	assert.equal(s.stats.branchSummaries, 1);
	assert.equal(s.stats.errors, 1);
	assert.deepEqual(s.byTool, { read: { calls: 1, errors: 0 }, edit: { calls: 1, errors: 1 } });
	assert.deepEqual(Object.keys(s.byModel), ["zai/glm-5.3-flash"]);
	assert.equal(s.byModel["zai/glm-5.3-flash"].turns, 3);
	assert.equal(s.byModel["zai/glm-5.3-flash"].toolErrors, 1);
	// Расход компакции и итога ветки приписан модели: разрез по моделям сходится с итогом сессии.
	assert.equal(s.byModel["zai/glm-5.3-flash"].input, s.stats.input);
	assert.equal(s.byModel["zai/glm-5.3-flash"].compactions, 1);
	assert.equal(s.byModel["zai/glm-5.3-flash"].branchSummaries, 1);
	assert.ok(Math.abs(s.byModel["zai/glm-5.3-flash"].cost - s.stats.cost) < 1e-9);
	assert.equal(Object.keys(s.byDay).length, 2);
	assert.equal(s.startedAt, Date.parse("2026-09-05T12:00:00.000Z"));
	assert.equal(s.endedAt, Date.parse("2026-09-06T01:00:01.000Z"));
});

test("parseSessionText rejects files without a session header and tolerates broken lines", () => {
	assert.equal(parseSessionText('{"type":"message"}\n', "/x"), undefined);
	assert.equal(parseSessionText("", "/x"), undefined);
	const s = parseSessionText(`${sessionText()}not json\n{"type":"message","id":"z"}\n`, "/x");
	assert.ok(s);
	assert.equal(s.stats.turns, 3);
});

test("cachePercent, projectName, dayOf, periods", () => {
	const s = parseSessionText(sessionText(), "/x")!;
	assert.equal(cachePercent(s.stats), 46.2);
	assert.equal(projectName("C:\\A\\B\\"), "B");
	assert.equal(projectName("/home/u/proj"), "proj");
	assert.equal(dayOf(0), "unknown");
	const now = Date.parse("2026-09-06T10:00:00.000Z");
	assert.equal(periodStart("all", now), 0);
	assert.equal(periodStart("7d", now), now - 7 * 86_400_000);
	assert.ok(periodStart("today", now) <= now);
	assert.ok(inPeriod(s, "7d", now));
	assert.ok(!inPeriod(s, "7d", now + 30 * 86_400_000));
	assert.ok(inPeriod(s, "all", now + 365 * 86_400_000));
});

test("buildLedger filters by period and project, groupRows groups correctly", () => {
	const now = Date.parse("2026-09-06T10:00:00.000Z");
	const a = parseSessionText(sessionText(), "/a")!;
	const b = parseSessionText(sessionText({ cwd: "/home/u/beta", start: "2026-07-01T00:00:00.000Z", model: "glm-5.2" }), "/b")!;
	// b заканчивается 2026-09-06 (последняя запись), поэтому попадает в 7d несмотря на старый старт
	const ledger = buildLedger([a, b], "7d", { now });
	assert.equal(ledger.sessions.length, 2);
	assert.equal(ledger.total.turns, 6);
	assert.equal(ledger.total.sessions, 2);

	const byProject = groupRows(ledger, "project");
	assert.deepEqual(byProject.map((r) => r.key).sort(), ["alpha", "beta"]);
	assert.equal(byProject[0].stats.sessions, 1);

	const byModel = groupRows(ledger, "model");
	assert.deepEqual(byModel.map((r) => r.key).sort(), ["zai/glm-5.2", "zai/glm-5.3-flash"]);

	const byDay = groupRows(ledger, "day");
	assert.deepEqual(
		byDay.map((r) => r.key),
		["2026-09-05", "2026-09-06"],
	);
	assert.equal(byDay[0].stats.sessions, 2);

	const byTool = groupRows(ledger, "tool");
	assert.equal(byTool[0].stats.toolCalls, 2);
	assert.equal(byTool.find((r) => r.key === "edit")?.stats.toolErrors, 2);

	const bySession = groupRows(ledger, "session");
	assert.equal(bySession.length, 2);
	assert.ok(bySession[0].detail === "Auth fix");

	const onlyBeta = buildLedger([a, b], "all", { now, project: "BETA" });
	assert.equal(onlyBeta.sessions.length, 1);
	assert.equal(topSessions(onlyBeta)[0].project, "beta");
});

test("report renders tables and summary without throwing", () => {
	const now = Date.parse("2026-09-06T10:00:00.000Z");
	const a = parseSessionText(sessionText(), "/a")!;
	const ledger = buildLedger([a], "30d", { now, scanned: 3, skipped: 1 });
	for (const by of ["project", "model", "day", "tool", "session"] as const) {
		const lines = renderLedger(ledger, by, 100);
		assert.ok(lines.length > 4, by);
		assert.ok(lines[0].includes(`by ${by}`));
		assert.ok(lines.some((l) => l.includes("1 unreadable")));
	}
	const empty = renderLedger(buildLedger([], "today", { now }), "project", 80);
	assert.ok(empty.some((l) => l.includes("No sessions")));
	const table = renderTable(groupRows(ledger, "project"), "project", ledger.total, 100, { fg: (_c, t) => t, bold: (t) => `*${t}*` });
	assert.ok(table.at(-1)?.startsWith("*total"));
	assert.equal(fmtTokens(1500), "1.50K");
	assert.equal(fmtCost(0), "$0");
	assert.equal(fmtCost(0.0042), "$0.0042");
	assert.equal(fmtCost(0.25), "$0.250");
	assert.equal(fmtCost(3.14159), "$3.14");
	assert.ok(summaryLine(ledger).startsWith("30d: $0.038"));
	const sessionView = renderLedger(ledger, "session", 100);
	assert.ok(sessionView.some((l) => l.includes("Auth fix")));
});

test("parseArgs accepts period, group and project in any order", () => {
	assert.deepEqual(parseArgs(""), { period: "7d", by: "project" });
	assert.deepEqual(parseArgs("model all"), { period: "all", by: "model" });
	assert.deepEqual(parseArgs("today tool"), { period: "today", by: "tool" });
	assert.deepEqual(parseArgs("mediahub 30d"), { period: "30d", by: "project", project: "mediahub" });
});
