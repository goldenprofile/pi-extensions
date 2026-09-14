/**
 * Agent definition discovery.
 *
 * Agents are markdown files with frontmatter, loaded from:
 *   - `<cwd>/.pi/agents/*.md`   (project — highest priority)
 *   - `<globalDir>/agents/*.md` (user-global)
 *
 * A project agent with the same name overrides a global one. There are no
 * bundled agents: this extension is an orchestrator, the agent pool is the
 * user's own.
 *
 * Frontmatter keys understood by this extension:
 *   name, description, model, thinking, tools (comma list),
 *   subagents (comma list — agents this agent may spawn), auto-exit (bool)
 *
 * Anything after the frontmatter is the agent identity and is appended to the
 * child's system prompt via --append-system-prompt.
 *
 * Deliberately dependency-free (no pi imports) so tests can run standalone.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface AgentDef {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	subagents?: string[];
	/** Default true — autonomous agents report back via steer messages. */
	autoExit: boolean;
	/** Markdown body: the agent identity appended to the system prompt. */
	body: string;
	/** Non-fatal definition problems (unknown frontmatter keys, etc.). */
	warnings: string[];
	scope: "project" | "global";
	path: string;
}

/**
 * Parse `---\nkey: value\n---\nbody` frontmatter. Minimal YAML subset:
 * one `key: value` per line, values may be single/double-quoted or bare,
 * comma-separated values become lists. `\r\n` normalized to `\n` first.
 */
/** Frontmatter keys this extension understands; anything else is a warning. */
const KNOWN_KEYS = new Set(["name", "description", "model", "thinking", "tools", "subagents", "auto-exit"]);

export function parseAgentMarkdown(raw: string, fallbackName: string): AgentDef {
	const normalized = raw.replace(/\r\n/g, "\n");
	const attrs: Record<string, string> = {};
	let body = normalized;

	if (normalized.startsWith("---\n")) {
		const end = normalized.indexOf("\n---", 4);
		if (end !== -1) {
			const header = normalized.slice(4, end);
			body = normalized.slice(end + 4).replace(/^\n+/, "");
			for (const line of header.split("\n")) {
				const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
				if (!match) continue;
				const key = (match[1] ?? "").toLowerCase();
				let value = (match[2] ?? "").trim();
				if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
					value = value.slice(1, -1);
				}
				if (key) attrs[key] = value;
			}
		}
	}

	const name = attrs["name"]?.trim() || fallbackName;
	const warnings: string[] = [];
	for (const key of Object.keys(attrs)) {
		if (!KNOWN_KEYS.has(key)) warnings.push(`unknown frontmatter key "${key}"`);
	}
	const list = (key: string): string[] | undefined => {
		const raw = attrs[key]?.trim();
		if (!raw) return undefined;
		const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
		return items.length > 0 ? items : undefined;
	};

	return {
		name,
		description: attrs["description"]?.trim() ?? "",
		model: attrs["model"]?.trim() || undefined,
		thinking: attrs["thinking"]?.trim() || undefined,
		tools: list("tools"),
		subagents: list("subagents"),
		autoExit: attrs["auto-exit"]?.trim().toLowerCase() !== "false",
		body: body.trim(),
		warnings,
		scope: "global",
		path: "",
	};
}

function loadDir(dir: string, scope: "project" | "global", into: Map<string, AgentDef>): void {
	if (!existsSync(dir)) return;
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return;
	}
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		const path = join(dir, file);
		try {
			const def = parseAgentMarkdown(readFileSync(path, "utf8"), basename(file, ".md"));
			def.scope = scope;
			def.path = path;
			into.set(def.name, def);
		} catch {
			// Unreadable agent file — skip, never break discovery.
		}
	}
}

/**
 * Discover agents. Project agents (from `join(cwd, ".pi", "agents")`) override
 * global ones with the same name.
 */
export function discoverAgents(cwd: string, globalAgentDir: string): Map<string, AgentDef> {
	const defs = new Map<string, AgentDef>();
	loadDir(join(globalAgentDir, "agents"), "global", defs);
	loadDir(join(cwd, ".pi", "agents"), "project", defs);
	return defs;
}
