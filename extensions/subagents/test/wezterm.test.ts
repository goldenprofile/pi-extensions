import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStackPercent, parseSentinel, ps1SingleQuote } from "../wezterm.ts";

test("computeStackPercent: keeps the column even as it grows", () => {
	assert.equal(computeStackPercent(0), 50);
	assert.equal(computeStackPercent(1), 50);
	assert.equal(computeStackPercent(2), 67);
	assert.equal(computeStackPercent(3), 75);
	assert.equal(computeStackPercent(4), 80);
});

test("parseSentinel: extracts exit codes from screen text", () => {
	assert.equal(parseSentinel("some output\n__SUBAGENT_DONE_0__\n"), 0);
	assert.equal(parseSentinel("__SUBAGENT_DONE_3__"), 3);
	assert.equal(parseSentinel("no sentinel here"), null);
	assert.equal(parseSentinel(""), null);
});

test("parseSentinel: ignores partial markers", () => {
	assert.equal(parseSentinel("__SUBAGENT_DONE_"), null);
	assert.equal(parseSentinel("SUBAGENT_DONE_0__"), null);
});

test("ps1SingleQuote: PowerShell escaping", () => {
	assert.equal(ps1SingleQuote("plain"), "'plain'");
	assert.equal(ps1SingleQuote("it's"), "'it''s'");
	assert.equal(ps1SingleQuote(""), "''");
});
