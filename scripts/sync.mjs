#!/usr/bin/env node
/**
 * sync.mjs — deploy repo extensions to ~/.pi/agent/extensions.
 *
 * pi loads extensions from ~/.pi/agent/extensions, while development happens
 * in <repo>/extensions. Forgetting to copy after an edit makes live sessions
 * run stale code (the "newIdentityFile is not defined" class of bug). This
 * script makes the deploy step one command.
 *
 * Usage:
 *   npm run sync          # copy changed files (default)
 *   npm run sync:check    # report differences only, exit 1 if out of sync
 *
 * Rules:
 *   - Source of truth: <repo>/extensions/* (dirs and single files).
 *   - test/ and node_modules/ are never synced.
 *   - Never deletes: files that exist only in the destination are left alone
 *     and reported as extras.
 *   - Touches only repo-owned top-level entries; anything else in
 *     ~/.pi/agent/extensions is none of its business.
 */

import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = join(REPO_ROOT, "extensions");
const DST_ROOT = join(homedir(), ".pi", "agent", "extensions");
const CHECK_MODE = process.argv.includes("--check");
const SKIP_DIRS = new Set(["test", "node_modules"]);

/** All files under `root` as paths relative to `root` (skip dirs in SKIP_DIRS). */
function listFiles(root) {
	const out = [];
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) visit(join(dir, entry.name));
			} else if (entry.isFile()) {
				out.push(relative(root, join(dir, entry.name)));
			}
		}
	};
	visit(root);
	return out;
}

function differs(src, dst) {
	if (!existsSync(dst)) return true;
	return !readFileSync(src).equals(readFileSync(dst));
}

/**
 * Compare repo extensions against the installed copies.
 * Returns { copies, extras } — paths relative to the extensions root.
 */
export function planSync(srcRoot = SRC_ROOT, dstRoot = DST_ROOT) {
	const copies = [];
	for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
		const rels = entry.isDirectory()
			? listFiles(join(srcRoot, entry.name)).map((rel) => join(entry.name, rel))
			: [entry.name];
		for (const rel of rels) {
			if (differs(join(srcRoot, rel), join(dstRoot, rel))) copies.push(rel.split("\\").join("/"));
		}
	}

	// Extras: files present in an installed extension dir but not in the repo.
	const extras = [];
	for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dstDir = join(dstRoot, entry.name);
		if (!existsSync(dstDir)) continue;
		for (const rel of listFiles(dstDir)) {
			if (!existsSync(join(srcRoot, entry.name, rel))) extras.push(`${entry.name}/${rel.split("\\").join("/")}`);
		}
	}
	return { copies, extras };
}

/** Copy the planned files. Skips test/ and node_modules/ by construction of the plan. */
export function applySync(plan, srcRoot = SRC_ROOT, dstRoot = DST_ROOT) {
	for (const rel of plan.copies) {
		const src = join(srcRoot, rel);
		const dst = join(dstRoot, rel);
		mkdirSync(dirname(dst), { recursive: true });
		writeFileSync(dst, readFileSync(src));
	}
}

function main() {
	const plan = planSync();
	if (CHECK_MODE) {
		if (plan.copies.length === 0) {
			console.log(`✓ extensions are in sync (${DST_ROOT})`);
		} else {
			console.error(`✗ out of sync — ${plan.copies.length} file(s) differ:`);
			for (const rel of plan.copies) console.error(`  - ${rel}`);
			console.error("Run `npm run sync` to deploy.");
			process.exit(1);
		}
	} else {
		applySync(plan);
		for (const rel of plan.copies) console.log(`→ ${rel}`);
		console.log(
			plan.copies.length === 0
				? `✓ already in sync (${DST_ROOT})`
				: `✓ deployed ${plan.copies.length} file(s) to ${DST_ROOT}`,
		);
	}
	if (plan.extras.length > 0) {
		console.log("ℹ files only in destination (left untouched):");
		for (const rel of plan.extras) console.log(`  - ${rel}`);
	}
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main();
}
