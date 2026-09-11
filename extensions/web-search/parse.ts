/**
 * DuckDuckGo HTML result parsing (linkedom-based).
 *
 * Kept separate from index.ts so unit tests can exercise it directly without
 * loading the pi extension host. Expects the HTML from the `html/` endpoint:
 * blocks of `div.result` with `a.result__a` (title + redirect href) and
 * `a.result__snippet` (snippet).
 */
import { parseHTML } from "linkedom";
import { decodeDdgHref, type SearchResult } from "./query.ts";

export function parseDdgResults(html: string): SearchResult[] {
	const { document } = parseHTML(html);
	const results: SearchResult[] = [];
	for (const el of document.querySelectorAll("div.result")) {
		const link = el.querySelector("a.result__a");
		if (!link) continue;
		const href = link.getAttribute("href") ?? "";
		const url = decodeDdgHref(href);
		const title = (link.textContent ?? "").replace(/\s+/g, " ").trim();
		const snippet = (el.querySelector("a.result__snippet")?.textContent ?? "")
			.replace(/\s+/g, " ")
			.trim();
		if (!title || !url || !/^https?:\/\//i.test(url)) continue;
		results.push({ title, url, snippet });
	}
	return results;
}

/**
 * DuckDuckGo answers abuse with challenge pages instead of an error status.
 * A results-less response that smells like one is a distinct error the caller
 * should surface as "wait and retry", not "no results".
 */
export function looksLikeBotChallenge(html: string): boolean {
	return /anomaly|challenge|captcha/i.test(html);
}
