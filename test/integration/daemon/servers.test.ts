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
// OpenCode: a real managed OpenCode's shell lacks its session's native id, or a server started there
// is not attributed to the Conduit session bound to that native id.
// Mark: a port with nothing listening, another session's port, a caller outside any session or a
// browser naming a session's pid is recorded; a mark waits out the hold; a later scan flips a declared role back to detected; a new
// process on a declared port inherits the declaration; an unmarked declared server vanishes while
// it listens; an awaited server leaves the row idle or a serving one makes it read working; an
// unmarked server one session declared is recorded for another that the store reads first; with
// several projects loaded, a mark reaches only the last project's watcher, or none once one closes;
// an unmarked server a session in one project declared, or a server its OpenCode shell started, is
// recorded for a session in another.
// One watcher per daemon (82tn.16): a project no tab has opened since a restart has its servers
// unrecorded, its marks refused or its ended sessions' servers spared; a server is recorded twice or
// for the other project when two projects share a folder; a removed project's session still marks.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Effect, Result as Either } from "effect";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { resolveRealOpenCode } from "../../helpers/real-opencode.js";

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

const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const CLI = fileURLToPath(new URL("../../../src/bin/cli.ts", import.meta.url));

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
// The CLI as an agent runs it: from the agent's shell, carrying the session's marker.
const cliMark = async (
	configDir: string,
	marker: string | undefined,
	...args: string[]
) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CONDUIT_CONFIG_DIR: configDir,
	};
	delete env["CONDUIT_SESSION_ID"];
	delete env["CODEX_THREAD_ID"];
	delete env["CONDUIT_OPENCODE_SESSION_ID"];
	const cli = spawn(
		process.execPath,
		["--import", TSX, CLI, "server", "mark", ...args],
		{
			env: marker === undefined ? env : { ...env, CONDUIT_SESSION_ID: marker },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	cli.stdout.on("data", (chunk) => (stdout += chunk));
	cli.stderr.on("data", (chunk) => (stderr += chunk));
	const [code] = await once(cli, "exit");
	return { code, stdout, stderr };
};
const alive = (pid: number) => {
	try {
		return process.kill(pid, 0);
	} catch {
		return false;
	}
};

// A server orphaned through a shell that exits, so its ancestry carries only `markers`: by
// default no session's marker.
const unmarkedServer = async (markers: NodeJS.ProcessEnv = {}) => {
	const env: NodeJS.ProcessEnv = { ...process.env, SERVER };
	delete env["CONDUIT_SESSION_ID"];
	delete env["CODEX_THREAD_ID"];
	delete env["CONDUIT_OPENCODE_SESSION_ID"];
	const launcher = spawn("/bin/sh", ["-c", 'node -e "$SERVER" &'], {
		env: { ...env, ...markers },
		stdio: ["ignore", "pipe", "inherit"],
	});
	const [line] = await Promise.all([
		once(createInterface({ input: launcher.stdout }), "line"),
		once(launcher, "exit"),
	]);
	const server: { pid: number; port: number } = JSON.parse(String(line));
	onTestFinished(() => {
		if (alive(server.pid)) process.kill(server.pid, "SIGKILL");
	});
	return server;
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
	// 8.2 (CONTRACT.md 2778-2781): without its server the shell is work again.
	expect(row(gone)).toMatchObject({
		backgroundWork: "working",
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

it("a server started in a real managed OpenCode shell carries the session's native id and reaches that session", async ({
	skip,
}) => {
	let binary: string;
	try {
		binary = resolveRealOpenCode();
	} catch {
		return skip("No real OpenCode binary available");
	}
	harness = ProcessHarness.create({
		logLevel: "warn",
		managedOpenCode: true,
		realOpenCode: binary,
	});
	await harness.restart({ serviceEnvironment: ENVIRONMENT });
	const browser = await harness.connect();
	await browser.followSessions();
	try {
		await browser.startInstance("managed-test");
	} catch (error) {
		// A cold, isolated OpenCode config can outlast the daemon's /path probe.
		expect(String(error)).toContain("Operation timed out");
		await browser.startInstance("managed-test");
	}
	const sessionId = await browser.createSession(
		"OpenCode server",
		"managed-test",
		"opencode",
	);
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	const { native } = db
		.prepare<[string], { native: string }>(
			`SELECT COALESCE((SELECT provider_sid FROM session_providers WHERE session_id = session.id
				AND status = 'active' ORDER BY activated_at DESC LIMIT 1), session.provider_sid, session.id)
				AS native FROM sessions AS session WHERE id = ?`,
		)
		.get(sessionId) ?? { native: "" };
	const instance = Either.getOrThrowWith(
		loadDaemonConfigResult(harness.configDir),
		(error) => error,
	)?.instances?.find(({ id }) => id === "managed-test");
	if (!instance?.port) throw new Error("Managed OpenCode did not start");

	// The shell starts the server in the background and returns once it has written its port.
	const script = join(harness.root, "server.js");
	const out = join(harness.root, "server.json");
	writeFileSync(script, SERVER);
	const shell = await fetch(
		`http://127.0.0.1:${instance.port}/session/${native}/shell?directory=${encodeURIComponent(harness.projectDir)}`,
		{
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"] ?? "opencode"}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				agent: "build",
				command: `env | grep '^CONDUIT_OPENCODE_' | sort; (node ${script} > ${out} 2>&1 < /dev/null &); until [ -s ${out} ]; do sleep 0.05; done; cat ${out}`,
			}),
			signal: AbortSignal.timeout(30_000),
		},
	);
	const reply = await shell.text();
	expect(shell.ok, reply).toBe(true);
	const printed = [...reply.matchAll(/CONDUIT_OPENCODE_\w+=[^\s"\\]+/g)].map(
		([line]) => line,
	);
	expect(printed).toEqual(
		expect.arrayContaining([
			"CONDUIT_OPENCODE_INSTANCE_ID=managed-test",
			`CONDUIT_OPENCODE_SESSION_ID=${native}`,
		]),
	);
	// The reply quotes the shell's output inside a JSON string, so its quotes come escaped.
	const [, pid = 0, port = 0] = (
		/pid\\?":(\d+),\\?"port\\?":(\d+)/.exec(reply) ?? []
	).map(Number);
	// OpenCode's shell has exited, so this server is no agent's child to reap.
	onTestFinished(() => {
		if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
	});

	const rowsOf = (frame: Record<string, unknown>) =>
		frame["type"] === "session_row" && frame["id"] === sessionId
			? ((frame["servers"] ?? []) as readonly Record<string, unknown>[])
			: undefined;
	const seen = await browser.waitFor(
		(frame) =>
			rowsOf(frame)?.some((server) => server["port"] === port) ?? false,
	);
	expect(rowsOf(seen)).toEqual([
		expect.objectContaining({ port, pid, source: "detected", role: "serving" }),
	]);
	const evidence = db
		.prepare<[string], { type: string; data: string }>(
			"SELECT type, data FROM events WHERE session_id = ? AND type LIKE 'evidence.server_%' ORDER BY sequence",
		)
		.all(sessionId)
		.map((event) => ({ type: event.type, data: JSON.parse(event.data) }));
	db.close();
	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		`${ARTIFACT_DIR}/opencode-server.json`,
		JSON.stringify(
			{ sessionId, native, printed, pid, port, pushed: seen, evidence },
			null,
			2,
		),
	);
	expect(evidence).toMatchObject([
		{ type: "evidence.server_seen", data: { server: { pid, port } } },
	]);
});

it("conduit server mark rejects a dead port, another session's port and a caller outside any session; a mark records at once and its role holds until a new process takes the port", async () => {
	// A long hold: anything recorded before it passes came from a mark.
	const hold = 10_000;
	harness = ProcessHarness.create({ logLevel: "warn" });
	await harness.restart({
		serviceEnvironment: {
			...ENVIRONMENT,
			CONDUIT_PORT_WATCH_HOLD_MS: String(hold),
		},
	});
	const configDir = harness.configDir;
	const browser = await harness.connect();
	await browser.followSessions();
	const sessionId = await browser.createSession("Mark");
	const otherId = await browser.createSession("Other");
	const mark = (marker: string | undefined, ...args: string[]) =>
		cliMark(configDir, marker, ...args);
	const row = (frame: Record<string, unknown>) =>
		frame["type"] === "session_row" && frame["id"] === sessionId
			? (frame as {
					servers?: readonly Record<string, unknown>[];
					attention?: string;
				})
			: undefined;
	const evidence = () => {
		const db = new Database(harness?.daemonStorePath() ?? "", {
			readonly: true,
		});
		const rows = db
			.prepare<
				[string, string],
				{ session_id: string; type: string; data: string }
			>(
				"SELECT session_id, type, data FROM events WHERE session_id IN (?, ?) AND type LIKE 'evidence.server_%' ORDER BY sequence",
			)
			.all(sessionId, otherId)
			.map((event) => ({
				session: event.session_id === sessionId ? "mark" : "other",
				type: event.type,
				data: JSON.parse(event.data),
			}));
		db.close();
		return rows;
	};

	const first = await startAgent(sessionId);
	const started = performance.now();
	// The other session's own server, unmarked by the CLI: once it is detected, the hold has passed
	// for the earlier first server too.
	const control = await startAgent(otherId);
	const free = await new Promise<number>((resolve) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() =>
				resolve(typeof address === "object" && address ? address.port : 0),
			);
		});
	});
	// Concurrent, so the awaited mark below lands well inside the hold on a loaded machine: each
	// CLI run is a cold start, and none of these records anything.
	const [dead, other, outside, browserRefusal] = await Promise.all([
		mark(sessionId, String(free), "--awaited"),
		mark(otherId, String(first.port), "--awaited"),
		mark(undefined, String(first.port), "--awaited"),
		// A browser naming the server's own pid, which resolves to the session, is still refused.
		Effect.runPromise(
			browser.rpc
				.MarkServer({ pid: first.pid, port: first.port, role: "awaited" })
				.pipe(
					Effect.flip,
					Effect.map(({ message }) => message),
				),
		),
	]);
	const rejections = { dead, other, outside, browser: browserRefusal };
	expect(rejections.dead).toMatchObject({ code: 1 });
	expect(rejections.dead.stderr).toContain(
		`Nothing is listening on port ${free}`,
	);
	expect(rejections.other).toMatchObject({ code: 1 });
	expect(rejections.other.stderr).toContain(
		`Port ${first.port} belongs to another session`,
	);
	expect(rejections.outside).toMatchObject({ code: 1 });
	expect(rejections.outside.stderr).toContain("not inside a Conduit session");
	expect(rejections.browser).toContain("marked from an agent's shell");
	expect(evidence()).toEqual([]);

	// Awaited skips the hold and makes the row read working.
	const awaited = await mark(sessionId, String(first.port), "--awaited");
	expect(awaited).toMatchObject({ code: 0 });
	expect(awaited.stdout).toContain(`Marked port ${first.port} as awaited`);
	const working = await browser.waitFor(
		(frame) =>
			row(frame)?.servers?.some((s) => s["port"] === first.port) ?? false,
	);
	expect(performance.now() - started).toBeLessThan(hold);
	expect(row(working)).toMatchObject({
		servers: [
			{ port: first.port, pid: first.pid, source: "declared", role: "awaited" },
		],
		attention: "working",
	});

	// Scans past the hold see the same ServerKey and leave the declaration alone.
	await browser.waitFor(
		(frame) =>
			frame["type"] === "session_row" &&
			frame["id"] === otherId &&
			Array.isArray(frame["servers"]) &&
			frame["servers"].length > 0,
	);
	expect(evidence().filter(({ session }) => session === "mark")).toEqual([
		expect.objectContaining({
			session: "mark",
			type: "evidence.server_seen",
			data: expect.objectContaining({ source: "declared", role: "awaited" }),
		}),
	]);

	// Serving: a calm server. 8.7 Views (CONTRACT.md 2996): background, not idle; the row shows
	// background activity as monitoring.
	let cursor = browser.frames.length;
	expect(await mark(sessionId, String(first.port), "--serving")).toMatchObject({
		code: 0,
	});
	const calm = await browser.waitFor(
		(frame) => row(frame)?.servers?.[0]?.["role"] === "serving",
		cursor,
	);
	expect(row(calm)).toMatchObject({
		servers: [{ port: first.port, source: "declared", role: "serving" }],
		activity: {
			foreground: "idle",
			background: "serving",
			label: "background",
		},
		attention: "monitoring",
	});

	// A new process on the port starts detected, after its own hold.
	cursor = browser.frames.length;
	process.kill(first.pid, "SIGTERM");
	await browser.waitFor(
		(frame) => row(frame)?.servers === undefined && row(frame) !== undefined,
		cursor,
	);
	const second = await startAgent(
		sessionId,
		SERVER.replace("listen(0,", `listen(${first.port},`),
	);
	// While its hold runs: an unmarked server one session declared is refused to the other, whichever
	// of the two the store reads first.
	const [caller, owner] = [sessionId, otherId].sort();
	const label = (id: string | undefined) =>
		id === sessionId ? "mark" : "other";
	const contested = await unmarkedServer();
	expect(await mark(owner, String(contested.port), "--serving")).toMatchObject({
		code: 0,
	});
	const contestedRefusal = await mark(
		caller,
		String(contested.port),
		"--serving",
	);
	expect(contestedRefusal).toMatchObject({ code: 1 });
	expect(contestedRefusal.stderr).toContain(
		`Port ${contested.port} belongs to another session`,
	);
	const contestedEvidence = evidence().filter(
		({ data }) => data.server.pid === contested.pid,
	);
	process.kill(contested.pid, "SIGKILL");
	expect(contestedEvidence).toEqual([
		expect.objectContaining({
			session: label(owner),
			type: "evidence.server_seen",
			data: expect.objectContaining({ source: "declared", role: "serving" }),
		}),
	]);

	const detected = await browser.waitFor(
		(frame) =>
			row(frame)?.servers?.some((s) => s["pid"] === second.pid) ?? false,
		cursor,
	);
	expect(row(detected)?.servers).toEqual([
		expect.objectContaining({
			port: first.port,
			source: "detected",
			role: "serving",
		}),
	]);

	// An unmarked server can be declared and stays listed while it listens.
	const unmarked = await unmarkedServer();
	cursor = browser.frames.length;
	expect(
		await mark(sessionId, String(unmarked.port), "--serving"),
	).toMatchObject({ code: 0 });
	await browser.waitFor(
		(frame) =>
			row(frame)?.servers?.some((s) => s["pid"] === unmarked.pid) ?? false,
		cursor,
	);
	// A scan after the mark records the second server gone and keeps the unmarked one.
	cursor = browser.frames.length;
	process.kill(second.pid, "SIGTERM");
	const kept = await browser.waitFor(
		(frame) =>
			row(frame) !== undefined &&
			!(row(frame)?.servers ?? []).some((s) => s["pid"] === second.pid),
		cursor,
	);
	expect(row(kept)?.servers).toEqual([
		expect.objectContaining({
			pid: unmarked.pid,
			source: "declared",
			role: "serving",
		}),
	]);
	cursor = browser.frames.length;
	process.kill(unmarked.pid, "SIGTERM");
	const gone = await browser.waitFor(
		(frame) => row(frame) !== undefined && row(frame)?.servers === undefined,
		cursor,
	);

	const recorded = evidence().filter(
		({ data }) => data.server.pid !== contested.pid,
	);
	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		`${ARTIFACT_DIR}/server-mark.json`,
		JSON.stringify(
			{
				sessionId,
				otherId,
				rejections,
				first,
				second: { pid: second.pid, port: second.port },
				control: { pid: control.pid, port: control.port },
				unmarked,
				contested: {
					...contested,
					owner: label(owner),
					caller: label(caller),
					refusal: contestedRefusal,
					evidence: contestedEvidence,
				},
				pushed: [working, calm, detected, kept, gone],
				evidence: recorded,
			},
			null,
			2,
		),
	);
	expect(
		recorded.map(({ session, type, data }) => [
			session,
			type,
			data.server.pid,
			data.source,
		]),
	).toEqual([
		["mark", "evidence.server_seen", first.pid, "declared"],
		["other", "evidence.server_seen", control.pid, "detected"],
		["mark", "evidence.server_seen", first.pid, "declared"],
		["mark", "evidence.server_gone", first.pid, undefined],
		["mark", "evidence.server_seen", second.pid, "detected"],
		["mark", "evidence.server_seen", unmarked.pid, "declared"],
		["mark", "evidence.server_gone", second.pid, undefined],
		["mark", "evidence.server_gone", unmarked.pid, undefined],
	]);
});

it("after a restart, one watcher serves a project no tab has opened: its session's server is recorded once though another project shares its folder, its mark is accepted, and its settled session's server is killed", async () => {
	harness = ProcessHarness.create({ logLevel: "warn" });
	await harness.restart({ serviceEnvironment: ENVIRONMENT });
	const configDir = harness.configDir;
	const first = await harness.connect();
	const shared = mkdtempSync(join(tmpdir(), "shared-folder-"));
	const save = (title: string, folders: string[]) =>
		Effect.runPromise(first.rpc.SaveProject({ title, folders })).then(
			({ savedSlug }) => savedSlug,
		);
	const cold = await save("Cold project", [shared]);
	// Two projects in one folder: the second's main folder is its own, the shared one its second.
	const neighbour = await save("Neighbour", [
		mkdtempSync(join(tmpdir(), "neighbour-")),
		shared,
	]);
	const coldTab = await harness.connect(undefined, undefined, cold);
	const liveId = await coldTab.createSession("Live");
	const settledId = await coldTab.createSession("Settled");
	await coldTab.setSettled(settledId, true);
	await harness.shutdown();
	// No tab opens the cold project after this restart.
	await harness.restart({ serviceEnvironment: ENVIRONMENT });

	const live = await startAgent(liveId);
	const doomed = await startAgent(settledId);
	// The settled session's server exiting shows the watcher has scanned; the mark shares a scan.
	const doomedExit = await doomed.exited;
	const mark = await cliMark(configDir, liveId, String(live.port), "--serving");
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	// The scan's records only: the mark adds its own declared one.
	const seen = db
		.prepare<[number], { session_id: string; project_id: string }>(
			"SELECT session_id, project_id FROM events WHERE type = 'evidence.server_seen' AND json_extract(data, '$.source') = 'detected' AND json_extract(data, '$.server.pid') = ? ORDER BY sequence",
		)
		.all(live.pid);
	db.close();
	const result = { seen, mark, doomedExit };
	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		`${ARTIFACT_DIR}/server-cold-project.json`,
		JSON.stringify({ cold, neighbour, liveId, settledId, ...result }, null, 2),
	);
	expect(result).toEqual({
		seen: [{ session_id: liveId, project_id: cold }],
		mark: expect.objectContaining({
			code: 0,
			stdout: expect.stringContaining(`Marked port ${live.port} as serving`),
		}),
		// 143 is SIGTERM.
		doomedExit: 143,
	});
});

it("with two projects loaded, each project's session marks its server, an unmarked server one project's session declared or its OpenCode shell started is refused to the other's, and removing one project leaves the other's marks working", async () => {
	harness = ProcessHarness.create({ logLevel: "warn" });
	// A hold no test outlives: a marker-attributed server is never recorded by a scan here.
	await harness.restart({
		serviceEnvironment: {
			...ENVIRONMENT,
			CONDUIT_PORT_WATCH_HOLD_MS: "600000",
		},
	});
	const configDir = harness.configDir;
	const first = await harness.connect();
	const { savedSlug } = await Effect.runPromise(
		first.rpc.SaveProject({
			title: "Second project",
			folders: [mkdtempSync(join(tmpdir(), "second-project-"))],
		}),
	);
	const second = await harness.connect(undefined, undefined, savedSlug);
	const firstId = await first.createSession("First");
	const secondId = await second.createSession("Second");
	const firstServer = await startAgent(firstId);
	const secondServer = await startAgent(secondId);
	const serverSeen = (pid: number) => {
		const db = new Database(harness?.daemonStorePath() ?? "", {
			readonly: true,
		});
		const rows = db
			.prepare<[number], { session_id: string; data: string }>(
				"SELECT session_id, data FROM events WHERE type = 'evidence.server_seen' AND json_extract(data, '$.server.pid') = ? ORDER BY sequence",
			)
			.all(pid)
			.map(({ session_id, data }) => ({
				session: session_id === firstId ? "first" : "second",
				source: JSON.parse(data).source,
			}));
		db.close();
		return rows;
	};
	// The first session's provider binding, as a managed OpenCode shell carries it.
	const identity = (() => {
		const db = new Database(harness?.daemonStorePath() ?? "", {
			readonly: true,
		});
		const row = db
			.prepare<[string], { provider: string; sid: string }>(
				`SELECT COALESCE(binding.provider, session.provider) AS provider,
					COALESCE(binding.provider_sid, session.provider_sid, session.id) AS sid
				FROM sessions AS session
				LEFT JOIN session_providers AS binding ON binding.id = (
					SELECT id FROM session_providers WHERE session_id = session.id AND status = 'active'
					ORDER BY activated_at DESC, id DESC LIMIT 1)
				WHERE session.id = ?`,
			)
			.get(firstId);
		db.close();
		return row ?? expect.fail("the first session has no row");
	})();
	const marks = {
		first: await cliMark(
			configDir,
			firstId,
			String(firstServer.port),
			"--awaited",
		),
		second: await cliMark(
			configDir,
			secondId,
			String(secondServer.port),
			"--awaited",
		),
		// An unmarked server the first project's session declared is refused to the second's.
		contested: await unmarkedServer().then(async (server) => ({
			server,
			owner: await cliMark(
				configDir,
				firstId,
				String(server.port),
				"--serving",
			),
			other: await cliMark(
				configDir,
				secondId,
				String(server.port),
				"--serving",
			),
			evidence: serverSeen(server.pid),
		})),
		// A server the first session's OpenCode shell started, still in its hold, is refused to the
		// second project's session and declared by its own.
		opencode: await unmarkedServer({
			CONDUIT_OPENCODE_INSTANCE_ID: identity.provider,
			CONDUIT_OPENCODE_SESSION_ID: identity.sid,
		}).then(async (server) => ({
			server,
			other: await cliMark(
				configDir,
				secondId,
				String(server.port),
				"--serving",
			),
			owner: await cliMark(
				configDir,
				firstId,
				String(server.port),
				"--serving",
			),
			evidence: serverSeen(server.pid),
		})),
		removed: await Effect.runPromise(
			first.rpc.RemoveProject({ slug: savedSlug }),
		).then(async () => ({
			other: await cliMark(
				configDir,
				firstId,
				String(firstServer.port),
				"--serving",
			),
			// The removed project's work is gone with it: its session marks nothing.
			own: await cliMark(
				configDir,
				secondId,
				String(secondServer.port),
				"--serving",
			),
		})),
	};
	mkdirSync(ARTIFACT_DIR, { recursive: true });
	writeFileSync(
		`${ARTIFACT_DIR}/server-mark-projects.json`,
		JSON.stringify({ savedSlug, firstId, secondId, identity, marks }, null, 2),
	);
	expect(marks).toEqual({
		first: expect.objectContaining({
			code: 0,
			stdout: expect.stringContaining(
				`Marked port ${firstServer.port} as awaited`,
			),
		}),
		second: expect.objectContaining({
			code: 0,
			stdout: expect.stringContaining(
				`Marked port ${secondServer.port} as awaited`,
			),
		}),
		contested: {
			server: marks.contested.server,
			owner: expect.objectContaining({ code: 0 }),
			other: expect.objectContaining({
				code: 1,
				stderr: expect.stringContaining(
					`Port ${marks.contested.server.port} belongs to another session`,
				),
			}),
			evidence: [{ session: "first", source: "declared" }],
		},
		opencode: {
			server: marks.opencode.server,
			other: expect.objectContaining({
				code: 1,
				stderr: expect.stringContaining(
					`Port ${marks.opencode.server.port} belongs to another session`,
				),
			}),
			owner: expect.objectContaining({ code: 0 }),
			evidence: [{ session: "first", source: "declared" }],
		},
		removed: {
			other: expect.objectContaining({
				code: 0,
				stdout: expect.stringContaining(
					`Marked port ${firstServer.port} as serving`,
				),
			}),
			own: expect.objectContaining({
				code: 1,
				stderr: expect.stringContaining(
					"This shell is not inside a Conduit session",
				),
			}),
		},
	});
});
