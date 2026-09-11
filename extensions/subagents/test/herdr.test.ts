import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePaneListIds, parseSplitPaneId } from "../herdr.ts";

// Real response captured from herdr 0.9.0 (`herdr pane split …`).
const SPLIT_OK =
	'{"id":"cli:pane:split","result":{"pane":{"agent_status":"unknown","cwd":"C:\\\\Temp\\\\x\\\\","focused":false,"pane_id":"w6:p2","revision":0,"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":36},"tab_id":"w6:t1","terminal_id":"term_x","workspace_id":"w6"},"type":"pane_info"}}';

test("parseSplitPaneId: real herdr 0.9.0 response", () => {
	assert.equal(parseSplitPaneId(SPLIT_OK), "w6:p2");
});

test("parseSplitPaneId: tolerates a flat result pane_id", () => {
	assert.equal(parseSplitPaneId('{"result":{"pane_id":"w1:p9"}}'), "w1:p9");
});

test("parseSplitPaneId: unexpected shape throws", () => {
	assert.throws(() => parseSplitPaneId('{"result":{}}'));
	assert.throws(() => parseSplitPaneId("not json at all"));
	assert.throws(() => parseSplitPaneId(""));
});

// Real response captured from herdr 0.9.0 (`herdr pane list`).
const LIST_OK =
	'{"id":"cli:pane:list","result":{"panes":[{"pane_id":"w6:p1","agent":"pi","agent_status":"working"},{"pane_id":"w8:p1","agent_status":"idle"},{"pane_id":"wA:p1","agent_status":"unknown"}],"type":"pane_list"}}';

test("parsePaneListIds: real herdr 0.9.0 response", () => {
	assert.deepEqual(parsePaneListIds(LIST_OK), ["w6:p1", "w8:p1", "wA:p1"]);
});

test("parsePaneListIds: defensive against shape drift", () => {
	assert.deepEqual(parsePaneListIds('{"result":[{"pane_id":"w1:p1"}]}'), ["w1:p1"]);
	assert.deepEqual(parsePaneListIds('{"result":{"panes":[{"nope":1},{"pane_id":"w1:p2"}]}}'), ["w1:p2"]);
	assert.deepEqual(parsePaneListIds('{"result":{"panes":[]}}'), []);
	assert.deepEqual(parsePaneListIds("garbage"), []);
	assert.deepEqual(parsePaneListIds("{}"), []);
});
