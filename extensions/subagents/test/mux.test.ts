import assert from "node:assert/strict";
import { test } from "node:test";
import { selectBackend } from "../mux.ts";

test("selectBackend: herdr wins over inherited WEZTERM_PANE", () => {
	// The herdr-in-wezterm bug: a herdr pane inherits WEZTERM_PANE from the
	// herdr client, but that pane belongs to herdr — wezterm splits die with
	// "pane_id N invalid". HERDR_ENV=1 must always win.
	assert.equal(selectBackend({ HERDR_ENV: "1", WEZTERM_PANE: "6" }, true, true), "herdr");
});

test("selectBackend: wezterm when HERDR_ENV is not 1", () => {
	assert.equal(selectBackend({ HERDR_ENV: "", WEZTERM_PANE: "6" }, true, true), "wezterm");
	assert.equal(selectBackend({ HERDR_ENV: "0", WEZTERM_PANE: "6" }, false, true), "wezterm");
});

test("selectBackend: null when inside herdr but the herdr CLI is unusable", () => {
	// Never silently fall back to wezterm — that would resurface the bug.
	assert.equal(selectBackend({ HERDR_ENV: "1", WEZTERM_PANE: "6" }, false, true), null);
	assert.equal(selectBackend({ HERDR_ENV: "1", WEZTERM_PANE: "" }, false, true), null);
});

test("selectBackend: null when wezterm env present but CLI unusable", () => {
	assert.equal(selectBackend({ HERDR_ENV: "", WEZTERM_PANE: "6" }, true, false), null);
});

test("selectBackend: null outside any multiplexer", () => {
	assert.equal(selectBackend({ HERDR_ENV: "", WEZTERM_PANE: "" }, true, true), null);
});
