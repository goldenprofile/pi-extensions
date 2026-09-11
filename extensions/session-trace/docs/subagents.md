# Subagent integration

session-trace renders subagent activity as child cards linked to the parent
session — in the TUI timeline and as child tags in the web viewer.

A child card appears for every custom entry of type `session-trace:subagents`
in the parent session:

```json
{"type":"custom","customType":"session-trace:subagents",
 "data":{"agent":"scout","task":"…","session":"<path>","usage":{"input":8312,"output":7,"cost":0.0006},"model":"glm-5.3-flash"}}
```

Entries recorded under the former name `pitrace:subagents` are still
recognized, so sessions from before the rename keep rendering.

## Who writes these entries

The [subagents extension](../../subagents/) from this repository appends them
automatically — no patching of anything required:

- **`subagent`** (interactive, WezTerm pane) — the parent's watcher appends one
  entry when the child finishes, with summary usage and model extracted from
  the child transcript;
- **`task_batch`** (headless batch) — one entry per child, right after it
  exits.

Child transcripts live under `~/.pi/agent/sessions/subagents/`: pane-based
children get an explicit `--session <file>` chosen by the parent at spawn;
batch children get a pre-created session file before the process starts.

Payload fields consumed by session-trace:

| Field | Meaning |
|---|---|
| `agent` | Agent name (card header) |
| `task` | Task text (truncated to one line) |
| `session` | Path to the child session JSONL — the card links to `/trace <session>` |
| `model` | Optional; model the child ran on |
| `usage.output` | Optional; output tokens shown on the card |
| `usage.cost` | Optional; cost shown on the card |

All fields except `session` are optional; the card is skipped without it.

## History

Earlier this integration required patching the official subagent example from
pi-mono (`examples/extensions/subagent`): upstream spawned children with
`--no-session`, so there was nothing to link. A patched copy used to live in
this extension's `vendor/subagent-index.ts` (see git history), and a further-
modified fork of it was installed at `~/.pi/agent/extensions/subagent/`,
writing entries under the old `pitrace:subagents` name.

Both are gone now: the first-party `subagents` extension covers the same
ground natively and writes the current entry name. Nothing to install, nothing
to patch.
