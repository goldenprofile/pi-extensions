/**
 * Global index of live headless workers (task_batch children).
 *
 * The batch UI lives inside the spawner session's tool call, so from any other
 * session there was no way to ask "what is running right now?" — the only
 * discovery path was scanning process command lines. This module fixes that:
 * every spawned child gets a record in a single machine-wide JSON file beside
 * the subagent sessions, removed on exit (best effort). Readers stale-reap by
 * PID liveness so a crashed spawner never leaves ghosts behind.
 *
 * Pure logic, no pi runtime imports — shared with session-trace (read-only).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RUNNING_INDEX_VERSION = 1;
export const RUNNING_INDEX_NAME = "running.json";

/** One live worker record as stored in the index. */
export interface RunningWorker {
	/** Stable unique id (same shape as subagent ids). */
	id: string;
	/** Child process PID — the liveness source of truth. */
	pid: number;
	/** Human label: agent name (+ step in chains). */
	label: string;
	/** Task text (capped by the writer, not here). */
	task: string;
	model?: string;
	/** Batch mode: single | parallel | chain. */
	mode?: string;
	/** Chain step number (1-based), if part of a chain. */
	step?: number;
	/** Unix ms when the child was spawned. */
	startedAt: number;
	/** Pre-created session JSONL — /trace-able. */
	sessionFile: string;
	/** Session id of the spawner, when known. */
	spawnerSession?: string;
	/** Working directory the child runs in. */
	cwd?: string;
}

/** Stored shape: `{ version, workers: { [id]: RunningWorker } }`. */
interface RunningIndexFile {
	version: number;
	workers: Record<string, RunningWorker>;
}

export function runningIndexPath(sessionsRoot: string): string {
	return join(sessionsRoot, RUNNING_INDEX_NAME);
}

/** Max task length persisted — the index is a status board, not an archive. */
export function capTaskText(task: string, max = 200): string {
	return task.length > max ? `${task.slice(0, max - 1)}…` : task;
}

/** PID liveness check. Signal 0 works on Windows in Node; ESRCH = dead. */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		// EPERM on Windows means "alive but owned by someone else" — alive.
		return code === "EPERM";
	}
}

function readIndexFile(path: string): RunningIndexFile {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as RunningIndexFile;
		if (parsed && parsed.version === RUNNING_INDEX_VERSION && parsed.workers && typeof parsed.workers === "object") {
			return parsed;
		}
	} catch {
		// Missing or corrupt — treat as empty.
	}
	return { version: RUNNING_INDEX_VERSION, workers: {} };
}

function writeIndexFile(path: string, index: RunningIndexFile): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(index));
		renameSync(tmp, path);
	} catch {
		// Best effort: the index is advisory, never fatal.
	}
}

/** Register a live worker. Call right after a successful spawn, with the PID. */
export function addRunningWorker(path: string, worker: RunningWorker): void {
	const index = readIndexFile(path);
	index.workers[worker.id] = { ...worker, task: capTaskText(worker.task) };
	writeIndexFile(path, index);
}

/** Remove a worker record (child exited or failed to spawn). */
export function removeRunningWorker(path: string, id: string): void {
	const index = readIndexFile(path);
	if (!(id in index.workers)) return;
	delete index.workers[id];
	writeIndexFile(path, index);
}

export interface ReadRunningResult {
	/** Live workers, sorted by startedAt. */
	workers: RunningWorker[];
	/** Records dropped because their PID is gone (crashed spawner etc.). */
	reaped: number;
}

/**
 * Read the index, dropping dead entries. Concurrency between spawners is
 * last-writer-wins on reap — harmless: a just-spawned PID is alive, and a dead
 * one gets re-recorded by its own spawner only if it is actually alive.
 */
export function readRunningWorkers(path: string, isAlive: (pid: number) => boolean = isPidAlive): ReadRunningResult {
	if (!existsSync(path)) return { workers: [], reaped: 0 };
	const index = readIndexFile(path);
	let reaped = 0;
	for (const [id, worker] of Object.entries(index.workers)) {
		if (!worker || !isAlive(worker.pid)) {
			delete index.workers[id];
			reaped++;
		}
	}
	if (reaped > 0) writeIndexFile(path, index);
	const workers = Object.values(index.workers).sort((a, b) => a.startedAt - b.startedAt);
	return { workers, reaped };
}
