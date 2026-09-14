/**
 * session-trace: локальный сервер веб-вьюера.
 *
 *   node web/serve.ts [--file <session.jsonl>] [--port 8787] [--no-open]
 *
 * Раздаёт index.html и app.js из этой папки, файл сессии — по /session.jsonl.
 * Без --file берётся самая свежая сессия из ~/.pi/agent/sessions (или $PI_CODING_AGENT_DIR).
 * POST /load {"file": "..."} переключает файл без перезапуска; запросы с заголовком Origin
 * отвергаются — чужая страница в браузере не может дёргать этот эндпоинт.
 * Слушает только 127.0.0.1. Ctrl+C — остановка.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const webDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8787;

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".jsonl": "text/plain; charset=utf-8",
};

export interface ServeOptions {
	/** Абсолютный путь к файлу сессии. Без него /session.jsonl отвечает 404. */
	file?: string;
	/** Порт; 0 — свободный автоматически. По умолчанию 8787. */
	port?: number;
}

export interface ServeHandle {
	port: number;
	url: string;
	close(): Promise<void>;
}

export function sessionsRoot(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
}

/** Самая свежая .jsonl-сессия в дереве root (по mtime). */
export function newestSession(root = sessionsRoot()): string | undefined {
	let best: { file: string; mtime: number } | undefined;
	const walk = (dir: string) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue; // файл исчез между readdir и stat
			}
			if (st.isDirectory()) walk(full);
			else if (name.endsWith(".jsonl") && (!best || st.mtimeMs > best.mtime)) best = { file: full, mtime: st.mtimeMs };
		}
	};
	walk(root);
	return best?.file;
}

function send(res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void {
	res.writeHead(code, { "content-type": type });
	res.end(body);
}

function handle(req: IncomingMessage, res: ServerResponse, state: { file?: string }): void {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");

	if (req.method === "POST" && url.pathname === "/load") {
		// Origin допускается только собственный (same-origin POST из вьюера);
		// чужая страница в браузере дёргать этот эндпоинт не может.
		const ownOrigin = `http://${req.headers.host ?? ""}`;
		if (req.headers.origin && req.headers.origin !== ownOrigin) return send(res, 403, "forbidden");
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			try {
				const file = (JSON.parse(body) as { file?: string }).file;
				if (typeof file !== "string" || !file.endsWith(".jsonl") || !existsSync(file)) throw new Error("bad file");
				state.file = file;
				send(res, 200, JSON.stringify({ ok: true, file: basename(file) }), "application/json");
			} catch {
				send(res, 400, "bad request");
			}
		});
		return;
	}

	if (url.pathname === "/ping") return send(res, 200, "session-trace");

	// Живые task_batch-воркеры из глобального индекса subagents (running.json).
	// Динамический импорт: индекс опционален — без расширения отвечаем 404,
	// и UI просто прячет панель.
	if (url.pathname === "/workers") {
		import("../../subagents/running-index.ts")
			.then((m) => {
				const { workers } = m.readRunningWorkers(m.runningIndexPath(join(sessionsRoot(), "subagents")));
				send(res, 200, JSON.stringify({ workers }), "application/json");
			})
			.catch(() => send(res, 404, "no running index"));
		return;
	}

	if (url.pathname === "/session.jsonl") {
		const file = state.file;
		if (!file || !existsSync(file)) return send(res, 404, "нет файла сессии — запустите serve.ts с --file или перетащите .jsonl на страницу");
		res.writeHead(200, {
			"content-type": MIME[".jsonl"],
			"x-session-file": encodeURIComponent(basename(file)),
			"cache-control": "no-store",
		});
		res.end(readFileSync(file));
		return;
	}

	// Статика: / → index.html, /app.js
	const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
	if (rel !== "index.html" && rel !== "app.js") return send(res, 404, "not found");
	try {
		res.writeHead(200, { "content-type": MIME[rel.slice(rel.lastIndexOf("."))] ?? "text/plain" });
		res.end(readFileSync(join(webDir, rel)));
	} catch {
		send(res, 404, "not found");
	}
}

/** Запускает сервер; resolve после bind, reject при ошибке порта. */
export function startServer(options: ServeOptions = {}): Promise<ServeHandle> {
	const state = { file: options.file };
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => handle(req, res, state));
		server.on("error", reject);
		server.listen(options.port ?? DEFAULT_PORT, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
			resolve({
				port,
				url: `http://127.0.0.1:${port}/`,
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}

function fail(message: string): never {
	try {
		appendFileSync(join(tmpdir(), "session-trace-web.log"), `${new Date().toISOString()} ${message}\n`);
	} catch {
		// лог не критичен
	}
	process.stderr.write(`session-trace web: ${message}\n`);
	process.exit(1);
}

function openBrowser(url: string): void {
	const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
}

async function main(): Promise<void> {
	let file: string | undefined;
	let port = DEFAULT_PORT;
	let open = true;
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--file") file = argv[++i];
		else if (a === "--port") port = Number(argv[++i]) || DEFAULT_PORT;
		else if (a === "--no-open") open = false;
		else if (a.endsWith(".jsonl")) file = a;
	}
	if (file && !existsSync(file)) fail(`файл сессии не найден: ${file}`);
	file ??= newestSession();

	// Порт по умолчанию занят? Если там наш же сервер — переключаем файл и открываем браузер.
	if (port === DEFAULT_PORT) {
		try {
			const probe = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(800) });
			if ((await probe.text()) === "session-trace") {
				if (file) {
					await fetch(`http://127.0.0.1:${port}/load`, { method: "POST", body: JSON.stringify({ file }) });
				}
				if (open) openBrowser(`http://127.0.0.1:${port}/`);
				process.stdout.write(`session-trace web: сервер уже запущен, файл переключён: ${file ? basename(file) : "—"}\n`);
				return;
			}
		} catch {
			// порт свободен — стартуем как обычно
		}
	}

	try {
		const handle = await startServer({ file, port });
		process.stdout.write(
			`session-trace web: ${handle.url} · ${file ? basename(file) : "перетащите .jsonl на страницу"} · Ctrl+C — остановить\n`,
		);
		if (open) openBrowser(handle.url);
	} catch (error) {
		fail(`не удалось занять порт ${port}: ${(error as Error).message}. Укажите другой --port или остановите старый сервер.`);
	}
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) void main();
