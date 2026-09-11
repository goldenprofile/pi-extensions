import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNameRegistry, registryPath, removeName, uniqueName, upsertName, writeNameRegistry } from "../registry.ts";

function tmpFile(): string {
	return join(mkdtempSync(join(tmpdir(), "pi-subagents-reg-")), "subagent-registry.json");
}

test("registryPath: joins artifact dir", () => {
	assert.equal(registryPath("C:\\art\\s1"), "C:\\art\\s1/subagent-registry.json");
	assert.equal(registryPath(""), "subagent-registry.json");
});

test("uniqueName: dedupes with numeric suffixes", () => {
	assert.equal(uniqueName("scout", []), "scout");
	assert.equal(uniqueName("scout", ["scout"]), "scout-2");
	assert.equal(uniqueName("scout", ["scout", "scout-2", "worker"]), "scout-3");
});

test("upsert/read/remove roundtrip with atomic write", () => {
	const file = tmpFile();
	const entry = {
		name: "scout",
		agent: "scout",
		task: "recon",
		session: "C:\\sessions\\a.jsonl",
		autoExit: true,
		registeredAt: 1,
	};
	upsertName(file, entry);
	upsertName(file, { ...entry, name: "worker" });

	const reg = readNameRegistry(file);
	assert.deepEqual(Object.keys(reg).sort(), ["scout", "worker"]);
	assert.equal(reg["scout"]?.session, "C:\\sessions\\a.jsonl");

	removeName(file, "scout");
	assert.deepEqual(Object.keys(readNameRegistry(file)), ["worker"]);
	rmSync(join(file, ".."), { recursive: true, force: true });
});

test("readNameRegistry: corrupt or missing file → empty registry", () => {
	const file = tmpFile();
	assert.deepEqual(readNameRegistry(file), {});
	writeFileSync(file, "{ not json", "utf8");
	assert.deepEqual(readNameRegistry(file), {});
	writeFileSync(file, "[1,2]", "utf8");
	assert.deepEqual(readNameRegistry(file), {});
	rmSync(join(file, ".."), { recursive: true, force: true });
});

test("writeNameRegistry: survives partial tmp state", () => {
	const file = tmpFile();
	writeNameRegistry(file, { a: { name: "a", agent: "a", task: "", session: "s", autoExit: true, registeredAt: 0 } });
	// A leftover tmp file must not confuse reads.
	writeFileSync(`${file}.tmp`, "garbage", "utf8");
	assert.deepEqual(Object.keys(readNameRegistry(file)), ["a"]);
	rmSync(join(file, ".."), { recursive: true, force: true });
});
