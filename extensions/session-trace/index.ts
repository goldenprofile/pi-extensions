/**
 * session-trace — живой flow-граф сессии pi: ходы агента как карточки, вызовы
 * инструментов как чипы, компакции/смены модели как маркеры на таймлайне.
 *
 *   /trace            — текущая сессия, follow за живым хвостом
 *   /trace <file>     — replay любого JSONL по его timestamp'ам (space, ←→, +/-, l, r)
 *
 * Read-only: только читает session-файл, ничего не пишет и не блокирует агента.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { readRunningWorkers, runningIndexPath } from "../subagents/running-index.ts";

const subagentSessionsRoot = () => join(getAgentDir(), "sessions", "subagents");
import { TraceView } from "./graph.ts";

const SERVE_TS = join(dirname(fileURLToPath(import.meta.url)), "web", "serve.ts");
const WEB_URL = "http://127.0.0.1:8787/";

export default function (pi: ExtensionAPI) {
	let active: TraceView | undefined;
	let webServer: ReturnType<typeof spawn> | undefined;

	// Если сессию переключили/закрыли pi, пока оверлей открыт — прибрать за собой.
	pi.on("session_shutdown", () => {
		active?.dispose();
		active = undefined;
		webServer?.kill();
		webServer = undefined;
	});

	// Кэш списка сессий проекта для автодополнения аргумента /trace
	let completions: { value: string; label: string }[] | undefined;
	let completionsAt = 0;

	pi.registerCommand("trace", {
		description: "Flow graph of the session (session-trace): live follow or replay",
		getArgumentCompletions: (prefix: string) => {
			if (Date.now() - completionsAt > 10_000) {
				completionsAt = Date.now();
				SessionManager.list(process.cwd())
					.then((sessions) => {
						completions = sessions
							.slice(0, 20)
							.map((s) => ({
								value: s.file,
								label: `${basename(s.file)}${s.modified ? ` · ${new Date(s.modified).toLocaleString()}` : ""}`,
							}));
					})
					.catch(() => {
						completions = [];
					});
				// Живые task_batch-воркеры лежат в глобальном subagents-кталоге, а не
				// в сессиях текущего проекта — без этого их можно найти только по PID.
				try {
					const { workers } = readRunningWorkers(runningIndexPath(subagentSessionsRoot()));
					const live = workers.map((w) => ({
						value: w.sessionFile,
						label: `● live · ${w.label}${w.mode ? ` (${w.mode})` : ""} · pid ${w.pid}`,
					}));
					completions = [...live, ...(completions ?? [])].slice(0, 30);
				} catch {
					// Индекс опционален — не ломаем автокомплит без него.
				}
			}
			if (!completions) return null;
			const filtered = completions.filter((c) => c.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("trace: только в TUI-режиме", "warning");
				return;
			}
			const arg = (args ?? "").trim();
			const file = arg ? resolve(ctx.cwd, arg) : ctx.sessionManager.getSessionFile();
			if (!file || !existsSync(file)) {
				ctx.ui.notify(`trace: файл сессии не найден: ${file ?? "(ephemeral)"}`, "error");
				return;
			}
			const mode = arg ? "replay" : "live";
			const isReplay = mode === "replay";

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const view = new TraceView({
					tui,
					theme,
					file,
					mode,
					onClose: () => done(undefined),
				});
				active = view;
				return view;
			});

			active = undefined;
			void isReplay; // режим выбирается внутри view; arg только выбирает файл
		},
	});

	// Веб-вьюер в браузере: поднимаем локальный сервер отдельным процессом.
	// serve.ts при занятом порту сам найдёт свой работающий экземпляр, переключит
	// файл и просто откроет браузер, поэтому повторные вызовы безопасны.
	pi.registerCommand("trace-web", {
		description: "session-trace in the browser: local server + web viewer",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			const file = arg ? resolve(ctx.cwd, arg) : ctx.sessionManager.getSessionFile();
			if (file && !existsSync(file)) {
				ctx.ui.notify(`trace: файл сессии не найден: ${file}`, "error");
				return;
			}
			webServer?.kill();
			const child = spawn(process.execPath, [SERVE_TS, ...(file ? ["--file", file] : [])], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			child.unref();
			webServer = child;

			const message = `trace: web — ${WEB_URL}${file ? ` · ${basename(file)}` : ""} · сервер остановится при закрытии сессии`;
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			else process.stdout.write(`${message}\n`);
		},
	});
}
