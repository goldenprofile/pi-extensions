/**
 * session-ledger CLI: тот же отчёт без pi.
 *
 *   node extensions/session-ledger/cli.ts [period] [group] [project] [--json] [--dir <sessions-dir>] [--top N]
 *
 * Требует Node >= 22.18 (нативный strip типов). Каталог сессий: $PI_CODING_AGENT_DIR/sessions или ~/.pi/agent/sessions.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { buildLedger, discoverSessionFiles, GROUPS, groupRows, loadSessions, parseArgs, PERIODS } from "./ledger.ts";
import { plainStyler, renderLedger } from "./report.ts";

function main(argv: string[]): number {
	let json = false;
	let top = 5;
	let dir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
	const positional: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") json = true;
		else if (arg === "--dir") dir = argv[++i] ?? dir;
		else if (arg === "--top") top = Number(argv[++i] ?? top) || top;
		else if (arg === "-h" || arg === "--help") {
			process.stdout.write(
				`usage: cli.ts [${PERIODS.join("|")}] [${GROUPS.join("|")}] [project] [--json] [--dir <sessions>] [--top N]\n`,
			);
			return 0;
		} else positional.push(arg);
	}
	const { period, by, project } = parseArgs(positional.join(" "));

	const files = discoverSessionFiles(dir);
	const { sessions, skipped } = loadSessions(files);
	const ledger = buildLedger(sessions, period, { scanned: files.length, skipped, project });

	if (json) {
		process.stdout.write(
			`${JSON.stringify({ period, by, project, since: ledger.since, scanned: ledger.scanned, skipped, total: ledger.total, rows: groupRows(ledger, by) }, null, 2)}\n`,
		);
		return 0;
	}
	const width = process.stdout.columns ?? 120;
	process.stdout.write(`${renderLedger(ledger, by, width, plainStyler, { top }).join("\n")}\n`);
	return 0;
}

process.exit(main(process.argv.slice(2)));
