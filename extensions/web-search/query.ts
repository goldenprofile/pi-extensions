/**
 * Pure query-building logic for web_search — no dependencies, no I/O.
 * Everything here is covered by unit tests and shared by the tool's
 * renderers, which must never throw on partial/streaming arguments.
 */

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface StructuredSearchArgs {
	query?: string;
	exactPhrases?: string[];
	excludeTerms?: string[];
	site?: string;
	count?: number;
}

export interface BuiltSearchQuery {
	query: string;
	baseQuery?: string;
	exactPhrases: string[];
	excludeTerms: string[];
	site?: string;
}

export const DEFAULT_RESULT_COUNT = 5;
export const MAX_RESULT_COUNT = 10;

export function clampCount(count: number | undefined): number {
	if (typeof count !== "number" || !Number.isFinite(count)) return DEFAULT_RESULT_COUNT;
	return Math.max(1, Math.min(MAX_RESULT_COUNT, Math.round(count)));
}

function stripWrappingQuotes(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
		? value.slice(1, -1).trim()
		: value;
}

function cleanItems(values?: string[]): string[] {
	if (!values) return [];
	return values
		.map((value) => stripWrappingQuotes(value.trim().replace(/\s+/g, " ")))
		.filter(Boolean);
}

function cleanQuery(value?: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.trim().replace(/\s+/g, " ");
	return cleaned || undefined;
}

/**
 * Accept "example.com", "https://example.com/path", "site:example.com" —
 * always yields the bare hostname.
 */
export function normalizeSite(site?: string): string | undefined {
	if (typeof site !== "string") return undefined;

	let value = site.trim().replace(/^site:/i, "").trim();
	if (!value) return undefined;

	try {
		const candidate = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
		const url = new URL(candidate);
		if (url.hostname) value = url.hostname;
	} catch {}

	return value.replace(/\/+$/, "") || undefined;
}

export function quoteForSearch(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildSearchQuery(args: StructuredSearchArgs): BuiltSearchQuery {
	const baseQuery = cleanQuery(args.query);
	const exactPhrases = cleanItems(args.exactPhrases);
	const excludeTerms = cleanItems(args.excludeTerms);
	const site = normalizeSite(args.site);

	if (!baseQuery && exactPhrases.length === 0) {
		throw new Error("At least one of 'query' or 'exactPhrases' is required.");
	}

	const parts: string[] = [];
	if (baseQuery) parts.push(baseQuery);
	for (const phrase of exactPhrases) {
		parts.push(quoteForSearch(phrase));
	}
	for (const term of excludeTerms) {
		parts.push(`-${term.includes(" ") ? quoteForSearch(term) : term}`);
	}
	if (site) {
		parts.push(`site:${site}`);
	}

	return {
		query: parts.join(" "),
		baseQuery,
		exactPhrases,
		excludeTerms,
		site,
	};
}

/**
 * DuckDuckGo wraps result links in redirectors: relative `//duckduckgo.com/l/?uddg=<encoded>`
 * or absolute `https://duckduckgo.com/l/?uddg=<encoded>`. Unwrap them to the
 * real target. Non-redirect hrefs pass through untouched — in particular,
 * relative links must NOT get resolved against the DDG origin (they would
 * silently become useless duckduckgo.com paths that pass the scheme check).
 */
export function decodeDdgHref(href: string): string {
	try {
		const url = new URL(href, "https://duckduckgo.com");
		const uddg = url.searchParams.get("uddg");
		if (uddg) return uddg;
		if (/^https?:\/\//i.test(href)) return url.toString();
		return href;
	} catch {
		return href;
	}
}

export function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
		.join("\n\n");
}
