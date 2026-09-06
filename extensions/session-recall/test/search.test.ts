import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractUnits, highlight, type IndexCache, makeSnippet, parseQuery, refreshIndex, search } from "../search.ts";

function sessionText(opts: { cwd?: string; name?: string } = {}): string {
	const lines: unknown[] = [
		{ type: "session", version: 3, id: "s1", timestamp: "2026-09-05T12:00:00.000Z", cwd: opts.cwd ?? "C:\\Proj\\alpha" },
		{ type: "message", id: "u1", timestamp: "2026-09-05T12:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "How did we fix the WezTerm session plugin?" }] } },
		{
			type: "message",
			id: "a1",
			timestamp: "2026-09-05T12:00:02.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "secret thoughts about wezterm" },
					{ type: "text", text: "We patched resurrect.wezterm to store sessions." },
					{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "wezterm.lua", oldText: "old", newText: "new" } },
				],
			},
		},
		{ type: "message", id: "t1", timestamp: "2026-09-05T12:00:03.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "oldText not found in wezterm.lua" }], isError: true } },
		{ type: "message", id: "k1", timestamp: "2026-09-05T12:00:04.000Z", message: { role: "custom", customType: "plan", content: "Plan: migrate config" } },
		{ type: "compaction", id: "z1", timestamp: "2026-09-05T12:00:05.000Z", summary: "Summary: wezterm work done", firstKeptEntryId: "a1", tokensBefore: 10 },
	];
	if (opts.name) lines.push({ type: "session_info", id: "n1", timestamp: "2026-09-05T12:00:06.000Z", name: opts.name });
	return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

test("extractUnits builds one unit per message with roles, tools and session name", () => {
	const units = extractUnits(sessionText({ name: "WezTerm fix" }), "/x/s1.jsonl");
	assert.deepEqual(
		units.map((u) => u.role),
		["user", "assistant", "tool", "custom", "summary"],
	);
	assert.equal(units[0].project, "alpha");
	assert.equal(units[0].sessionName, "WezTerm fix");
	assert.ok(units[1].text.includes("→ edit"));
	assert.ok(!units[1].text.includes("secret thoughts"));
	assert.equal(units[2].tool, "edit");
	assert.equal(units[3].tool, "plan");
	assert.equal(units[4].entryId, "z1");
	assert.equal(extractUnits('{"type":"message"}\n', "/x").length, 0);
});

test("parseQuery handles words, quoted phrases and filters", () => {
	assert.deepEqual(parseQuery("fix wezterm"), { terms: ["fix", "wezterm"] });
	assert.deepEqual(parseQuery('"session plugin" role:user project:Alpha tool:Edit'), {
		terms: ["session plugin"],
		role: "user",
		project: "Alpha",
		tool: "edit",
	});
	assert.deepEqual(parseQuery("role:bogus x"), { terms: ["x"] });
	assert.deepEqual(parseQuery('"role:user"'), { terms: ["role:user"] });
});

test("search requires all terms, ranks by recency, applies filters and snippets", () => {
	const units = extractUnits(sessionText(), "/x/s1.jsonl");
	const all = search(units, parseQuery("wezterm"));
	assert.equal(all.total, 4);
	assert.equal(all.hits[0].unit.role, "summary");
	assert.ok(all.hits.every((h) => h.snippet.toLowerCase().includes("wezterm")));

	const both = search(units, parseQuery("wezterm plugin"));
	assert.equal(both.total, 1);
	assert.equal(both.hits[0].unit.role, "user");

	assert.equal(search(units, parseQuery("wezterm role:tool")).total, 1);
	assert.equal(search(units, parseQuery("wezterm tool:edit")).total, 1);
	assert.equal(search(units, parseQuery("wezterm project:beta")).total, 0);
	assert.equal(search(units, parseQuery("project:alpha")).total, 5);
	assert.equal(search(units, parseQuery('"not found"')).hits[0].unit.role, "tool");
	assert.equal(search(units, parseQuery("wezterm"), { limit: 2 }).hits.length, 2);
	assert.equal(search(units, parseQuery("nomatch")).total, 0);
});

test("makeSnippet and highlight", () => {
	const text = `${"a".repeat(100)}NEEDLE${"b".repeat(100)}`;
	const snippet = makeSnippet(text, 100, 6, 10);
	assert.equal(snippet, `…${"a".repeat(10)}NEEDLE${"b".repeat(10)}…`);
	assert.equal(makeSnippet("short", 0, 0, 10), "short");
	assert.equal(highlight("Fix wezterm now", ["wezterm", "fix"], (s) => `[${s}]`), "[Fix] [wezterm] now");
	assert.equal(highlight("a.b", ["."], (s) => `[${s}]`), "a[.]b");
});

test("refreshIndex caches by mtime and size and drops removed files", () => {
	const dir = mkdtempSync(join(tmpdir(), "recall-"));
	try {
		const a = join(dir, "proj", "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeFileSync(join(dir, "note.txt"), "ignored");
		mkdirSync(join(dir, "proj"));
		writeFileSync(a, sessionText());
		writeFileSync(b, sessionText({ cwd: "/home/u/beta" }));

		const cache: IndexCache = new Map();
		const first = refreshIndex(dir, cache);
		assert.equal(first.files, 2);
		assert.equal(first.reparsed, 2);
		assert.equal(first.units.length, 10);

		const second = refreshIndex(dir, cache);
		assert.equal(second.reparsed, 0);

		writeFileSync(b, `${sessionText({ cwd: "/home/u/beta" })}${JSON.stringify({ type: "message", id: "u9", timestamp: "2026-09-06T00:00:00.000Z", message: { role: "user", content: "later" } })}\n`);
		utimesSync(b, new Date(), new Date(Date.now() + 5000));
		const third = refreshIndex(dir, cache);
		assert.equal(third.reparsed, 1);
		assert.equal(third.units.length, 11);

		const excluded = refreshIndex(dir, cache, { exclude: a });
		assert.equal(excluded.files, 1);
		assert.ok(excluded.units.every((u) => u.file === b));

		rmSync(a);
		const fourth = refreshIndex(dir, cache);
		assert.equal(fourth.files, 1);
		assert.equal(cache.size, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
