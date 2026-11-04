// Live OpenCode probe: do prompt_async and abort still run when the client
// drops the HTTP request right after sending it (before any response)?
// Usage: node opencode-probe.mjs <outFile>
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [outFile] = process.argv.slice(2);
const t0 = Date.now();
const log = [];
const note = (kind, data) => {
	log.push({ t: Date.now() - t0, kind, data });
	writeFileSync(outFile, JSON.stringify(log, null, 1));
};
// test-waits-allow real-wait: live probes time real provider work; the delays are the experiment.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((resolve) => {
	const s = createServer().listen(0, () => {
		const p = s.address().port;
		s.close(() => resolve(p));
	});
});
const dir = mkdtempSync(join(tmpdir(), "lane-live-opencode-"));
const proc = spawn("opencode", ["serve", "--port", String(port)], {
	cwd: dir,
	env: {
		...process.env,
		XDG_DATA_HOME: dir,
		XDG_CONFIG_HOME: join(dir, "config"),
		OPENCODE_SERVER_PASSWORD: "",
		OPENCODE_CONFIG_CONTENT: JSON.stringify({
			model: "opencode/big-pickle",
			permission: { bash: "allow" },
		}),
	},
	stdio: "ignore",
});
note("spawned", { pid: proc.pid, port });
const base = `http://localhost:${port}`;
for (let i = 0; i < 150; i++) {
	try {
		if ((await fetch(`${base}/global/health`)).ok) break;
	} catch {}
	await sleep(200);
}
const api = async (method, path, body) => {
	const r = await fetch(`${base}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await r.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};
// Send the full request, then destroy the socket once it is flushed, before any response.
const fireAndDrop = (path, body) =>
	new Promise((resolve) => {
		const payload = JSON.stringify(body ?? {});
		const req = http.request(`${base}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(payload),
			},
		});
		let responded = false;
		req.on("response", () => (responded = true));
		req.on("error", () => {});
		req.end(payload, () => {
			req.destroy();
			resolve({ respondedBeforeDrop: responded });
		});
	});
const summary = (msgs) =>
	(Array.isArray(msgs) ? msgs : []).map((m) => ({
		role: m.info?.role,
		error: m.info?.error?.name,
		finished: !!m.info?.time?.completed,
		parts: m.parts?.map((p) =>
			p.type === "text"
				? `text:${p.text.slice(0, 40)}`
				: p.type === "tool"
					? `tool:${p.tool}:${p.state?.status}`
					: p.type,
		),
	}));
const statusOf = async (id) =>
	(await api("GET", "/session/status"))?.[id] ?? { type: "idle(omitted)" };

try {
	// A: prompt_async with the client gone.
	const a = await api("POST", "/session", {});
	note("session_a", { id: a.id });
	note(
		"prompt_async_dropped",
		await fireAndDrop(`/session/${a.id}/prompt_async`, {
			parts: [{ type: "text", text: "Reply with just the word pong." }],
		}),
	);
	// An immediate probe: is the input absent right after the drop, and present later?
	for (const wait of [0, 10, 25, 50, 100, 250]) {
		await sleep(wait);
		const msgs = summary(await api("GET", `/session/${a.id}/message`));
		note("early_probe_a", {
			afterMs: wait,
			userPresent: msgs.some((m) => m.role === "user"),
			status: await statusOf(a.id),
		});
	}
	for (let i = 0; i < 60; i++) {
		await sleep(1000);
		const msgs = summary(await api("GET", `/session/${a.id}/message`));
		const st = await statusOf(a.id);
		if (i % 5 === 0 || msgs.some((m) => m.role === "assistant" && m.finished))
			note("poll_a", { i, status: st, msgs });
		if (
			msgs.some((m) => m.role === "assistant" && m.finished) &&
			st.type !== "busy"
		)
			break;
	}

	// B: abort with the client gone, while a bash tool runs.
	const b = await api("POST", "/session", {});
	note("session_b", { id: b.id });
	await api("POST", `/session/${b.id}/prompt_async`, {
		parts: [
			{
				type: "text",
				text: "Use the bash tool to run exactly: sleep 25 . Then reply with the single word done.",
			},
		],
	});
	let running = false;
	for (let i = 0; i < 90 && !running; i++) {
		await sleep(500);
		running = summary(await api("GET", `/session/${b.id}/message`)).some((m) =>
			m.parts?.some((p) => p === "tool:bash:running"),
		);
	}
	note("bash_running", { running, status: await statusOf(b.id) });
	const abortAt = Date.now() - t0;
	note("abort_dropped", await fireAndDrop(`/session/${b.id}/abort`, {}));
	for (let i = 0; i < 20; i++) {
		await sleep(1000);
		const st = await statusOf(b.id);
		const msgs = summary(await api("GET", `/session/${b.id}/message`));
		note("poll_b", {
			sinceAbortMs: Date.now() - t0 - abortAt,
			status: st,
			msgs: msgs.filter((m) => m.role === "assistant"),
		});
		if (st.type !== "busy" && i >= 2) break;
	}
} catch (e) {
	note("error", String(e));
}
proc.kill("SIGTERM");
note("killed", { pid: proc.pid });
await sleep(500);
process.exit(0);
