/**
 * session-recall: полнотекстовый поиск по всем сессиям pi всех проектов.
 *
 *   /recall <слова>                     все слова должны встретиться в одном сообщении
 *   /recall "точная фраза"              фраза целиком
 *   /recall oldText role:tool tool:edit фильтры: role:user|assistant|tool|custom|summary, project:<имя>, tool:<имя>
 *
 * Enter на результате: показать сообщение целиком, вставить фрагмент в редактор или переключиться на ту сессию.
 * Текущая сессия исключается из поиска: она и так в контексте. Ничего не пишет.
 */
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ScrollReport } from "../shared/scroll-report.ts";
import { formatDate, type Hit, highlight, type IndexCache, parseQuery, refreshIndex, ROLES, search } from "./search.ts";
import { ResultsView } from "./view.ts";

const LIMIT = 50;

export default function (pi: ExtensionAPI) {
	const cache: IndexCache = new Map();
	const sessionsDir = () => join(getAgentDir(), "sessions");

	const describe = (hit: Hit) => {
		const u = hit.unit;
		const role = u.role === "tool" ? `tool:${u.tool ?? "?"}` : u.role;
		return `${formatDate(u.timestamp)} · ${u.project} · ${role}${u.sessionName ? ` · ${u.sessionName}` : ""}`;
	};

	const showFull = async (ctx: ExtensionCommandContext, hit: Hit, terms: string[]) => {
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			return new ScrollReport({
				tui,
				theme,
				onClose: () => done(),
				render: (width, th) => {
					const lines = [
						`${th.bold(th.fg("accent", " Recall"))}  ${th.fg("muted", describe(hit))}`,
						th.fg("dim", `${hit.unit.file}  entry ${hit.unit.entryId}`),
						th.fg("borderMuted", "─".repeat(Math.min(width, 110))),
					];
					for (const line of hit.unit.text.split("\n")) {
						let rest = line;
						while (rest.length > width - 1) {
							lines.push(rest.slice(0, width - 1));
							rest = rest.slice(width - 1);
						}
						lines.push(highlight(rest, terms, (s) => th.fg("warning", th.bold(s))));
					}
					return lines;
				},
			});
		});
	};

	pi.registerCommand("recall", {
		description: "Full-text search across all pi sessions of all projects (role:, project:, tool: filters)",
		getArgumentCompletions: (prefix) => {
			const words = prefix.split(/\s+/);
			const last = words.at(-1) ?? "";
			const before = words.slice(0, -1).join(" ");
			let values: string[] = [];
			if (last.startsWith("role:")) {
				values = ROLES.map((r) => `role:${r}`).filter((v) => v.startsWith(last));
			} else if (last === "" || /^(role|project|tool):?$/.test(last)) {
				values = ["role:", "project:", "tool:"];
			}
			const items = values.map((v) => ({ value: before ? `${before} ${v}` : v, label: v }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			let queryText = (args ?? "").trim();
			if (!queryText && ctx.hasUI) queryText = (await ctx.ui.input("Recall: search all sessions", "words, \"phrase\", role:user project:name"))?.trim() ?? "";
			if (!queryText) return;

			const query = parseQuery(queryText);
			const index = refreshIndex(sessionsDir(), cache, { exclude: ctx.sessionManager.getSessionFile() });
			const { hits, total } = search(index.units, query, { limit: LIMIT });

			if (ctx.mode !== "tui") {
				const lines = hits.map((h) => `${describe(h)}\n    ${h.snippet}`);
				const text = `${total} results for "${queryText}" in ${index.files} sessions\n${lines.join("\n")}`;
				ctx.ui.notify(ctx.hasUI ? `recall: ${total} results for "${queryText}"` : text, "info");
				if (!ctx.hasUI) process.stdout.write(`${text}\n`);
				return;
			}

			const picked = await ctx.ui.custom<Hit | undefined>((tui, theme, _kb, done) => {
				return new ResultsView({
					tui,
					theme,
					hits,
					total,
					terms: query.terms,
					queryText,
					onSelect: (hit) => done(hit),
					onClose: () => done(undefined),
				});
			});
			if (!picked) return;

			const action = await ctx.ui.select(describe(picked), ["Show full message", "Insert snippet into editor", "Switch to that session"]);
			if (action === "Show full message") {
				await showFull(ctx, picked, query.terms);
			} else if (action === "Insert snippet into editor") {
				const current = ctx.ui.getEditorText();
				const block = `> From ${describe(picked)}\n> ${picked.unit.file}\n\n${picked.unit.text.trim()}\n`;
				ctx.ui.setEditorText(current ? `${current}\n\n${block}` : block);
			} else if (action === "Switch to that session") {
				const result = await ctx.switchSession(picked.unit.file, {
					withSession: async (next) => next.ui.notify(`recall: switched to ${picked.unit.project} session`, "info"),
				});
				if (result.cancelled) ctx.ui.notify("recall: switch cancelled", "warning");
			}
		},
	});
}
