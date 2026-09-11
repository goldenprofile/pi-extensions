/**
 * web_search — DuckDuckGo search for pi, no API keys.
 *
 * Based on the web-search extension by Eero Alvar (amosblomqvist,
 * https://github.com/amosblomqvist/pi-config), which used the Google Custom
 * Search API. This version searches the DuckDuckGo HTML endpoint instead:
 * no credentials, structured-argument building, AbortSignal-aware, with a
 * request timeout and one retry on transient bot-check responses.
 *
 * DuckDuckGo has no official search API; the HTML endpoint is the de-facto one
 * (same approach as the ddgs Python library). POST form-encoded is mandatory:
 * GET gets 403/202 bot-challenge regardless of headers. The full browser-like
 * header set (Origin/Referer/Sec-Fetch-*) matters too — a bare UA + Content-Type
 * gets 202 from Node's fetch even though curl passes.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { looksLikeBotChallenge, parseDdgResults } from "./parse.ts";
import {
	buildSearchQuery,
	clampCount,
	formatResults,
	type StructuredSearchArgs,
} from "./query.ts";

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 20_000;
const RETRYABLE_STATUS = new Set([202, 403, 429]);
const RETRY_BACKOFF_MS = 1500;

function isAbort(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function searchHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/x-www-form-urlencoded",
		"User-Agent": USER_AGENT,
		"Accept":
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
		"Origin": "https://html.duckduckgo.com",
		"Referer": "https://html.duckduckgo.com/",
		"Sec-Fetch-Dest": "document",
		"Sec-Fetch-Mode": "navigate",
		"Sec-Fetch-Site": "same-origin",
		"Upgrade-Insecure-Requests": "1",
	};
}

function combineSignals(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchResultsPage(
	query: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const resp = await fetch("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: searchHeaders(),
		body: new URLSearchParams({ q: query }).toString(),
		signal: combineSignals(signal),
	});

	if (!resp.ok) {
		throw Object.assign(
			new Error(`DuckDuckGo HTTP ${resp.status}${resp.status === 403 || resp.status === 202 ? " (bot-check)" : ""}`),
			{ transient: RETRYABLE_STATUS.has(resp.status) },
		);
	}

	const html = await resp.text();
	if (looksLikeBotChallenge(html)) {
		throw Object.assign(
			new Error("DuckDuckGo returned a bot-challenge page instead of results."),
			{ transient: true },
		);
	}
	return html;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Aborted"));
			},
			{ once: true },
		);
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via DuckDuckGo. Build one search per call from a base query string, exact phrases, exclusions, and an optional site. Returns title, URL, and snippet.",
		promptSnippet:
			"Search the web via a query string plus optional exactPhrases, excludeTerms, and site. Use one tool call per search angle.",
		promptGuidelines: [
			"Use exactPhrases for exact phrase matching instead of embedding quote marks inside the main query string.",
			"Use one web_search tool call per search angle instead of batching multiple searches into one call.",
		],

		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					description:
						"Base search query as a normal string. Prefer this for the main search wording.",
				}),
			),
			exactPhrases: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Exact phrases to match. Each item becomes a quoted phrase in the final query.",
				}),
			),
			excludeTerms: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Terms or phrases to exclude. Multi-word items are excluded as exact phrases.",
				}),
			),
			site: Type.Optional(
				Type.String({
					description:
						"Optional site/domain restriction, such as example.com or a full URL.",
				}),
			),
			count: Type.Optional(
				Type.Number({
					description: "Number of results to return (default: 5, max: 10)",
					minimum: 1,
					maximum: 10,
				}),
			),
		}),

		async execute(_toolCallId, params: StructuredSearchArgs, signal) {
			const count = clampCount(params.count);
			const built = buildSearchQuery(params);
			const startedAt = Date.now();

			let html: string;
			try {
				html = await fetchResultsPage(built.query, signal);
			} catch (error) {
				// One retry for transient bot-check responses; a genuine challenge
				// page stays a challenge on immediate retry, but rate-limit hiccups
				// clear within the backoff window. Aborts are never retried.
				if (isAbort(error) || !(error as { transient?: boolean })?.transient) {
					throw error;
				}
				await sleep(RETRY_BACKOFF_MS, signal);
				html = await fetchResultsPage(built.query, signal);
			}

			const results = parseDdgResults(html).slice(0, count);

			return {
				content: [
					{
						type: "text" as const,
						text: formatResults(results),
					},
				],
				details: {
					composedQuery: built.query,
					query: built.baseQuery,
					exactPhrases: built.exactPhrases,
					excludeTerms: built.excludeTerms,
					site: built.site,
					resultCount: results.length,
					durationMs: Date.now() - startedAt,
				},
			};
		},

		renderCall(args, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);
			const { count, ...searchArgs } = args as StructuredSearchArgs;

			try {
				const built = buildSearchQuery(searchArgs);
				const display =
					built.query.length > 70
						? built.query.slice(0, 67) + "..."
						: built.query;
				const lines = [
					theme.fg("toolTitle", theme.bold("search ")) +
						theme.fg("accent", `"${display}"`),
				];
				if (count && count !== 5) {
					lines.push(theme.fg("dim", `  count: ${count}`));
				}
				text.setText(lines.join("\n"));
				return text;
			} catch {
				text.setText(
					theme.fg("toolTitle", theme.bold("search ")) +
						theme.fg("error", "(invalid query)"),
				);
				return text;
			}
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ??
				new Text("", 0, 0);

			if (isPartial) {
				text.setText(theme.fg("warning", "Searching…"));
				return text;
			}

			if (context.isError) {
				const msg =
					result.content.find((c) => c.type === "text")?.text ||
					"Error";
				text.setText(theme.fg("error", msg));
				return text;
			}

			const details = result.details as {
				composedQuery?: string;
				resultCount?: number;
				durationMs?: number;
			};
			const elapsed =
				details?.durationMs != null ? ` in ${(details.durationMs / 1000).toFixed(1)}s` : "";
			const status = theme.fg(
				"success",
				`${details?.resultCount ?? 0} results${elapsed}`,
			);
			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content =
				result.content.find((c) => c.type === "text")?.text || "";
			const preview =
				content.length > 500 ? content.slice(0, 500) + "..." : content;
			const queryLine = details?.composedQuery
				? theme.fg("dim", `query: ${details.composedQuery}`)
				: "";
			text.setText(
				[status, queryLine, theme.fg("dim", preview)]
					.filter(Boolean)
					.join("\n"),
			);
			return text;
		},
	});
}
