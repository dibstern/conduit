// Failure cases: a marked agent's dev server never reaches the browser, reaches it before the
// hold, carries the wrong port or pid, lingers in the browser after it exits, or its evidence
// is not a server_seen then a server_gone naming the same ServerKey (CONTRACT.md 8.7).
// Auto-settle: an overdue session settles before the first scan and hold have passed, settles
// while its server is live, or never settles once the server is gone.
// Ended sessions: a settled session's server lives on, waits out the hold, survives a restart or a
// later start, dies only by SIGKILL, takes its agent with it, or another daemon's marked server is
// killed; a deleted session's server lives on or records a server_gone.
// Stop: it kills the agent's shell along with a server started with & (one process group), misses
// a server that ignores SIGTERM, kills a pid whose start time no longer matches, or is remembered
// across a daemon crash so the server leaves the list or a second Stop does nothing.
// Task link: a server writing to a Claude background task's output file is not linked to the task,
// the task does not read calm while it serves, or the task leaves with the server.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const HOLD_MS = 600;
const ENVIRONMENT = {
	CONDUIT_PORT_WATCH_INTERVAL_MS: "200",
	CONDUIT_PORT_WATCH_HOLD_MS: String(HOLD_MS),
	CONDUIT_AUTO_SETTLE_SWEEP_INTERVAL_MS: "200",
};
const ARTIFACT_DIR = "test/integration/daemon/artifacts";
const SERVER = `const server = require("node:http").createServer((_, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () =>
	console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));`;

let harness: ProcessHarness | undefined;
const agents: ChildProcess[] = [];

// The fake agent is a shell marked with the session; the server is its background child. The
// shell outlives the server, reporting the server's exit status, as an agent outlives a Stop.
const startAgent = async (sessionId: string, server = SERVER) => {
	const agent = spawn(
		"/bin/sh",
		["-c", 'node -e "$SERVER" & wait $!; echo "{\\"exit\\":$?}"; sleep 60'],
		{
			env: { ...process.env, SERVER: server, CONDUIT_SESSION_ID: sessionId },
			stdio: ["ignore", "pipe", "inherit"],
			detached: true,
		},
	);
	agents.push(agent);
	const output = createInterface({ input: agent.stdout ?? process.stdin });
	// Each output line is a JSON object. An agent reaped by afterEach ends with no exit line.
	const lineWith = (key: string) =>
		new Promise<Record<string, number> | undefined>((resolve) => {
			output.on("line", (line) => {
				const fields: Record<string, number> = JSON.parse(line);
				if (key in fields) resolve(fields);
			});
			output.once("close", () => resolve(undefined));
		});
	const exited = lineWith("exit").then((line) => line?.["exit"]);
	const termed = lineWith("term");
	const { pid = 0, port = 0 } =
		(await lineWith("port")) ?? expect.fail("the server never listened");
	return { agent, pid, port, exited, termed };
};
const alive = (pid: number) => {
	try {
		return process.kill(pid, 0);
	} catch {
		return false;
	}
};

afterEach(async () => {
	// Each agent leads its own process group, so this also reaps a server it left behind.
	for (const agent of agents.splice(0))
		if (agent.pid !== undefined && agent.exitCode === null)
			process.kill(-agent.pid, "SIGKILL");
	await harness?.dispose();
	harness = undefined;
});

it("a marked agent's real node server reaches the browser after the hold and leaves when it exits", async () => {
	harness = ProcessHarness.create({ logLevel: "warn" });
	await harness.restart({ serviceEnvironment: ENVIRONMENT });
	const browser = await harness.connect();
	await browser.followSessions();
	const sessionId = await browser.createSession("Servers");
	const { pid, port } = await startAgent(sessionId);
	const listening = performance.now();

	const rowsOf = (frame: Record<string, unknown>) =>
		frame["type"] === "session_row" && frame["id"] === sessionId
			? ((frame["servers"] ?? []) as readonly { port: number; pid: number }[])
			: undefined;
	const seen = await browser.waitFor(
		(frame) => rowsOf(frame)?.some((server) => server.port === port) ?? false,
	);
	expect(performance.now() - listening).toBeGreaterThanOrEqual(HOLD_MS);
	expect(rowsOf(seen)).toEqual([
		expect.objectContaining({ port, pid, source: "detected", role: "serving" }),
	]);

	const cursor = browser.frames.length;
	process.kill(pid, "SIGTERM");
	const gone = await browser.waitFor(
		(frame) => rowsOf(frame)?.length === 0,
		cursor,
	);
	expect(gone["servers"]).toBeUndefined();

	const db = new Database(harness.daemonStorePath(), { readonly: true });
	const events = db
		.prepare<[string], { type: string; data: string }>(
			"SELECT type, data FROM events WHERE session_id = ? ORDER BY sequence",
		)
		.all(sessionId)
		.map((event) => ({ type: event.type, data: JSON.parse(event.data) }));
	db.close();
	const evidence = events.filter((event) =>
		event.type.startsWith("evidence.server_"),
	);
	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		`${ARTIFACT_DIR}/real-server.json`,
		JSON.stringify(
			{ sessionId, pid, port, pushed: [seen, gone], events },
			null,
			2,
		),
	);
	expect(evidence.map((event) => event.type)).toEqual([
		"evidence.server_seen",
		"evidence.server_gone",
	]);
	expect(evidence[1]?.data.server).toEqual(evidence[0]?.data.server);
	expect(evidence[0]?.data.server).toMatchObject({ pid, port });
});

it("an overdue session waits for the first scan and hold, stays open while its server lives, and settles once it is gone", async () => {
	harness = ProcessHarness.create({ logLevel: "warn" });
	await harness.restart({ serviceEnvironment: ENVIRONMENT });
	const browser = await harness.connect();
	const quiet = await browser.createSession("Quiet");
	const serving = await browser.createSession("Serving");
	await harness.shutdown();

	// Both sessions went idle a month ago; one left a server running while the daemon was down.
	const store = new Database(harness.daemonStorePath());
	store
		.prepare(
			"UPDATE sessions SET last_message_at = ? WHERE id IN (SELECT value FROM json_each(?))",
		)
		.run(Date.now() - 30 * 86_400_000, JSON.stringify([quiet, serving]));
	store.close();
	const { pid } = await startAgent(serving);
	await harness.restart({ serviceEnvironment: ENVIRONMENT });
	// A list reader only: opening a session's detail would make it viewed, which holds it open.
	const watcher = await harness.connect(
		undefined,
		undefined,
		"process-test",
		false,
	);
	await watcher.followSessions();
	const settles = (sessionId: string) => (frame: Record<string, unknown>) =>
		frame["type"] === "session_row" &&
		frame["id"] === sessionId &&
		frame["settledAt"] !== undefined;

	const db = new Database(harness.daemonStorePath(), { readonly: true });
	const events = () =>
		db
			.prepare<[string], { session_id: string; type: string }>(
				`SELECT session_id, type FROM events
					WHERE session_id IN (SELECT value FROM json_each(?))
					AND (type = 'session.settled' OR type LIKE 'evidence.server_%')
					ORDER BY sequence`,
			)
			.all(JSON.stringify([quiet, serving]));
	try {
		// The quiet session settling proves a sweep ran once servers were known: the same scan
		// that ends the first hold records the serving session's server.
		await watcher.waitFor(settles(quiet));
		expect(
			events().map(
				({ session_id, type }) =>
					`${session_id === quiet ? "quiet" : "serving"} ${type}`,
			),
		).toEqual(["serving evidence.server_seen", "quiet session.settled"]);

		const cursor = watcher.frames.length;
		process.kill(pid, "SIGTERM");
		await watcher.waitFor(settles(serving), cursor);
		const trail = events().filter((event) => event.session_id === serving);
		expect(trail.map((event) => event.type)).toEqual([
			"evidence.server_seen",
			"evidence.server_gone",
			"session.settled",
		]);
		mkdirSync(ARTIFACT_DIR, { recursive: true });
		writeFileSync(
			`${ARTIFACT_DIR}/auto-settle-waits.json`,
			JSON.stringify({ quiet, serving, events: events() }, null, 2),
		);
	} finally {
		db.close();
	}
});

it("settling kills the session's servers without the hold, now, after a restart and when started later, and spares the agent and another daemon's server", async () => {
	// A hold the kills must beat: an ended session's servers skip it.
	const hold = 3000;
	const environment = {
		...ENVIRONMENT,
		CONDUIT_PORT_WATCH_HOLD_MS: String(hold),
	};
	harness = ProcessHarness.create({ logLevel: "warn" });
	await harness.restart({ serviceEnvironment: environment });
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Settled");
	// A marker this daemon cannot resolve belongs to someone else: it is never read as ended.
	const stranger = await startAgent("another-daemons-session");
	const first = await startAgent(sessionId);
	const settled = performance.now();
	await browser.setSettled(sessionId, true);
	// 143 is SIGTERM: the server went before the 5s SIGKILL.
	expect(await first.exited).toBe(143);
	const firstKilledMs = performance.now() - settled;
	expect(firstKilledMs).toBeLessThan(hold);
	expect(first.agent.pid !== undefined && alive(first.agent.pid)).toBe(true);

	const started = performance.now();
	const later = await startAgent(sessionId);
	expect(await later.exited).toBe(143);
	const laterKilledMs = performance.now() - started;
	expect(laterKilledMs).toBeLessThan(hold);

	await harness.shutdown();
	const whileDown = await startAgent(sessionId);
	await harness.restart({ serviceEnvironment: environment });
	expect(await whileDown.exited).toBe(143);
	expect(alive(stranger.pid)).toBe(true);

	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		`${ARTIFACT_DIR}/ended-session-kills.json`,
		JSON.stringify(
			{
				sessionId,
				holdMs: hold,
				firstKilledMs,
				laterKilledMs,
				exits: [143, 143, 143],
				strangerAlive: alive(stranger.pid),
			},
			null,
			2,
		),
	);
});

it("deleting a session kills its server and records no server_gone for it", async () => {
	harness = ProcessHarness.create({ logLevel: "warn" });
	await harness.restart({ serviceEnvironment: ENVIRONMENT });
	const browser = await harness.connect();
	await browser.followSessions();
	const deleted = await browser.createSession("Deleted");
	const probe = await browser.createSession("Probe");
	const serving =
		(sessionId: string, port: number) => (frame: Record<string, unknown>) =>
			frame["type"] === "session_row" &&
			frame["id"] === sessionId &&
			((frame["servers"] ?? []) as readonly { port: number }[]).some(
				(server) => server.port === port,
			);
	const doomed = await startAgent(deleted);
	await browser.waitFor(serving(deleted, doomed.port));
	await browser.deleteSession(deleted);
	expect(await doomed.exited).toBe(143);
	// A server first seen after the kill proves scans ran after it: one would have recorded the
	// deleted session's server_gone.
	const cursor = browser.frames.length;
	const witness = await startAgent(probe);
	await browser.waitFor(serving(probe, witness.port), cursor);

	const db = new Database(harness.daemonStorePath(), { readonly: true });
	const types = db
		.prepare<[string], { type: string }>(
			"SELECT type FROM events WHERE session_id = ? AND (type = 'session.deleted' OR type LIKE 'evidence.server_%') ORDER BY sequence",
		)
		.all(deleted)
		.map(({ type }) => type);
	db.close();
	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		`${ARTIFACT_DIR}/deleted-session-kill.json`,
		JSON.stringify({ deleted, port: doomed.port, types }, null, 2),
	);
	// Deletion keeps only the session.deleted event; nothing may follow it.
	expect(types).toEqual(["session.deleted"]);
});

type Listed = { pid: number; startedAt: number; port: number };
const listedOn =
	(sessionId: string, port: number) => (frame: Record<string, unknown>) =>
		frame["type"] === "session_row" && frame["id"] === sessionId
			? ((frame["servers"] ?? []) as readonly Listed[]).find(
					(server) => server.port === port,
				)
			: undefined;
const keyOf = ({ pid, startedAt, port }: Listed) => ({ pid, startedAt, port });

it("Stop kills a server started with & from a non-interactive shell and leaves the shell; a stale Stop kills nothing", async () => {
	harness = ProcessHarness.create({ logLevel: "warn" });
	await harness.restart({ serviceEnvironment: ENVIRONMENT });
	const browser = await harness.connect();
	await browser.followSessions();
	const sessionId = await browser.createSession("Stop");
	const { agent, pid, port, exited } = await startAgent(sessionId);
	const listed = listedOn(sessionId, port);
	const server = keyOf(
		listed(await browser.waitFor((frame) => listed(frame) !== undefined)) ??
			expect.fail("no listed server"),
	);
	expect(server.pid).toBe(pid);

	// The pid now names a process started at another time, as after pid reuse.
	await browser.stopServer(sessionId, {
		...server,
		startedAt: server.startedAt - 1000,
	});
	expect(alive(pid)).toBe(true);

	const cursor = browser.frames.length;
	const stopping = performance.now();
	await browser.stopServer(sessionId, server);
	expect(await exited).toBe(143);
	const stopMs = performance.now() - stopping;
	expect(agent.pid !== undefined && alive(agent.pid)).toBe(true);
	await browser.waitFor(
		(frame) =>
			frame["type"] === "session_row" &&
			frame["id"] === sessionId &&
			frame["servers"] === undefined,
		cursor,
	);
	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		`${ARTIFACT_DIR}/stop-server.json`,
		JSON.stringify(
			{ sessionId, server, stopMs, exit: 143, shellAlive: true },
			null,
			2,
		),
	);
});

it("a Stop cut short by a daemon crash is forgotten: the server stays listed, and Stop again kills it by SIGKILL", async () => {
	harness = ProcessHarness.create({ logLevel: "warn" });
	await harness.restart({ serviceEnvironment: ENVIRONMENT });
	const browser = await harness.connect();
	await browser.followSessions();
	const sessionId = await browser.createSession("Stubborn");
	// The server ignores SIGTERM but says it got it, so the test sees the signal land.
	const { pid, port, exited, termed } = await startAgent(
		sessionId,
		`process.on("SIGTERM", () => console.log(JSON.stringify({ term: 1 })));\n${SERVER}`,
	);
	const listed = listedOn(sessionId, port);
	const server = keyOf(
		listed(await browser.waitFor((frame) => listed(frame) !== undefined)) ??
			expect.fail("no listed server"),
	);

	const cut = browser.stopServer(sessionId, server).then(
		() => "stopped",
		() => "cut short",
	);
	await termed;
	await harness.kill();
	expect(await cut).toBe("cut short");
	expect(alive(pid)).toBe(true);

	await harness.restart({ serviceEnvironment: ENVIRONMENT });
	const again = await harness.connect();
	await again.followSessions();
	const relisted = keyOf(
		listed(await again.waitFor((frame) => listed(frame) !== undefined)) ??
			expect.fail("no relisted server"),
	);
	expect(relisted).toEqual(server);
	const stopping = performance.now();
	await again.stopServer(sessionId, relisted);
	expect(await exited).toBe(137);
	const stopMs = performance.now() - stopping;
	// The Stop returns only after its SIGKILL, five seconds after the ignored SIGTERM.
	expect(stopMs).toBeGreaterThanOrEqual(5000);
	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		`${ARTIFACT_DIR}/stop-after-crash.json`,
		JSON.stringify({ sessionId, server, stopMs, exit: 137 }, null, 2),
	);
});

it("a server a Claude background task started is linked to that task, which reads calm while it serves and stays when the server exits", async () => {
	harness = ProcessHarness.create({ logLevel: "warn", restartProof: true });
	await harness.restart({ serviceEnvironment: ENVIRONMENT });
	const browser = await harness.connect();
	await browser.followSessions();
	const sessionId = await browser.createSession("Task server");
	await browser.send(sessionId, "restart-background-work");
	const taskId = "restart-background-task";
	// Claude Code points a background task's stdout at <tmp>/<project>/<session>/tasks/<id>.output.
	const output = join(
		mkdtempSync(join(tmpdir(), "claude-task-")),
		"tasks",
		`${taskId}.output`,
	);
	mkdirSync(join(output, ".."));
	// The shell echoes the server's first line once the server has written it to the task file.
	const agent = spawn(
		"/bin/sh",
		[
			"-c",
			'node -e "$SERVER" > "$OUT" & until [ -s "$OUT" ]; do sleep 0.05; done; cat "$OUT"; wait; sleep 60',
		],
		{
			env: {
				...process.env,
				SERVER,
				OUT: output,
				CONDUIT_SESSION_ID: sessionId,
			},
			stdio: ["ignore", "pipe", "inherit"],
			detached: true,
		},
	);
	agents.push(agent);
	const [line] = await once(
		createInterface({ input: agent.stdout ?? process.stdin }),
		"line",
	);
	const { pid, port }: { pid: number; port: number } = JSON.parse(line);

	const row = (frame: Record<string, unknown>) =>
		frame["type"] === "session_row" && frame["id"] === sessionId
			? (frame as {
					servers?: readonly Record<string, unknown>[];
					backgroundWork?: string;
					backgroundTasks?: readonly { id: string }[];
				})
			: undefined;
	const serving = await browser.waitFor(
		(frame) => row(frame)?.servers?.some((s) => s["port"] === port) ?? false,
	);
	expect(row(serving)).toMatchObject({
		servers: [{ port, pid, taskId, source: "detected", role: "serving" }],
		backgroundWork: "monitoring",
		backgroundTasks: [{ id: taskId }],
	});

	const cursor = browser.frames.length;
	process.kill(pid, "SIGTERM");
	const gone = await browser.waitFor(
		(frame) => row(frame) !== undefined && row(frame)?.servers === undefined,
		cursor,
	);
	expect(row(gone)).toMatchObject({
		backgroundWork: "monitoring",
		backgroundTasks: [{ id: taskId }],
	});

	const db = new Database(harness.daemonStorePath(), { readonly: true });
	const evidence = db
		.prepare<[string], { type: string; data: string }>(
			"SELECT type, data FROM events WHERE session_id = ? AND type LIKE 'evidence.server_%' ORDER BY sequence",
		)
		.all(sessionId)
		.map((event) => ({ type: event.type, data: JSON.parse(event.data) }));
	db.close();
	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		`${ARTIFACT_DIR}/claude-task-server.json`,
		JSON.stringify(
			{ sessionId, pid, port, output, pushed: [serving, gone], evidence },
			null,
			2,
		),
	);
	expect(evidence.map((event) => event.type)).toEqual([
		"evidence.server_seen",
		"evidence.server_gone",
	]);
	expect(evidence[0]?.data).toMatchObject({
		server: { pid, port },
		taskKey: { taskId },
	});
});
