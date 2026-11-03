// Codex marks a server through its tool connection (CONTRACT.md 8.7 Declared, 2992). Failure
// cases: Codex is never offered the tool; the mark lands on another session; a port with nothing
// listening, another session's port or bad arguments are recorded; a repeated mark records twice;
// the mark waits out the hold; an awaited server leaves the row idle; the reply is malformed or
// never comes, so the turn does not complete.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import type { AppServerTraceReport } from "../../../src/lib/provider/codex/app-server/trace-player.js";
import {
	codexModels,
	fixtureRows,
	rows,
	signedInCodexDiscoveryTrace,
	type TraceRow,
} from "../../helpers/codex-app-server.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
// A hold no test outlives: anything recorded came from a mark.
const HOLD_MS = 600_000;
const ARTIFACT = "test/integration/daemon/artifacts/codex-server-mark.json";
const SERVER = `const server = require("node:http").createServer((_, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ pid: process.pid, port: server.address().port })));`;

let harness: ProcessHarness | undefined;
const servers: number[] = [];

afterEach(async () => {
	for (const pid of servers.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	await harness?.dispose();
	harness = undefined;
});

// A node server whose environment carries `markers` as an agent's shell does, or none. Orphaned
// through a shell that exits, so its ancestry carries no marker of the session this test may
// itself run inside.
const listen = async (markers: NodeJS.ProcessEnv = {}) => {
	const env: NodeJS.ProcessEnv = { ...process.env, SERVER };
	for (const marker of [
		"CONDUIT_SESSION_ID",
		"CODEX_THREAD_ID",
		"CONDUIT_OPENCODE_SESSION_ID",
	])
		delete env[marker];
	const shell = spawn(
		"/bin/sh",
		["-c", `"${process.execPath}" -e "$SERVER" &`],
		{
			env: { ...env, ...markers },
			detached: true,
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	const { value } = await createInterface({
		input: shell.stdout ?? process.stdin,
	})
		[Symbol.asyncIterator]()
		.next();
	const server: { pid: number; port: number } = JSON.parse(String(value));
	servers.push(server.pid);
	return server;
};

const freePort = () =>
	new Promise<number>((done) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() =>
				done(typeof address === "object" && address ? address.port : 0),
			);
		});
	});

// A daemon replaying signed-in Codex, with a Codex session and a Claude session.
const start = async (name: string, holdMs: number) => {
	const root = resolve(`test-results/${name}`);
	mkdirSync(root, { recursive: true });
	const reportPath = join(root, "trace-report.jsonl");
	const capturePath = join(root, "capture.jsonl");
	writeFileSync(reportPath, "");
	writeFileSync(capturePath, "");
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
	});
	const fixture = harness;
	const tracePath = join(fixture.root, "codex-replay.jsonl");
	const writeTrace = (trace: readonly TraceRow[]) =>
		writeFileSync(
			tracePath,
			`${trace.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
	writeTrace(signedInCodexDiscoveryTrace());
	await fixture.restart({
		startupTimeoutMs: TIMEOUT,
		runnerStartupTimeoutMs: TIMEOUT,
		serviceEnvironment: {
			CONDUIT_PORT_WATCH_INTERVAL_MS: "200",
			CONDUIT_PORT_WATCH_HOLD_MS: String(holdMs),
			CONDUIT_CODEX_APP_SERVER_TRACE: tracePath,
			CONDUIT_CODEX_APP_SERVER_CAPTURE: capturePath,
			CONDUIT_CODEX_APP_SERVER_TRACE_REPORT: reportPath,
		},
	});
	const browser = await fixture.connect();
	await browser.followSessions();
	browser.followInstances();
	const codex = (frame: Record<string, unknown>) =>
		frame["type"] === "instances" && Array.isArray(frame["instances"])
			? (frame["instances"] as readonly { id: string; driver: string }[]).find(
					({ driver }) => driver === "codex",
				)
			: undefined;
	const account = codex(await browser.waitFor((frame) => !!codex(frame)));
	if (!account) throw new Error("No Codex account");
	await codexModels(browser, account.id);
	const sessionId = await browser.createSession("Mark", account.id, "codex", {
		modelId: "gpt-6.1-sol",
		contextWindow: "",
		permissionMode: "ask",
	});
	const otherId = await browser.createSession("Other");
	return {
		fixture,
		browser,
		sessionId,
		otherId,
		capturePath,
		reportPath,
		writeTrace,
	};
};

it("a Codex agent marks its server through the conduit_server_mark tool, refused for a dead port, another session's port or bad arguments", async () => {
	const {
		fixture,
		browser,
		sessionId,
		otherId,
		capturePath,
		reportPath,
		writeTrace,
	} = await start("codex-server-mark", HOLD_MS);

	const own = await listen();
	const other = await listen({ CONDUIT_SESSION_ID: otherId });
	const dead = await freePort();

	// The recorded call (real Codex 0.162.1 calling the tool conduit declared), replayed once per
	// case with its arguments, thread and id swapped; conduit's answers land in the capture.
	const recorded = fixtureRows("turn-server-mark");
	const at = recorded.findIndex(
		(row) => row.message?.method === "item/tool/call",
	);
	const call = recorded[at];
	const params = call?.message?.params;
	if (!call || !params) throw new Error("No recorded item/tool/call");
	const cases = {
		dead: { arguments: { port: dead, role: "awaited" } },
		other: { arguments: { port: other.port, role: "awaited" } },
		badArguments: { arguments: { port: "eighty", role: "serving" } },
		marked: { arguments: { port: own.port, role: "awaited" } },
		repeated: { arguments: { port: own.port, role: "awaited" } },
	};
	// Server request ids of the replayed calls, clear of the recorded ones.
	const idOf = (index: number) => 900 + index;
	writeTrace([
		...recorded.slice(0, at),
		...Object.values(cases).flatMap((swap, index) => [
			{
				...call,
				message: {
					...call.message,
					id: idOf(index),
					params: { ...params, ...swap },
				},
			},
			{ dir: "out", at: call["at"], message: { id: idOf(index), result: {} } },
		]),
		...recorded.slice(at + 2),
	]);

	const started = performance.now();
	await browser.send(sessionId, "Start the dev server", TIMEOUT);
	const replies = Object.fromEntries(
		Object.keys(cases).map((name, index) => [
			name,
			rows<TraceRow>(capturePath).find(
				(row) => row.dir === "out" && row.message?.id === idOf(index),
			)?.message?.result,
		]),
	);
	const reply = (success: boolean, text: string) => ({
		contentItems: [{ type: "inputText", text }],
		success,
	});
	expect(replies).toEqual({
		dead: reply(false, `Nothing is listening on port ${dead}`),
		other: reply(false, `Port ${other.port} belongs to another session`),
		badArguments: reply(
			false,
			"Pass port (an integer from 1 to 65535) and role (serving or awaited).",
		),
		marked: reply(true, `Marked port ${own.port} as awaited`),
		repeated: reply(true, `Marked port ${own.port} as awaited`),
	});
	const threadStart = rows<TraceRow>(capturePath).find(
		(row) => row.dir === "out" && row.message?.method === "thread/start",
	)?.message?.params;
	expect(threadStart?.["dynamicTools"]).toEqual([
		expect.objectContaining({ type: "function", name: "conduit_server_mark" }),
	]);

	// Awaited: recorded at once, skipping the hold, and the row reads working after the turn.
	const row = await browser.waitFor(
		(frame) =>
			frame["type"] === "session_row" &&
			frame["id"] === sessionId &&
			Array.isArray(frame["servers"]) &&
			frame["servers"].length > 0 &&
			frame["attention"] === "working",
	);
	expect(row).toMatchObject({
		servers: [
			{ port: own.port, pid: own.pid, source: "declared", role: "awaited" },
		],
		attention: "working",
	});
	expect(performance.now() - started).toBeLessThan(HOLD_MS);

	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	const evidence = db
		.prepare<
			[string, string],
			{ session_id: string; type: string; data: string }
		>(
			"SELECT session_id, type, data FROM events WHERE session_id IN (?, ?) AND type LIKE 'evidence.server_%' ORDER BY sequence",
		)
		.all(sessionId, otherId)
		.map((event) => ({
			session: event.session_id === sessionId ? "codex" : "other",
			type: event.type,
			data: JSON.parse(event.data),
		}));
	db.close();
	// One server_seen for the two marks; nothing for the refusals or the other session.
	expect(evidence).toEqual([
		{
			session: "codex",
			type: "evidence.server_seen",
			data: expect.objectContaining({
				server: expect.objectContaining({ pid: own.pid, port: own.port }),
				source: "declared",
				role: "awaited",
			}),
		},
	]);

	await fixture.dispose();
	harness = undefined;
	const reports = rows<AppServerTraceReport>(reportPath);
	for (const report of reports) {
		expect(report.consumed).toBe(report.total);
		expect(report.mismatches).toEqual([]);
	}
	mkdirSync("test/integration/daemon/artifacts", { recursive: true });
	writeFileSync(
		ARTIFACT,
		`${JSON.stringify({ ports: { own: own.port, other: other.port, dead }, replies, threadStartTools: threadStart?.["dynamicTools"], row, evidence, reports }, null, 2)}\n`,
	);
});

// A Codex shell's server, carrying only Codex's own CODEX_THREAD_ID, belongs to the session whose
// Codex thread that is: the scan attributes it after the hold, to no other session.
it("a server started from a Codex shell is attributed to its session through the shell's thread id", async () => {
	const { fixture, browser, sessionId, otherId, reportPath, writeTrace } =
		await start("codex-shell-server", 400);
	const recorded = fixtureRows("turn-server-mark");
	writeTrace(recorded);
	await browser.send(sessionId, "Start the dev server", TIMEOUT);
	const thread = recorded
		.map((row) => row.message?.result?.["thread"])
		.find(
			(value): value is { id: string } =>
				typeof value === "object" &&
				value !== null &&
				"id" in value &&
				typeof value.id === "string",
		)?.id;
	if (!thread) throw new Error("No recorded thread");

	const shell = await listen({ CODEX_THREAD_ID: thread });
	const row = await browser.waitFor(
		(frame) =>
			frame["type"] === "session_row" &&
			frame["id"] === sessionId &&
			Array.isArray(frame["servers"]) &&
			frame["servers"].some(
				(server: { port?: number }) => server.port === shell.port,
			),
	);
	expect(row["servers"]).toEqual([
		expect.objectContaining({ port: shell.port, pid: shell.pid }),
	]);

	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	const evidence = db
		.prepare<[string, string], { session_id: string; data: string }>(
			"SELECT session_id, data FROM events WHERE session_id IN (?, ?) AND type = 'evidence.server_seen' ORDER BY sequence",
		)
		.all(sessionId, otherId)
		.map((event) => ({
			session: event.session_id === sessionId ? "codex" : "other",
			data: JSON.parse(event.data),
		}));
	db.close();
	expect(evidence).toEqual([
		{
			session: "codex",
			data: expect.objectContaining({
				server: expect.objectContaining({ pid: shell.pid, port: shell.port }),
			}),
		},
	]);

	await fixture.dispose();
	harness = undefined;
	const reports = rows<AppServerTraceReport>(reportPath);
	for (const report of reports) {
		expect(report.consumed).toBe(report.total);
		expect(report.mismatches).toEqual([]);
	}
	mkdirSync("test/integration/daemon/artifacts", { recursive: true });
	writeFileSync(
		"test/integration/daemon/artifacts/codex-shell-server.json",
		`${JSON.stringify({ thread, shell, row, evidence, reports }, null, 2)}\n`,
	);
});
