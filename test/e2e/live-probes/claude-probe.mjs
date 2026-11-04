// Live Claude probe: session_state_changed emission and interrupt still_queued follow-up.
// Usage: node claude-probe.mjs <worktree> <outFile> <emit:0|1> <scenario:interrupt|wake|inner>
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [worktree, outFile, emit, scenario] = process.argv.slice(2);
// test-waits-allow real-wait: live probes time real provider work; the delays are the experiment.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { query } = await import(
	join(worktree, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs")
);
const t0 = Date.now();
const frames = [];
const note = (kind, data) => frames.push({ t: Date.now() - t0, kind, data });

const pending = [];
let wake;
let closed = false;
async function* input() {
	while (!closed) {
		if (pending.length) yield pending.shift();
		else await new Promise((r) => (wake = r));
	}
}
const push = (uuid, text) => {
	note("sent", { uuid, text });
	pending.push({
		type: "user",
		uuid,
		session_id: "",
		parent_tool_use_id: null,
		message: { role: "user", content: text },
	});
	wake?.();
};
const close = () => {
	closed = true;
	wake?.();
};

const env = {
	...process.env,
	CLAUDE_AGENT_SDK_CLIENT_APP: "conduit",
	CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "false",
	ENABLE_CLAUDEAI_MCP_SERVERS: "false",
};
if (emit === "1") env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = "1";
else delete env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS;

const cwd = mkdtempSync(join(tmpdir(), "lane-live-claude-"));
const q = query({
	prompt: input(),
	options: {
		cwd,
		model: "haiku",
		env,
		settingSources: [],
		tools: ["Bash"],
		allowedTools: ["Bash"],
		persistSession: false,
		includePartialMessages: false,
	},
});

let fired = false;
const deadline = setTimeout(() => {
	note("probe_timeout", {});
	close();
	q.close?.();
}, 120_000);
let quiet;
const armQuiet = () => {
	clearTimeout(quiet);
	quiet = setTimeout(
		() => {
			note("quiet_close", {});
			close();
			q.close?.();
		},
		scenario !== "interrupt" ? 25_000 : 12_000,
	);
};

if (scenario === "inner") {
	push(
		"ua",
		"First use the Bash tool with run_in_background set to true to run exactly: sleep 2. Then use the Bash tool in the foreground (not background) to run exactly: sleep 8. Then reply with the single word done.",
	);
} else if (scenario === "wake") {
	push(
		"ua",
		"Use the Bash tool with run_in_background set to true to run exactly: sleep 4. Do not wait for it. Reply with the single word started.",
	);
} else {
	push(
		"ua",
		"Use the Bash tool to run exactly: sleep 10. Then reply with the single word done.",
	);
}

try {
	for await (const m of q) {
		const slim =
			m.type === "assistant"
				? {
						type: m.type,
						uuid: m.uuid,
						content: m.message?.content?.map((c) =>
							c.type === "text"
								? { type: "text", text: c.text }
								: { type: c.type, name: c.name, input: c.input },
						),
					}
				: m.type === "system" && m.subtype === "init"
					? {
							type: m.type,
							subtype: m.subtype,
							model: m.model,
							capabilities: m.capabilities,
							claude_code_version: m.claude_code_version,
						}
					: m;
		note("frame", slim);
		if (
			scenario === "interrupt" &&
			!fired &&
			m.type === "assistant" &&
			m.message?.content?.some((c) => c.type === "tool_use")
		) {
			fired = true;
			push("ub", "Reply with the single word bravo.");
			push("uc", "Reply with the single word charlie.");
			await sleep(1500);
			note("interrupt_call", {});
			const receipt = await q.interrupt().catch((e) => ({ error: String(e) }));
			note("interrupt_receipt", receipt ?? null);
		}
		if (m.type === "result") armQuiet();
	}
} catch (e) {
	note("iter_error", String(e));
}
clearTimeout(deadline);
clearTimeout(quiet);
writeFileSync(outFile, JSON.stringify(frames, null, 1));
console.log(`frames=${frames.length} -> ${outFile}`);
process.exit(0);
