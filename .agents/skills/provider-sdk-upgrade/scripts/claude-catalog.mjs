// Print the model catalog and bundled Claude Code version a Claude Agent SDK
// build advertises, using the caller's real login.
// Usage: node claude-catalog.mjs <path to that SDK's sdk.mjs>
const { query } = await import(process.argv[2]);
const q = query({
	prompt: (async function* () {})(),
	options: { cwd: "/tmp" },
});
const init = await q.initializationResult();
console.log(
	JSON.stringify({
		claudeCodeVersion: init.claude_code_version ?? null,
		models: init.models.map((model) => model.value),
	}),
);
process.exit(0);
