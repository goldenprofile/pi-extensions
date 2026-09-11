/**
 * Name registry: maps a subagent's display name to everything needed to
 * address it later — steer it while running, resume it after it finished,
 * even after the parent pi restarted.
 *
 * One registry per spawner session, stored beside the session's artifacts:
 *   <sessionDir>/artifacts/<sessionId>/subagent-registry.json
 *
 * Writes go through tmp+rename so a crash mid-write never corrupts the file.
 *
 * Deliberately dependency-free so tests can run standalone.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RegistryEntry {
	name: string;
	agent: string;
	task: string;
	/** Child session file — resume replays pi --session against it. */
	session: string;
	/** Snapshot of the resolved launch configuration (loadout-lite). */
	cwd?: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	noExtensions?: boolean;
	autoExit: boolean;
	registeredAt: number;
}

export type NameRegistry = Record<string, RegistryEntry>;

export function registryPath(artifactDir: string): string {
	return artifactDir === "" ? "subagent-registry.json" : `${artifactDir}/subagent-registry.json`;
}

/** Read a spawner session's name registry, or {} when absent/corrupt. */
export function readNameRegistry(path: string): NameRegistry {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as NameRegistry;
	} catch {
		return {};
	}
}

/** Atomically upsert one entry (tmp + rename; concurrent spawns serialize). */
export function upsertName(path: string, entry: RegistryEntry): NameRegistry {
	const registry = readNameRegistry(path);
	registry[entry.name] = entry;
	writeNameRegistry(path, registry);
	return registry;
}

/** Atomically remove one entry (used when a pane is closed for good). */
export function removeName(path: string, name: string): NameRegistry {
	const registry = readNameRegistry(path);
	delete registry[name];
	writeNameRegistry(path, registry);
	return registry;
}

export function writeNameRegistry(path: string, registry: NameRegistry): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(registry, null, 2));
		renameSync(tmp, path);
	} catch {
		// Best effort: an unwritable registry degrades resume, nothing else.
	}
}

/** First name not present in `taken`, trying `base`, `base-2`, `base-3`, … */
export function uniqueName(base: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	if (!used.has(base)) return base;
	let n = 2;
	while (used.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}
