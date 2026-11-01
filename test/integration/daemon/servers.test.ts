// Failure cases: a marked agent's dev server never reaches the browser, reaches it before the
// hold, carries the wrong port or pid, lingers in the browser after it exits, or its evidence
// is not a server_seen then a server_gone naming the same ServerKey (CONTRACT.md 8.7).
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

const HOLD_MS = 600;
const ARTIFACT_DIR = "test/integration/daemon/artifacts";
const SERVER = `const server = require("node:http").createServer((_, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () =>
	console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));`;

let harness: ProcessHarness | undefined;
let agent: ChildProcess | undefined;

afterEach(async () => {
	// The agent leads its own process group, so this also reaps a server it left behind.
	if (agent?.pid !== undefined && agent.exitCode === null)
		process.kill(-agent.pid, "SIGKILL");
	await harness?.dispose();
	harness = agent = undefined;
});

it("a marked agent's real node server reaches the browser after the hold and leaves when it exits", async () => {
	harness = ProcessHarness.create({ logLevel: "warn" });
	await harness.restart({
		serviceEnvironment: {
			CONDUIT_PORT_WATCH_INTERVAL_MS: "200",
			CONDUIT_PORT_WATCH_HOLD_MS: String(HOLD_MS),
		},
	});
	const browser = await harness.connect();
	await browser.followSessions();
	const sessionId = await browser.createSession("Servers");

	// The fake agent is a shell marked with the session; the server is its background child.
	agent = spawn("/bin/sh", ["-c", 'node -e "$SERVER" & wait'], {
		env: { ...process.env, SERVER, CONDUIT_SESSION_ID: sessionId },
		stdio: ["ignore", "pipe", "inherit"],
		detached: true,
	});
	const [line] = await once(agent.stdout ?? agent, "data");
	const listening = performance.now();
	const { pid, port } = JSON.parse(String(line)) as {
		pid: number;
		port: number;
	};

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
