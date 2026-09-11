import assert from "node:assert/strict";
import { test } from "node:test";
import { renderLauncherPs1 } from "../launcher.ts";

function baseSpec(overrides: Partial<Parameters<typeof renderLauncherPs1>[0]> = {}) {
	return {
		name: "scout",
		id: "scout-abc123",
		piPath: "C:\\Users\\Ivan\\AppData\\Roaming\\npm\\pi.cmd",
		sessionFile: "C:\\pi\\sessions\\subagents\\2026.jsonl",
		extensionPaths: ["C:\\ext\\subagent-done.ts"],
		noExtensions: false,
		taskFile: "C:\\artifacts\\context\\scout.md",
		doneFile: "C:\\pi\\sessions\\subagents\\2026.jsonl.done",
		env: { PI_SUBAGENT_NAME: "scout", PI_SUBAGENT_ID: "scout-abc123" },
		...overrides,
	};
}

test("renderLauncherPs1: env, cd, pi invocation, sentinel, done sidecar", () => {
	const ps1 = renderLauncherPs1(
		baseSpec({ cwd: "D:\\Projects\\demo", model: "zai/glm-5.3-flash" }),
	);
	assert.match(ps1, /\$env:PI_SUBAGENT_NAME = 'scout'/);
	assert.match(ps1, /\$env:PI_SUBAGENT_ID = 'scout-abc123'/);
	assert.match(ps1, /Set-Location -LiteralPath 'D:\\Projects\\demo'/);
	assert.match(ps1, /--session 'C:\\pi\\sessions\\subagents\\2026\.jsonl'/);
	assert.match(ps1, /-e 'C:\\ext\\subagent-done\.ts'/);
	assert.match(ps1, /--model 'zai\/glm-5\.3-flash'/);
	assert.match(ps1, /& 'C:\\Users\\Ivan\\AppData\\Roaming\\npm\\pi\.cmd' --session/);
	assert.match(ps1, /'@C:\\artifacts\\context\\scout\.md'/);
	assert.match(ps1, /Write-Host "__SUBAGENT_DONE_\$\{code\}__"/);
	assert.match(ps1, /Set-Content -LiteralPath '.*\.done' -Value \$code -NoNewline/);
});

test("renderLauncherPs1: tool allowlist adds --tools and -ne", () => {
	const ps1 = renderLauncherPs1(baseSpec({ tools: ["read", "grep"], noExtensions: true }));
	assert.match(ps1, /--tools 'read,grep'/);
	assert.match(ps1, /(^|\s)-ne(\s|$)/);
});

test("renderLauncherPs1: no allowlist → no -ne", () => {
	const ps1 = renderLauncherPs1(baseSpec());
	assert.doesNotMatch(ps1, /(^|\s)-ne(\s|$)/);
});

test("renderLauncherPs1: quotes are escaped for PowerShell", () => {
	const ps1 = renderLauncherPs1(
		baseSpec({ appendSystemPromptFile: "C:\\artifacts\\context\\scout.identity.md" }),
	);
	assert.match(ps1, /--append-system-prompt 'C:\\artifacts\\context\\scout\.identity\.md'/);
});

test("renderLauncherPs1: multiline text never reaches the command line", () => {
	// Regression: pi.cmd (cmd.exe) truncates the command line at the first
	// newline — inline multi-line prompt text amputates every later argument.
	const ps1 = renderLauncherPs1(baseSpec());
	for (const line of ps1.split("\r\n")) {
		if (line.startsWith("& ")) {
			const quotes = (line.match(/'/g) ?? []).length;
			assert.equal(quotes % 2, 0, `unbalanced quotes on invocation line: ${line}`);
		}
	}
});

test("renderLauncherPs1: identity without quotes stays unquoted-safe", () => {
	const ps1 = renderLauncherPs1(baseSpec({ thinking: "high" }));
	assert.match(ps1, /--thinking 'high'/);
});

test("renderLauncherPs1: exclude tools", () => {
	const ps1 = renderLauncherPs1(baseSpec({ excludeTools: ["bash", "write"] }));
	assert.match(ps1, /-xt 'bash,write'/);
});
