/**
 * session-trace — автономный вьюер сессий pi (TUI).
 *
 *   node cli.ts --list            таблица всех сессий
 *   node cli.ts                   интерактивный выбор, затем live-follow
 *   node cli.ts <N>               открыть N-ю из списка (свежая = 1)
 *   node cli.ts <файл.jsonl>      открыть файл (live, если ещё пишется)
 *   node cli.ts -r <N|файл>       replay с начала (speed 8×)
 */
import { openSync, readSync, closeSync, fstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { TraceView } from "./graph.ts";
import { oneLine } from "./session.ts";

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

interface SessionInfo {
	file: string;
	cwd: string;
	mtimeMs: number;
	preview: string;
}

/** Читает шапку и до 96 КБ начала файла: cwd из header, превью первого user-сообщения. */
function scanSession(file: string): SessionInfo | undefined {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return undefined;
	}
	try {
		const size = fstatSync(fd).size;
		const len = Math.min(size, 96 * 1024);
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, 0);
		const mtimeMs = statSync(file).mtimeMs;
		let cwd = "";
		let preview = "";
		for (const line of buf.toString("utf8").split("\n")) {
			const t = line.trim();
			if (!t) continue;
			let e: any;
			try {
				e = JSON.parse(t);
			} catch {
				continue;
			}
			if (e.type === "session") {
				cwd = e.cwd ?? "";
				continue;
			}
			if (e.type === "message" && e.message?.role === "user" && !preview) {
				const c = e.message.content;
				preview = oneLine(typeof c === "string" ? c : (c ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" "), 64);
			}
			if (cwd && preview) break;
		}
		return { file, cwd, mtimeMs, preview };
	} finally {
		closeSync(fd);
	}
}

function listAll(): SessionInfo[] {
	const out: SessionInfo[] = [];
	let dirs: string[] = [];
	try {
		dirs = readdirSync(SESSIONS_DIR);
	} catch {
		return out;
	}
	for (const dir of dirs) {
		let files: string[] = [];
		try {
			files = readdirSync(join(SESSIONS_DIR, dir));
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const info = scanSession(join(SESSIONS_DIR, dir, f));
			if (info) out.push(info);
		}
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function fmtTable(list: SessionInfo[]): string {
	return list
		.map((s, i) => {
			const n = String(i + 1).padStart(3);
			const when = new Date(s.mtimeMs).toLocaleString();
			const proj = basename(s.cwd || "?");
			return `${n}  ${when}  ${proj.padEnd(18)} ${s.preview || "—"}`;
		})
		.join("\n");
}

function openViewer(file: string, mode: "live" | "replay"): void {
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	const view = new TraceView({
		tui,
		theme: fallbackTheme(),
		file,
		mode,
		onClose: () => {
			view.dispose();
			tui.stop();
			process.exit(0);
		},
	});
	tui.setLayoutRoot(view as any);
	tui.start();
	tui.setFocus(view as any);
	terminal.setTitle?.("session-trace");
}

/** Минимальная тема в терминах pi-tui: реальные цвета дают theme.fg-имена из tui.md. */
function fallbackTheme() {
	const wrap =
		(code: string) =>
		(s: string): string =>
			s ? `\x1b[${code}m${s}\x1b[0m` : s;
	const bright = (n: number) => wrap(`${n}1`); // bold-версия базового цвета
	return {
		bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
		fg: (color: string, s: string) => {
			if (!s) return s;
			const map: Record<string, (x: string) => string> = {
				text: wrap("97"),
				accent: bright(93), // ярко-жёлтый
				success: bright(92),
				error: bright(91),
				warning: bright(93),
				muted: wrap("37"),
				dim: wrap("90"),
				border: wrap("90"),
				borderMuted: wrap("90"),
				borderAccent: bright(90),
				toolTitle: bright(96),
				bashMode: bright(95),
				userMessageText: wrap("97"),
			};
			return (map[color] ?? wrap("97"))(s);
		},
	};
}

function usage(): never {
	console.log(`session-trace CLI — вьюер сессий pi

  node cli.ts --list         список всех сессий
  node cli.ts                интерактивный выбор (live)
  node cli.ts <N>            открыть N-ю из списка (live)
  node cli.ts <file.jsonl>   открыть файл (live)
  node cli.ts -r <N|file>    replay с начала (×8)`);
	process.exit(0);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "--list" || argv[0] === "-l") {
		console.log(fmtTable(listAll()) || "сессий нет");
		return;
	}
	const list = listAll();
	let file: string | undefined;
	let mode: "live" | "replay" = "live";

	const pick = argv[argv.length - 1] ?? "";
	if (pick.endsWith(".jsonl")) {
		file = pick;
	} else if (/^\d+$/.test(pick)) {
		file = list[Number(pick) - 1]?.file;
	} else if (argv.length === 0 || argv[0] === "-r" || argv[0] === "--replay") {
		// интерактивный выбор
		console.log(fmtTable(list) || "сессий нет");
		if (list.length === 0) return;
		const answer = await new Promise<string>((resolve) => {
			process.stdout.write("\nномер сессии (Enter = 1, q — выход): ");
			process.stdin.once("data", (d) => resolve(d.toString().trim()));
		});
		if (answer === "q") return;
		file = list[Number(answer || "1") - 1]?.file;
		if (!file) {
			console.error("нет такой строки");
			process.exit(1);
		}
	} else {
		usage();
	}

	if (argv[0] === "-r" || argv[0] === "--replay") mode = "replay";
	if (!file) usage();
	if (!statSync(file).isFile()) {
		console.error(`не файл: ${file}`);
		process.exit(1);
	}
	console.error(`trace: ${mode === "replay" ? "replay" : "live"} · ${basename(file)} · esc/q — выход`);
	openViewer(file, mode);
}

void main();
