// Live Cursor probe.
// steer: a steer issued while the run works, and one issued after wait() settles.
// kill-child: run a shell tool that touches a marker; the parent SIGKILLs this process mid-tool.
// Usage: node cursor-probe.mjs <worktree> <outFile> <scenario> <model> [marker]
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [worktree, outFile, scenario, model, marker] = process.argv.slice(2);
// test-waits-allow real-wait: live probes time real provider work; the delays are the experiment.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = createRequire(join(worktree, "package.json"));
const load = async (id) => {
	const m = await import(pathToFileURL(req.resolve(id)).href);
	return m.default ?? m;
};
const sdk = await load("@cursor/sdk");
const { SqliteLocalAgentStore } = await load("@cursor/sdk/sqlite");
const t0 = Date.now();
const frames = [];
const note = (kind, data) => {
	frames.push({ t: Date.now() - t0, kind, data });
	if (kind === "tool_start") console.log("TOOL_START");
	writeFileSync(outFile, JSON.stringify(frames, null, 1));
};
const cwd = mkdtempSync(join(tmpdir(), "lane-live-cursor-"));
const stateRoot = mkdtempSync(join(tmpdir(), "lane-live-cursor-state-"));
const store = await SqliteLocalAgentStore.open({
	workspaceRef: cwd,
	stateRoot,
});
const agent = await sdk.Agent.create({
	apiKey: process.env.CURSOR_API_KEY,
	model: { id: model },
	local: { cwd, store, settingSources: [] },
});
note("agent", { agentId: agent.agentId, pid: process.pid, cwd });

const prompt =
	scenario === "kill-child"
		? `Use your shell tool to run exactly this one command: sleep 8 && touch ${marker} . Then reply with the single word done.`
		: "Use your shell tool to run exactly: sleep 5 . Then reply with the single word done.";
let toolSeen = false;
let steered = false;
let run;
const onDelta = ({ update }) => {
	const slim = { type: update?.type };
	for (const k of ["name", "toolName", "callId", "status", "text"])
		if (update?.[k] !== undefined) slim[k] = String(update[k]).slice(0, 80);
	note("delta", slim);
	if (scenario === "steer-late" && !steered && update?.type === "turn-ended") {
		steered = true;
		note("steer1_call", { runStatus: run?.status });
		run
			.steer("Also reply with the word bravo.")
			.then((o) =>
				note("steer1_outcome", { outcome: o, runStatus: run.status }),
			)
			.catch((e) => note("steer1_error", String(e)));
	}
	if (!toolSeen && /tool/i.test(String(update?.type))) {
		toolSeen = true;
		note("tool_start", slim);
		if (scenario === "steer" && run && !steered) {
			steered = true;
			note("steer1_call", {});
			run
				.steer("Also reply with the word bravo.")
				.then((o) =>
					note("steer1_outcome", { outcome: o, runStatus: run.status }),
				)
				.catch((e) => note("steer1_error", String(e)));
		}
	}
};
run = await agent.send(prompt, { model: { id: model }, onDelta });
note("sent", {
	runId: run.id,
	supportsSteer: typeof run.steer,
	status: run.status,
});
run.onDidChangeStatus((s) => note("status", s));
(async () => {
	try {
		for await (const m of run.stream())
			note("stream", { type: m.type, subtype: m.subtype, status: m.status });
		note("stream_end", {});
	} catch (e) {
		note("stream_error", String(e));
	}
})();

const result = await run.wait();
note("wait_settled", {
	status: result.status,
	result: result.result,
	error: result.error,
	steered,
});

if (scenario.startsWith("steer")) {
	await sleep(3000);
	note("steer2_call", { runStatus: run.status });
	await run
		.steer("Reply with the single word charlie.")
		.then((o) => note("steer2_outcome", { outcome: o, runStatus: run.status }))
		.catch((e) => note("steer2_error", String(e)));
	await sleep(15_000);
	const meta = await store.agents
		.get({ agentId: agent.agentId })
		.catch((e) => String(e));
	note("after", {
		activeRunId: meta?.activeRunId,
		runStatus: run.status,
		conversation: await run
			.conversation()
			.then((c) => c.length)
			.catch((e) => String(e)),
	});
}
await store.dispose?.();
process.exit(0);
