/**
 * Смоук-тест session-trace без TTY: рендерит реальную сессию в stdout.
 * Запуск:
 *   node test/render.ts <session.jsonl> [rows] [--keys=ПОСЛЕДОВATEЛЬНОСТЬ]
 * Клавиши: обычные символы пишутся как есть, Enter — «\r», например:
 *   --keys="m"          сводка по моделям
 *   --keys="/edit\r"    фильтр по подстроке
 *   --keys="e"          только ошибки
 *   PI_TRACE_MODE=replay — режим replay (1.5s тиков)
 */
import { basename } from "node:path";
import { TraceView } from "../graph.ts";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
if (!file) {
	console.error("usage: node test/render.ts <session.jsonl> [rows] [--keys=...]");
	process.exit(1);
}
const rowsArg = argv.find((a) => /^\d+$/.test(a));
const keysArg = argv.find((a) => a.startsWith("--keys="));
const rows = Number(rowsArg ?? 30);

const tui = {
	requestRender() {},
	terminal: { rows, columns: 110 },
};
const theme = {
	fg: (_color: string, s: string) => s,
	bold: (s: string) => s,
};

const view = new TraceView({
	tui: tui as any,
	theme: theme as any,
	file,
	mode: (process.env.PI_TRACE_MODE as "live" | "replay") ?? "live",
	onClose: () => {},
});

// в replay даём таймеру потикать: 1.5s реального времени × speed
if (process.env.PI_TRACE_MODE === "replay") {
	await new Promise((r) => setTimeout(r, 1500));
}

if (keysArg) {
	const seq = keysArg.slice(7).replace(/\\e/g, "\x1b");
	// ESC-последовательности отправляем одним токеном (как реальный терминал),
	// одиночный ESC иначе сматчится как Escape
	const tokens: string[] = [];
	for (let i = 0; i < seq.length; i++) {
		if (seq[i] === "\x1b") {
			let j = i + 1;
			while (j < seq.length && !/[A-Za-z~]/.test(seq[j])) j++;
			tokens.push(seq.slice(i, j + 1));
			i = j;
		} else {
			tokens.push(seq[i]);
		}
	}
	for (const t of tokens) view.handleInput(t);
}

const lines = view.render(110);
console.log(lines.join("\n"));
console.log(`\n[rendered ${lines.length} rows @110 cols from ${basename(file)}${keysArg ? ` · keys=${keysArg.slice(7)}` : ""}]`);
view.dispose();
process.exit(0);
