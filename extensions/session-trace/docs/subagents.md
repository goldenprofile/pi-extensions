# Subagent integration

session-trace renders subagent activity as child cards linked to the parent session.
This requires a small patch to the official
[subagent extension example](https://github.com/earendil-works/pi-mono) shipped with pi,
because upstream runs children with `--no-session` (nothing to link to).

## What the patch does

1. **Persist child sessions.** Upstream spawns each subagent as
   `pi --mode json -p --no-session …`. The patch replaces `--no-session` with an
   explicit `--session <path>` pointing at a pre-created file under
   `~/.pi/agent/sessions/subagents/`, so the parent knows the path in advance
   and every child leaves a transcript session-trace can render.
2. **Record the link in the parent session.** After a child finishes, the
   extension appends a custom entry to the parent session:

   ```json
   {"type":"custom","customType":"session-trace:subagents",
    "data":{"agent":"scout","task":"…","session":"<path>","usage":{…},"model":"…"}}
   ```

session-trace reads these entries and draws child cards in the timeline (TUI) and
child tags under the anchor node (web). Entries recorded under the extension's
former name (`pitrace:subagents`) are still recognized.

## Applying it

If you installed the subagent example as-is, apply the diff below to
`~/.pi/agent/extensions/subagent/index.ts` — or just copy the patched
`index.ts` from this extension's `vendor/subagent-index.ts` (the change is three edits):

```diff
+import { randomUUID } from "node:crypto";

+let recordChild: ((r: SingleResult) => void) | null = null;

 export default function (pi: ExtensionAPI) {
+  recordChild = (r) => {
+    if (!r.sessionPath) return;
+    try {
+      pi.appendEntry("session-trace:subagents", {
+        agent: r.agent, task: r.task, session: r.sessionPath,
+        usage: r.usage, model: r.model,
+      });
+    } catch { /* optional */ }
+  };

 interface SingleResult {
   …
+  sessionPath?: string;
 }

-  const args: string[] = ["--mode", "json", "-p", "--no-session"];
+  const sessionsRoot = path.join(getAgentDir(), "sessions", "subagents");
+  fs.mkdirSync(sessionsRoot, { recursive: true });
+  const childSession = path.join(sessionsRoot,
+    `${new Date().toISOString().replace(/[:.]/g, "-")}_${agentName.replace(/[^\w-]/g, "")}.jsonl`);
+  fs.writeFileSync(childSession, JSON.stringify({
+    type: "session", version: 3, id: randomUUID(),
+    timestamp: new Date().toISOString(), cwd: process.cwd(),
+  }) + "\n");
+  args.push("--session", childSession);

   …in currentResult initializer:
+  sessionPath: childSession,

   …before `return currentResult`:
+  recordChild?.(currentResult);
```

Without the patch session-trace still works — you just get a plain `subagent` chip in
the parent session and no child cards/files.
