import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtDur, fmtK, fmtMoney, GraphModel, oneLine } from "../session.ts";

const iso = (h: number, s = 0) => `2026-09-05T12:0${h}:0${String(s).padStart(2, "0")}.000Z`;

function feed(model: GraphModel, entries: unknown[]): GraphModel {
	for (const e of entries) model.feedEntry(e);
	return model;
}

function sessionEntries(): unknown[] {
	return [
		{ type: "session", version: 3, id: "s1", timestamp: iso(0), cwd: "C:\\Proj\\alpha" },
		{ type: "session_info", id: "n1", timestamp: iso(0, 1), name: "Auth fix" },
		{ type: "model_change", id: "a", timestamp: iso(0, 2), provider: "zai", modelId: "glm-5.3" },
		{ type: "thinking_level_change", id: "t", timestamp: iso(0, 3), thinkingLevel: "high" },
		{
			type: "message",
			id: "u1",
			timestamp: iso(1),
			message: { role: "user", content: [{ type: "text", text: "  fix   the bug  " }] },
		},
		{
			type: "message",
			id: "m1",
			timestamp: iso(1, 5),
			message: {
				role: "assistant",
				model: "glm-5.3",
				usage: { input: 1000, output: 50, cost: { total: 0.01 } },
				stopReason: "toolUse",
				content: [
					{ type: "thinking", thinking: `${"подумал ".repeat(30)}` },
					{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/auth.ts" } },
					{ type: "text", text: "Читаю файл" },
				],
			},
		},
		{
			type: "message",
			id: "t1",
			timestamp: iso(1, 9),
			message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false },
		},
		{
			type: "message",
			id: "m2",
			timestamp: iso(2),
			message: {
				role: "assistant",
				model: "glm-5.3",
				usage: { input: 200, output: 40, cost: { total: 0.02 } },
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "src/auth.ts" } }],
			},
		},
		{
			type: "message",
			id: "t2",
			timestamp: iso(2, 4),
			message: { role: "toolResult", toolCallId: "c2", toolName: "edit", content: [{ type: "text", text: "not found" }], isError: true },
		},
		{
			type: "message",
			id: "b1",
			timestamp: iso(2, 6),
			message: { role: "bashExecution", command: "npm test", exitCode: 1 },
		},
		{ type: "compaction", id: "k1", timestamp: iso(2, 8), summary: "s", tokensBefore: 3000 },
		{ type: "branch_summary", id: "br1", timestamp: iso(2, 9), summary: "Итог ветки" },
		{ type: "label", id: "l1", timestamp: iso(3), label: "важно" },
		{
			type: "custom",
			id: "ch1",
			timestamp: iso(3, 1),
			customType: "session-trace:subagents",
			data: { agent: "scout", task: "поищи в коде", session: "C:\\s\\child.jsonl", usage: { output: 700, cost: 0.005 }, model: "glm-5.2" },
		},
	];
}

test("GraphModel builds turns, chips, user/bash items and markers from entries", () => {
	const m = feed(new GraphModel(), sessionEntries());
	assert.equal(m.cwd, "C:\\Proj\\alpha");
	assert.equal(m.sessionName, "Auth fix");

	const kinds = m.items.map((i) => i.kind);
	assert.deepEqual(kinds.filter((k, i) => k === "turn"), ["turn", "turn"]);
	assert.ok(kinds.includes("user"));
	assert.ok(kinds.includes("bash"));
	assert.ok(kinds.includes("child"));

	// Маркеры: model_change, thinking, compaction, branch_summary, label
	const markers = m.items.filter((i): i is Extract<(typeof m.items)[number], { kind: "marker" }> => i.kind === "marker");
	assert.deepEqual(
		markers.map((x) => x.icon),
		["⚙", "✦", "↻", "⑂", "⚑"],
	);

	// Первый ход: чип read → ok, thinking и текст обрезаны до одной строки
	const t1 = m.items.find((i) => i.kind === "turn" && i.index === 1)!;
	assert.equal(t1.model, "glm-5.3");
	assert.equal(t1.tokensOut, 50);
	assert.equal(t1.chips.length, 1);
	assert.equal(t1.chips[0].status, "ok");
	assert.equal(t1.chips[0].name, "read");
	assert.ok(t1.chips[0].endMs !== undefined);
	assert.ok((t1.thinking ?? "").length <= 96);
	assert.equal(t1.text, "Читаю файл");

	// Второй ход: чип edit → error; bash с ненулевым exitCode
	const t2 = m.items.find((i) => i.kind === "turn" && i.index === 2)!;
	assert.equal(t2.chips[0].status, "error");
	const bash = m.items.find((i) => i.kind === "bash")!;
	assert.equal(bash.exitCode, 1);

	// Дочерняя карточка субагента
	const child = m.items.find((i): i is Extract<(typeof m.items)[number], { kind: "child" }> => i.kind === "child")!;
	assert.equal(child.agent, "scout");
	assert.equal(child.session, "C:\\s\\child.jsonl");
	assert.equal(child.tokensOut, 700);
});

test("GraphModel aggregates totals and per-model stats", () => {
	const m = feed(new GraphModel(), sessionEntries());
	assert.equal(m.totals.input, 1200);
	assert.equal(m.totals.output, 90);
	assert.ok(Math.abs(m.totals.cost - 0.03) < 1e-9);
	const agg = m.models.get("glm-5.3")!;
	assert.equal(agg.turns, 2);
	assert.equal(agg.output, 90);
	const child = m.items.find((i) => i.kind === "child")!;
	assert.ok(child);
	// version растёт с каждой записью (инвалидация кэша рендера)
	assert.ok(m.version >= sessionEntries().length);
});

test("child links are accepted under the legacy pitrace:subagents type too", () => {
	const m = feed(new GraphModel(), [
		{
			type: "custom",
			id: "ch1",
			timestamp: iso(1),
			customType: "pitrace:subagents",
			data: { agent: "scout", task: "legacy", session: "C:\\s\\old.jsonl" },
		},
	]);
	const child = m.items.find((i): i is Extract<(typeof m.items)[number], { kind: "child" }> => i.kind === "child");
	assert.ok(child);
	assert.equal(child.session, "C:\\s\\old.jsonl");
	// прочие custom-записи по-прежнему игнорируются
	assert.equal(feed(new GraphModel(), [{ type: "custom", id: "x", customType: "other:thing", data: { session: "y" } }]).items.length, 0);
});

test("GraphModel tolerates broken and unknown entries", () => {
	const m = new GraphModel();
	for (const e of [null, "str", {}, { type: "unknown" }, { type: "message" }, { type: "message", message: {} }]) {
		m.feedEntry(e);
	}
	assert.equal(m.items.length, 0);
	// toolResult без известного toolCallId не создаёт мусора
	m.feedEntry({ type: "message", timestamp: iso(1), message: { role: "toolResult", toolCallId: "nope", content: [] } });
	assert.equal(m.items.length, 0);
});

test("formatting helpers", () => {
	assert.equal(fmtK(999), "999");
	assert.equal(fmtK(1500), "1.5k");
	assert.equal(fmtK(2_000_000), "2.0M");
	assert.equal(fmtK(0), "0");
	assert.equal(fmtDur(500), "500ms");
	assert.equal(fmtDur(1500), "1.5s");
	assert.equal(fmtDur(65_000), "1m5s");
	assert.equal(fmtDur(undefined), "");
	assert.equal(fmtMoney(0), "");
	assert.equal(fmtMoney(0.004), "$0.0040");
	assert.equal(fmtMoney(1.5), "$1.50");
	assert.equal(oneLine("a\n  b".repeat(50), 10).length, 10);
	assert.ok(oneLine("a\n  b".repeat(50), 10).endsWith("…"));
});
