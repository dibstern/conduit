// Live Codex app-server probe: turn/start while a goal successor is pending, and
// while a native (server-started) successor turn runs.
// Usage: node codex-probe.mjs <outFile> <model|list>
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [outFile, model] = process.argv.slice(2);
// test-waits-allow real-wait: live probes time real provider work; the delays are the experiment.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const frames = [];
const note = (kind, data) => {
	frames.push({ t: Date.now() - t0, kind, data });
	writeFileSync(outFile, JSON.stringify(frames, null, 1));
};
const server = spawn("codex", ["app-server", "--listen", "stdio://"], {
	stdio: ["pipe", "pipe", "ignore"],
});
note("spawned", { pid: server.pid });
let nextId = 1;
const waiting = new Map();
const listeners = [];
let buf = "";
server.stdout.on("data", (b) => {
	buf += b;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		const m = JSON.parse(line);
		if (m.id !== undefined && waiting.has(m.id)) {
			const w = waiting.get(m.id);
			waiting.delete(m.id);
			note("response", {
				id: m.id,
				method: w.method,
				result: slimResult(m.result),
				error: m.error,
			});
			w.resolve(m);
			continue;
		}
		if (m.id !== undefined && m.method) {
			// Server request (approval etc.): decline.
			note("server_request", { method: m.method });
			send({ jsonrpc: "2.0", id: m.id, result: { decision: "decline" } });
			continue;
		}
		const keep =
			!/delta|tokenUsage|rateLimits|mcpServer|settings\/updated|reasoning|account/.test(
				m.method ?? "",
			);
		const itemType = m.params?.item?.type;
		if (
			keep &&
			(!m.method.startsWith("item/") ||
				["userMessage", "agentMessage"].includes(itemType))
		)
			note("notify", { method: m.method, params: slimParams(m.params) });
		for (const l of listeners) l(m);
	}
});
const send = (m) => server.stdin.write(`${JSON.stringify(m)}\n`);
const request = (method, params) =>
	new Promise((resolve) => {
		const id = nextId++;
		waiting.set(id, { method, resolve });
		note("request", {
			id,
			method,
			params:
				method === "turn/start"
					? {
							input: params.input?.[0]?.text,
							clientUserMessageId: params.clientUserMessageId,
						}
					: params,
		});
		send({ jsonrpc: "2.0", id, method, params });
	});
const slimResult = (r) =>
	r?.turn
		? { turn: { id: r.turn.id, status: r.turn.status } }
		: r?.thread
			? { thread: { id: r.thread.id } }
			: r?.goal
				? { goal: { status: r.goal.status } }
				: r?.data
					? { models: r.data.map((d) => d.id ?? d.model) }
					: r;
const slimParams = (p) => {
	if (!p) return p;
	const o = {};
	if (p.turnId !== undefined) o.turnId = p.turnId;
	if (p.turn)
		o.turn = { id: p.turn.id, status: p.turn.status, error: p.turn.error };
	if (p.goal) o.goal = { status: p.goal.status };
	if (p.status) o.status = p.status;
	if (p.item)
		o.item = {
			type: p.item.type,
			text: JSON.stringify(p.item.content ?? p.item.text ?? "").slice(0, 120),
			clientId: p.item.clientUserMessageId ?? p.item.id,
		};
	if (p.message) o.message = String(p.message).slice(0, 160);
	if (p.error) o.error = p.error;
	return o;
};

await request("initialize", {
	clientInfo: { name: "conduit-lane-live", version: "1.0.0", title: null },
	capabilities: { experimentalApi: true },
});
send({ jsonrpc: "2.0", method: "initialized" });
if (model === "list") {
	await request("model/list", {});
	server.kill("SIGTERM");
	process.exit(0);
}
const cwd = mkdtempSync(join(tmpdir(), "lane-live-codex-"));
const config = {
	cwd,
	model,
	approvalPolicy: "untrusted",
	sandboxPolicy: { type: "readOnly" },
	effort: "low",
};
const started = await request("thread/start", { cwd, model });
const threadId = started.result.thread.id;
const objective =
	"Reply with the word one. In a later turn reply with the word two. In a later turn after that reply with the word three, and only then mark the goal complete.";
await request("thread/goal/set", {
	threadId,
	objective,
	status: "paused",
	origin: "user",
});
const ours = new Set();
const turnStart = async (text, clientUserMessageId) => {
	const r = await request("turn/start", {
		threadId,
		clientUserMessageId,
		input: [{ type: "text", text, text_elements: [] }],
		...config,
	});
	if (r.result?.turn?.id) ours.add(r.result.turn.id);
	return r;
};
await turnStart(objective, "u-goal");
await request("thread/goal/set", {
	threadId,
	status: "active",
	origin: "user",
});

let firedPending = false;
let firedWake = false;
let turns = 0;
let done;
const finished = new Promise((r) => (done = r));
listeners.push((m) => {
	if (m.method === "turn/completed") {
		turns++;
		if (!firedPending) {
			firedPending = true;
			note("probe", {
				step: "turn/start right after turn/completed while goal active (successor pending)",
			});
			turnStart("Reply with just the word pong.", "u-pong");
		}
		if (turns >= 6) done("turn cap");
	}
	if (m.method === "turn/started" && firedPending && !firedWake) {
		const id = m.params?.turn?.id;
		setTimeout(() => {
			if (ours.has(id) || firedWake) return;
			firedWake = true;
			note("probe", {
				step: "turn/start while a server-started turn runs",
				nativeTurn: id,
			});
			turnStart("Reply with just the word ping.", "u-ping");
		}, 300);
	}
	if (
		m.method === "thread/goal/updated" &&
		m.params?.goal?.status === "complete"
	)
		setTimeout(() => done("goal complete"), 8000);
});
const why = await Promise.race([
	finished,
	sleep(120_000).then(() => "time cap"),
]);
note("end", { why, turns, ours: [...ours] });
await request("thread/goal/clear", { threadId });
await sleep(1500);
server.kill("SIGTERM");
note("killed", { pid: server.pid });
process.exit(0);
