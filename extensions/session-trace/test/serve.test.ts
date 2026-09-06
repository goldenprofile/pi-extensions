import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newestSession, startServer } from "../web/serve.ts";

test("serve.ts serves static files and the session file, /load switches it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-web-"));
	try {
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		writeFileSync(a, '{"type":"session","version":3,"id":"a","timestamp":"2026-09-05T12:00:00.000Z","cwd":"/x"}\n');
		writeFileSync(b, '{"type":"session","version":3,"id":"b","timestamp":"2026-09-05T13:00:00.000Z","cwd":"/y"}\n');
		const handle = await startServer({ file: a, port: 0 });
		try {
			const index = await fetch(`${handle.url}`).then((r) => r.text());
			assert.ok(index.includes("<!DOCTYPE") || index.includes("session-trace"));

			const first = await fetch(`${handle.url}session.jsonl`);
			assert.equal(first.status, 200);
			assert.ok((await first.text()).includes('"id":"a"'));

			const load = await fetch(`${handle.url}load`, { method: "POST", body: JSON.stringify({ file: b }) });
			assert.equal(load.status, 200);
			assert.ok((await fetch(`${handle.url}session.jsonl`).then((r) => r.text())).includes('"id":"b"'));

			// Чужая страница в браузере (Origin) не может переключать файл
			const csrf = await fetch(`${handle.url}load`, {
				method: "POST",
				headers: { origin: "http://evil.example" },
				body: JSON.stringify({ file: a }),
			});
			assert.equal(csrf.status, 403);

			assert.equal((await fetch(`${handle.url}nope`)).status, 404);
			assert.equal((await fetch(`${handle.url}../serve.ts`)).status, 404);
		} finally {
			await handle.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("serve.ts without a file answers 404 on /session.jsonl, /ping marks itself", async () => {
	const handle = await startServer({ port: 0 });
	try {
		assert.equal((await fetch(`${handle.url}session.jsonl`)).status, 404);
		assert.equal(await fetch(`${handle.url}ping`).then((r) => r.text()), "session-trace");
	} finally {
		await handle.close();
	}
});

test("newestSession picks the freshest jsonl across subfolders, ignores non-jsonl", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-newest-"));
	try {
		const old = join(dir, "old.jsonl");
		const newer = join(dir, "sub", "newer.jsonl");
		const note = join(dir, "note.txt");
		writeFileSync(old, "x\n");
		writeFileSync(note, "ignored");
		mkdirSync(join(dir, "sub"), { recursive: true });
		utimesSync(old, new Date(), new Date(Date.now() + 60_000));
		assert.equal(newestSession(dir), old); // свежего ещё нет
		writeFileSync(newer, "y\n");
		utimesSync(newer, new Date(), new Date(Date.now() + 120_000));
		assert.equal(newestSession(dir), newer); // рекурсия + сравнение по mtime
		assert.equal(newestSession(join(dir, "empty")), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
