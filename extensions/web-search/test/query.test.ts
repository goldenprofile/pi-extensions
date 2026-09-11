import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSearchQuery,
	clampCount,
	decodeDdgHref,
	formatResults,
	normalizeSite,
	type StructuredSearchArgs,
} from "../query.ts";

const args = (over: Partial<StructuredSearchArgs>): StructuredSearchArgs => over;

test("buildSearchQuery: base query only", () => {
	const built = buildSearchQuery(args({ query: "pi coding agent" }));
	assert.equal(built.query, "pi coding agent");
	assert.equal(built.baseQuery, "pi coding agent");
});

test("buildSearchQuery: phrases are quoted, exclusions prefixed, site appended", () => {
	const built = buildSearchQuery(
		args({
			query: "postgres",
			exactPhrases: ["skip locked"],
			excludeTerms: ["mysql", "sqlite 3"],
			site: "stackoverflow.com",
		}),
	);
	assert.equal(built.query, 'postgres "skip locked" -mysql -"sqlite 3" site:stackoverflow.com');
});

test("buildSearchQuery: exact phrases alone are enough", () => {
	const built = buildSearchQuery(args({ exactPhrases: ["terminal bundle"] }));
	assert.equal(built.query, '"terminal bundle"');
});

test("buildSearchQuery: without query and phrases throws", () => {
	assert.throws(() => buildSearchQuery(args({ site: "example.com" })), /query.*exactPhrases/s);
});

test("buildSearchQuery: quotes inside phrases are escaped", () => {
	const built = buildSearchQuery(args({ exactPhrases: ['say "hi"'] }));
	assert.equal(built.query, '"say \\"hi\\""');
});

test("normalizeSite: strips scheme, site:, path, trailing slashes", () => {
	assert.equal(normalizeSite("example.com"), "example.com");
	assert.equal(normalizeSite("https://docs.example.com/guide/"), "docs.example.com");
	assert.equal(normalizeSite("site:example.com"), "example.com");
	assert.equal(normalizeSite("   "), undefined);
	assert.equal(normalizeSite("not a url ??"), "not a url ??");
});

test("clampCount: rounds into [1, 10], defaults to 5", () => {
	assert.equal(clampCount(undefined), 5);
	assert.equal(clampCount(0), 1);
	assert.equal(clampCount(3.7), 4);
	assert.equal(clampCount(99), 10);
	assert.equal(clampCount(Number.NaN), 5);
});

test("decodeDdgHref: unwraps relative and absolute redirectors, passes real URLs", () => {
	const inner = "https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1";
	assert.equal(
		decodeDdgHref(`//duckduckgo.com/l/?uddg=${inner}&rut=abc`),
		"https://example.com/page?a=1",
	);
	assert.equal(
		decodeDdgHref(`https://duckduckgo.com/l/?uddg=${inner}`),
		"https://example.com/page?a=1",
	);
	assert.equal(decodeDdgHref("https://example.com/direct"), "https://example.com/direct");
	// Relative links must NOT be resolved against the DDG origin — they are
	// returned as-is and filtered downstream by the scheme check.
	assert.equal(decodeDdgHref("/local/relative"), "/local/relative");
	assert.equal(decodeDdgHref(""), "");
});

test("formatResults: numbered list and empty case", () => {
	assert.equal(formatResults([]), "No results found.");
	const out = formatResults([
		{ title: "T1", url: "https://a", snippet: "s1" },
		{ title: "T2", url: "https://b", snippet: "s2" },
	]);
	assert.match(out, /1\. T1\n   https:\/\/a\n   s1\n\n2\. T2/);
});
