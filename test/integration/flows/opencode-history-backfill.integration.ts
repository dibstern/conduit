// ─── OpenCode history backfill (conduit-test-iea) ────────────────────────────
// An OpenCode session Conduit first sights mid-conversation — started in the
// TUI, or while the daemon was down — must still project its whole history:
// the ingress backfills the provider's REST record on first sighting. These
// drive the real relay stack against the mock OpenCode server: REST history is
// served for a session Conduit never created, and live SSE arrives for it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makeReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";
import {
	createRelayStack,
	type RelayStack,
} from "../../../src/lib/relay/relay-stack.js";
import { resolveSessionHistoryFromRows } from "../../../src/lib/session/session-switch.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";
import { TestWsClient } from "../helpers/test-ws-client.js";

const SESSION_ID = "ses_iea_backfill";
/** Recorded provider time, an hour back: provider and Conduit share a clock,
 *  and the projection stamps observed rows with wall-clock time, so a row
 *  carrying one of these exact values proves it came from the REST record. */
const T0 = Date.now() - 3_600_000;

function user(id: string, created: number, text: string) {
	return {
		info: {
			id,
			sessionID: SESSION_ID,
			role: "user",
			time: { created },
			agent: "build",
			model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
		},
		parts: [textPart(id, text)],
	};
}

function assistantInfo(
	id: string,
	created: number,
	completed?: number,
	parentID = id === "msg_a1"
		? "msg_u1"
		: id === "msg_a2"
			? "msg_u2"
			: id === "msg_a3"
				? "msg_u3"
				: "",
) {
	return {
		id,
		sessionID: SESSION_ID,
		role: "assistant",
		time: { created, ...(completed != null ? { completed } : {}) },
		parentID,
		modelID: "claude-sonnet-4-5",
		providerID: "anthropic",
		mode: "build",
		path: { cwd: "/", root: "/" },
		cost: 0.01,
		tokens: {
			input: 10,
			output: 5,
			reasoning: 0,
			cache: { read: 0, write: 0 },
		},
	};
}

function textPart(messageId: string, text: string) {
	return {
		id: `prt_${messageId}_text`,
		sessionID: SESSION_ID,
		messageID: messageId,
		type: "text",
		text,
	};
}

const u1 = user("msg_u1", T0 + 1_000, "first question");
const a1 = {
	info: assistantInfo("msg_a1", T0 + 2_000, T0 + 5_000),
	parts: [
		{
			id: "prt_msg_a1_tool",
			sessionID: SESSION_ID,
			messageID: "msg_a1",
			type: "tool",
			tool: "bash",
			callID: "call_a1",
			state: {
				status: "completed",
				input: { command: "ls" },
				output: "file.txt",
				title: "ls",
				metadata: {},
				time: { start: T0 + 3_000, end: T0 + 4_000 },
			},
		},
		textPart("msg_a1", "first answer"),
	],
};
const u2 = user("msg_u2", T0 + 6_000, "second question");

type Row = {
	id: string;
	role: string;
	is_backfilled: number;
	is_streaming: number;
	created_at: number;
};

function readStore<A, E>(
	dbPath: string,
	read: Effect.Effect<A, E, SqlClient.SqlClient>,
): Promise<A> {
	return Effect.runPromise(
		read.pipe(Effect.provide(SqliteClient.layer({ filename: dbPath }))),
	);
}

async function projectedTexts(dbPath: string): Promise<Record<string, string>> {
	const rows = await readStore(
		dbPath,
		Effect.flatMap(makeReadQueryEffect, (readQuery) =>
			readQuery.getSessionMessagesWithParts(SESSION_ID),
		),
	);
	const resolved = resolveSessionHistoryFromRows(rows, { pageSize: 200 });
	if (resolved.kind !== "rest-history") return {};
	const messages = resolved.history.messages as ReadonlyArray<{
		id: string;
		parts?: ReadonlyArray<{ type: string; text?: string; tool?: string }>;
	}>;
	return Object.fromEntries(
		messages.map((message) => [
			message.id,
			(message.parts ?? [])
				.map((part) =>
					part.type === "text"
						? (part.text ?? "")
						: part.type === "tool"
							? `[${part.tool}]`
							: "",
				)
				.join(""),
		]),
	);
}

function messageRows(dbPath: string): Promise<readonly Row[]> {
	return readStore(
		dbPath,
		Effect.flatMap(
			SqlClient.SqlClient,
			(sql) => sql<Row>`
				SELECT id, role, is_backfilled, is_streaming, created_at FROM messages
				WHERE session_id = ${SESSION_ID}
				ORDER BY created_at ASC, id ASC`,
		),
	);
}

function readTurns(dbPath: string) {
	return readStore(
		dbPath,
		Effect.flatMap(
			SqlClient.SqlClient,
			(sql) => sql<{
				user_message_id: string;
				assistant_message_id: string | null;
				state: string;
			}>`SELECT user_message_id, assistant_message_id, state FROM turns
			WHERE session_id = ${SESSION_ID} ORDER BY requested_at, id`,
		),
	);
}

async function historyComplete(dbPath: string): Promise<boolean> {
	const rows = await readStore(
		dbPath,
		Effect.flatMap(
			SqlClient.SqlClient,
			(sql) =>
				sql<{ history_complete: number }>`
				SELECT history_complete FROM sessions WHERE id = ${SESSION_ID}`,
		),
	);
	return rows[0]?.history_complete === 1;
}

function duplicateMessageCreations(
	dbPath: string,
): Promise<readonly unknown[]> {
	return readStore(
		dbPath,
		Effect.flatMap(
			SqlClient.SqlClient,
			(sql) => sql`
				SELECT json_extract(data, '$.messageId') AS message_id, COUNT(*) AS n
				FROM events
				WHERE session_id = ${SESSION_ID} AND type = 'message.created'
				GROUP BY message_id HAVING n > 1`,
		),
	);
}

async function waitFor(
	check: () => Promise<boolean> | boolean,
	what: string,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Live SSE for an in-flight assistant message: the first thing Conduit sees. */
function streamLiveAssistant(
	mock: MockOpenCodeServer,
	messageId: string,
	created: number,
	text: string,
): void {
	mock.emitTestEvent("message.updated", {
		sessionID: SESSION_ID,
		info: assistantInfo(messageId, created),
	});
	mock.emitTestEvent("message.part.updated", {
		sessionID: SESSION_ID,
		part: textPart(messageId, text),
	});
}

describe("Integration: OpenCode history backfill on first sighting", () => {
	let mock: MockOpenCodeServer | undefined;
	let namedMock: MockOpenCodeServer | undefined;
	let stack: RelayStack | undefined;

	afterEach(async () => {
		await stack?.stop().catch(() => {});
		await mock?.stop().catch(() => {});
		await namedMock?.stop().catch(() => {});
		stack = undefined;
		mock = undefined;
		namedMock = undefined;
	});

	async function startStack(
		server: MockOpenCodeServer,
		dbPath: string,
		configDir?: string,
	): Promise<RelayStack> {
		const connectsBefore = server.diagnostics.filter(
			(entry) => entry.event === "sse_connect",
		).length;
		const started = await createRelayStack({
			port: 0,
			host: "127.0.0.1",
			opencodeUrl: server.url,
			projectDir: process.cwd(),
			slug: "iea-backfill",
			sessionTitle: "Backfill Test Session",
			log: createSilentLogger(),
			persistenceDbPath: dbPath,
			...(configDir ? { configDir } : {}),
		});
		await waitFor(
			() =>
				server.diagnostics.filter((entry) => entry.event === "sse_connect")
					.length > connectsBefore,
			"the relay's SSE connection",
		);
		return started;
	}

	async function restartWithRest(
		server: MockOpenCodeServer,
		dbPath: string,
		messages: readonly unknown[],
	) {
		await stack?.stop();
		stack = undefined;
		server.setExactResponse(
			"GET",
			`/session/${SESSION_ID}/message`,
			200,
			messages,
		);
		stack = await startStack(server, dbPath);
		server.emitTestEvent("session.status", {
			sessionID: SESSION_ID,
			status: { type: "idle" },
		});
	}

	it("serves new REST history after restart without an SSE event, then reconciles it", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-stale-proof-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 200, [u1, a1]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(() => historyComplete(dbPath), "initial reconciliation");
		await stack.stop();
		stack = undefined;
		mock.setExactResponse("GET", restPath, 200, [u1, a1, u2]);
		stack = await startStack(mock, dbPath);
		expect(await historyComplete(dbPath)).toBe(false);
		const client = new TestWsClient(
			`ws://127.0.0.1:${stack.getPort()}/ws?session=${SESSION_ID}`,
		);
		try {
			await client.waitForOpen();
			const switched = await client.waitFor("session_switched", {
				predicate: (message) => message["id"] === SESSION_ID,
			});
			const history = switched["history"] as { messages: { id: string }[] };
			expect(history.messages.map((message) => message.id)).toEqual([
				"msg_u1",
				"msg_a1",
				"msg_u2",
			]);
			await waitFor(
				() => historyComplete(dbPath),
				"reconciliation after REST-served open",
			);
			expect((await projectedTexts(dbPath))["msg_u2"]).toBe("second question");
			const projectionPage = await readStore(
				dbPath,
				Effect.flatMap(makeReadQueryEffect, (readQuery) =>
					readQuery.readSessionTranscriptPage(SESSION_ID, {
						before: "msg_u2",
						limit: 50,
					}),
				),
			);
			const older = await client.loadMoreHistory(
				SESSION_ID,
				"msg_u2",
				"iea-backfill",
			);
			expect(older.messages.map((message) => message.id)).toEqual(
				projectionPage.messages.map((message) => message.id),
			);
			expect(older.messages.map((message) => message.id)).toEqual([
				"msg_u1",
				"msg_a1",
			]);
			expect(older.hasMore).toBe(false);
		} finally {
			await client.close();
		}
	}, 60_000);

	it("resets a named instance's persisted proof and reconciles through that instance on open", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-iea-named-restart-"));
		const dbPath = join(dir, "events.sqlite");
		const configDir = join(dir, "config");
		const restPath = `/session/${SESSION_ID}/message`;
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		mock.setExactResponse("GET", restPath, 200, [u1, a1]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(() => historyComplete(dbPath), "initial reconciliation");
		await stack.stop();
		stack = undefined;
		await readStore(
			dbPath,
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql`UPDATE sessions SET provider = 'oc-secondary' WHERE id = ${SESSION_ID}`,
			),
		);
		namedMock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await namedMock.start();
		namedMock.setExactResponse("GET", restPath, 200, [u1, a1, u2]);
		await saveDaemonConfig(
			{
				...defaultDaemonConfig(),
				instances: [
					{
						id: "oc-secondary",
						name: "Secondary OpenCode",
						port: 0,
						managed: false,
						driver: "opencode",
						url: namedMock.url,
					},
				],
			},
			configDir,
		);
		mock.setExactResponse("GET", restPath, 200, [u1, a1]);
		stack = await startStack(mock, dbPath, configDir);
		expect(await historyComplete(dbPath)).toBe(false);
		const client = new TestWsClient(
			`ws://127.0.0.1:${stack.getPort()}/ws?session=${SESSION_ID}`,
		);
		try {
			await client.waitForOpen();
			const switched = await client.waitFor("session_switched", {
				predicate: (message) => message["id"] === SESSION_ID,
			});
			const history = switched["history"] as { messages: { id: string }[] };
			expect(history.messages.map((message) => message.id)).toEqual([
				"msg_u1",
				"msg_a1",
				"msg_u2",
			]);
			await waitFor(
				() =>
					namedMock?.diagnostics.some(
						(entry) =>
							entry.event === "request" &&
							entry.detail?.startsWith(`GET ${restPath}`),
					) ?? false,
				"named instance REST reconciliation",
			);
			await waitFor(
				() => historyComplete(dbPath),
				"named instance reconciliation",
			);
			expect((await projectedTexts(dbPath))["msg_u2"]).toBe("second question");
		} finally {
			await client.close();
		}
	}, 60_000);

	it("reconciles a rebuilt completeness flag on the next session sighting", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-rebuild-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		mock.setExactResponse("GET", `/session/${SESSION_ID}/message`, 200, [
			u1,
			a1,
		]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(() => historyComplete(dbPath), "initial reconciliation");
		await stack.stop();
		stack = undefined;
		// Simulate the 0 produced by the replay test before restarting ingress.
		await readStore(
			dbPath,
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql`UPDATE sessions SET history_complete = 0 WHERE id = ${SESSION_ID}`,
			),
		);
		expect(await historyComplete(dbPath)).toBe(false);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(
			() => historyComplete(dbPath),
			"reconciliation after restart",
		);
	});

	it("projects the full history, marked backfilled, idempotently across restarts", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-backfill-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;

		// ── First sighting: Conduit attaches mid-conversation ───────────────
		mock.setExactResponse("GET", restPath, 200, [u1, a1, u2]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(
			async () =>
				(await projectedTexts(dbPath))["msg_u2"] === "second question",
			"initial REST history",
		);
		await waitFor(
			() => historyComplete(dbPath),
			"equal projected tool history",
		);
		streamLiveAssistant(mock, "msg_a2", T0 + 7_000, "live answer");
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a2"] === "live answer",
			"the live message and reconciled history",
		);

		expect(await projectedTexts(dbPath)).toEqual({
			msg_u1: "first question",
			msg_a1: "[bash]first answer",
			msg_u2: "second question",
			msg_a2: "live answer",
		});
		const firstRows = await messageRows(dbPath);
		expect(
			firstRows.map((row) => [row.id, row.role, row.is_backfilled]),
		).toEqual([
			["msg_u1", "user", 1],
			["msg_a1", "assistant", 1],
			["msg_u2", "user", 1],
			["msg_a2", "assistant", 0],
		]);
		expect(firstRows[0]?.created_at).toBeLessThan(
			firstRows[3]?.created_at ?? 0,
		);
		const servedRows = await readStore(
			dbPath,
			Effect.flatMap(makeReadQueryEffect, (readQuery) =>
				readQuery.getSessionMessagesWithParts(SESSION_ID),
			),
		);
		const served = resolveSessionHistoryFromRows(servedRows, { pageSize: 200 });
		expect(served.kind).toBe("rest-history");
		if (served.kind === "rest-history") {
			expect(
				served.history.messages.map((message) => [
					message.id,
					message.isBackfilled,
				]),
			).toEqual([
				["msg_u1", true],
				["msg_a1", true],
				["msg_u2", true],
				["msg_a2", undefined],
			]);
		}

		// ── Restart: the turn finished and another began while Conduit was down
		await stack.stop();
		stack = undefined;
		const resumed = Date.now();
		mock.setExactResponse("GET", restPath, 200, [
			u1,
			a1,
			u2,
			{
				info: assistantInfo("msg_a2", T0 + 7_000, T0 + 9_000),
				parts: [textPart("msg_a2", "live answer")],
			},
			user("msg_u3", resumed, "third question"),
			{ info: assistantInfo("msg_a3", resumed + 1), parts: [] },
		]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_u3"] === "third question",
			"tail REST user",
		);
		streamLiveAssistant(mock, "msg_a3", resumed + 1, "third answer");
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a3"] === "third answer",
			"the second live message and reconciled history",
		);
		expect(await historyComplete(dbPath)).toBe(false);

		expect(await projectedTexts(dbPath)).toEqual({
			msg_u1: "first question",
			msg_a1: "[bash]first answer",
			msg_u2: "second question",
			msg_a2: "live answer",
			msg_u3: "third question",
			msg_a3: "third answer",
		});
		expect(
			(await messageRows(dbPath)).map((row) => [row.id, row.is_backfilled]),
		).toEqual([
			["msg_u1", 1],
			["msg_a1", 1],
			["msg_u2", 1],
			["msg_a2", 0],
			["msg_u3", 1],
			["msg_a3", 0],
		]);
		expect(await duplicateMessageCreations(dbPath)).toEqual([]);
	}, 60_000);

	it("retains live deltas during a REST outage and imports the recovered head", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-retry-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 400, { error: "unavailable" });
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a2", T0 + 7_000, "Hello ");
		await waitFor(
			() =>
				mock?.diagnostics.some(
					(entry) =>
						entry.event === "request" &&
						entry.detail?.startsWith(`GET ${restPath}`),
				) ?? false,
			"the failed REST request",
		);
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a2"] === "Hello ",
			"the first live delta during the outage",
		);
		mock.emitTestEvent("message.part.updated", {
			sessionID: SESSION_ID,
			part: textPart("msg_a2", "Hello world"),
		});
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a2"] === "Hello world",
			"the second live delta during the outage",
		);
		expect(await historyComplete(dbPath)).toBe(false);

		mock.setExactResponse("GET", restPath, 200, [
			u1,
			a1,
			u2,
			{
				info: assistantInfo("msg_a2", T0 + 7_000, T0 + 8_000),
				parts: [textPart("msg_a2", "Hello world")],
			},
		]);
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		mock.emitTestEvent("session.status", {
			sessionID: SESSION_ID,
			status: { type: "idle" },
		});
		await waitFor(
			async () => (await messageRows(dbPath)).length === 4,
			"recovered head and retained live answer",
		);
		await waitFor(() => historyComplete(dbPath), "complete recovered history");
		expect(await projectedTexts(dbPath)).toEqual({
			msg_u1: "first question",
			msg_a1: "[bash]first answer",
			msg_u2: "second question",
			msg_a2: "Hello world",
		});
		expect(await duplicateMessageCreations(dbPath)).toEqual([]);
	}, 60_000);

	it("imports disjoint REST history while live messages remain", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-disjoint-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 200, []);
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a1", T0 + 2_000, "first answer");
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a1"] === "first answer",
			"the anchor",
		);
		await stack.stop();
		stack = undefined;

		mock.setExactResponse("GET", restPath, 200, [
			user("msg_u2", Date.now() + 60_000, "second question"),
		]);
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a3", T0 + 8_000, "third answer");
		await waitFor(
			async () =>
				(await projectedTexts(dbPath))["msg_a3"] === "third answer" &&
				(await projectedTexts(dbPath))["msg_u2"] === "second question",
			"disjoint REST history and live answer",
		);
		expect(await historyComplete(dbPath)).toBe(false);
		expect(await projectedTexts(dbPath)).toEqual({
			msg_a1: "first answer",
			msg_u2: "second question",
			msg_a3: "third answer",
		});
	}, 60_000);

	it("corrects a settled observed message from REST", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-repair-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 200, []);
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a1", T0 + 1_000, "world");
		mock.emitTestEvent("message.updated", {
			sessionID: SESSION_ID,
			info: assistantInfo("msg_a1", T0 + 1_000, T0 + 2_000),
		});
		await waitFor(
			async () =>
				(await projectedTexts(dbPath))["msg_a1"] === "world" &&
				(await messageRows(dbPath))[0]?.is_streaming === 0,
			"the incomplete settled message",
		);
		expect(await historyComplete(dbPath)).toBe(false);
		await stack.stop();
		stack = undefined;
		const requestsBefore = mock.diagnostics.filter(
			(entry) =>
				entry.event === "request" &&
				entry.detail?.startsWith(`GET ${restPath}`),
		).length;
		mock.setExactResponse("GET", restPath, 200, [
			{
				info: assistantInfo("msg_a1", T0 + 1_000, T0 + 2_000),
				parts: [textPart("msg_a1", "Hello world")],
			},
		]);
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a2", T0 + 3_000, "next answer");
		await waitFor(
			() =>
				(mock?.diagnostics.filter(
					(entry) =>
						entry.event === "request" &&
						entry.detail?.startsWith(`GET ${restPath}`),
				).length ?? 0) > requestsBefore,
			"REST history reconciliation",
		);
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a1"] === "Hello world",
			"REST correction",
		);
		expect((await projectedTexts(dbPath))["msg_a1"]).toBe("Hello world");
		expect(await historyComplete(dbPath)).toBe(false);
		expect(await duplicateMessageCreations(dbPath)).toEqual([]);
		const corrections = await readStore(
			dbPath,
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) => sql<{ n: number }>`
				SELECT COUNT(*) AS n FROM events WHERE session_id = ${SESSION_ID}
				AND type = 'message.snapshot' AND json_extract(data, '$.messageId') = 'msg_a1'`,
			),
		);
		expect(corrections[0]?.n).toBe(1);
	}, 60_000);

	it("settles a stored streaming assistant from REST", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-settle-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 200, []);
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a1", T0 + 2_000, "partial");
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a1"] === "partial",
			"streaming assistant",
		);
		await stack.stop();
		stack = undefined;
		const requestsBefore = mock.diagnostics.filter(
			(entry) =>
				entry.event === "request" &&
				entry.detail?.startsWith(`GET ${restPath}`),
		).length;
		mock.setExactResponse("GET", restPath, 200, [
			{
				info: assistantInfo("msg_a1", T0 + 2_000, T0 + 5_000),
				parts: [
					textPart("msg_a1", "complete answer"),
					{ ...a1.parts[0], messageID: "msg_a1" },
				],
			},
		]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.status", {
			sessionID: SESSION_ID,
			status: { type: "idle" },
		});
		await waitFor(
			() =>
				(mock?.diagnostics.filter(
					(entry) =>
						entry.event === "request" &&
						entry.detail?.startsWith(`GET ${restPath}`),
				).length ?? 0) > requestsBefore,
			"REST history reconciliation",
		);
		await waitFor(
			async () => (await messageRows(dbPath))[0]?.is_streaming === 0,
			"settled REST snapshot",
		);
		expect((await projectedTexts(dbPath))["msg_a1"]).toBe(
			"complete answer[bash]",
		);
		expect(await historyComplete(dbPath)).toBe(true);
	}, 60_000);

	it("imports a settled head before a stored user and proves the ordered history", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-head-user-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		mock.setExactResponse("GET", `/session/${SESSION_ID}/message`, 200, []);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("message.updated", {
			sessionID: SESSION_ID,
			info: u2.info,
		});
		mock.emitTestEvent("message.part.updated", {
			sessionID: SESSION_ID,
			part: u2.parts[0],
		});
		await waitFor(
			async () =>
				(await projectedTexts(dbPath))["msg_u2"] === "second question",
			"stored user",
		);
		await restartWithRest(mock, dbPath, [u1, a1, u2]);
		await waitFor(() => historyComplete(dbPath), "head reconciliation");
		expect(
			(await messageRows(dbPath)).map((row) => [row.id, row.is_backfilled]),
		).toEqual([
			["msg_u1", 1],
			["msg_a1", 1],
			["msg_u2", 0],
		]);
	});

	it.each([
		{ name: "streaming", completeBeforeImport: false },
		{ name: "settled", completeBeforeImport: true },
	])("attaches an unowned $name assistant to one imported user turn", async ({
		completeBeforeImport,
	}) => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-head-assistant-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		mock.setExactResponse("GET", `/session/${SESSION_ID}/message`, 200, []);
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a1", T0 + 2_000, "first answer");
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a1"] === "first answer",
			"unowned assistant",
		);
		const restAssistant = {
			info: assistantInfo("msg_a1", T0 + 2_000, T0 + 5_000),
			parts: [textPart("msg_a1", "first answer")],
		};
		if (completeBeforeImport) {
			mock.emitTestEvent("message.updated", {
				sessionID: SESSION_ID,
				info: restAssistant.info,
			});
			await waitFor(
				async () => (await messageRows(dbPath))[0]?.is_streaming === 0,
				"settled unowned assistant",
			);
		}
		await restartWithRest(mock, dbPath, [u1, restAssistant]);
		await waitFor(
			async () => (await messageRows(dbPath))[0]?.id === "msg_u1",
			"head import",
		);
		expect(await readTurns(dbPath)).toMatchObject([
			{ user_message_id: "msg_u1", assistant_message_id: "msg_a1" },
		]);
		if (!completeBeforeImport) {
			mock.emitTestEvent("message.updated", {
				sessionID: SESSION_ID,
				info: restAssistant.info,
			});
		}
		await waitFor(
			async () => (await readTurns(dbPath))[0]?.state === "completed",
			"single turn completion",
		);
		expect(await readTurns(dbPath)).toHaveLength(1);
		expect(
			await readStore(
				dbPath,
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql<{ cost: number; tokens_in: number; tokens_out: number }>`
				SELECT cost, tokens_in, tokens_out FROM turns WHERE assistant_message_id = 'msg_a1'`,
				),
			),
		).toEqual([{ cost: 0.01, tokens_in: 10, tokens_out: 5 }]);
		await waitFor(() => historyComplete(dbPath), "completed head history");
	});

	it("reattaches a head assistant to its REST parent turn", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-owned-head-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		mock.setExactResponse("GET", `/session/${SESSION_ID}/message`, 200, []);
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a1", T0 + 2_000, "first answer");
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a1"] === "first answer",
			"stored assistant",
		);
		await stack.stop();
		stack = undefined;
		await readStore(
			dbPath,
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) => sql`
			INSERT INTO turns (id, session_id, state, user_message_id, assistant_message_id, requested_at)
			VALUES ('old-turn', ${SESSION_ID}, 'running', 'old-user', 'msg_a1', ${T0 + 1_000})`,
			),
		);
		mock.setExactResponse("GET", `/session/${SESSION_ID}/message`, 200, [
			u1,
			{
				info: assistantInfo("msg_a1", T0 + 2_000, T0 + 5_000),
				parts: [textPart("msg_a1", "first answer")],
			},
		]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.status", {
			sessionID: SESSION_ID,
			status: { type: "idle" },
		});
		await waitFor(
			async () => (await readTurns(dbPath)).length === 2,
			"owned assistant reconciliation",
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect((await messageRows(dbPath)).map((row) => row.id)).toEqual([
			"msg_u1",
			"msg_a1",
		]);
		expect(await readTurns(dbPath)).toContainEqual(
			expect.objectContaining({
				user_message_id: "msg_u1",
				assistant_message_id: "msg_a1",
				state: "completed",
			}),
		);
		expect(await readTurns(dbPath)).toContainEqual(
			expect.objectContaining({
				user_message_id: "old-user",
				assistant_message_id: null,
				state: "pending",
			}),
		);
		expect(await historyComplete(dbPath)).toBe(true);
	});

	it("imports a head and an interior gap", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-head-gap-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		mock.setExactResponse("GET", `/session/${SESSION_ID}/message`, 200, []);
		stack = await startStack(mock, dbPath);
		for (const message of [u2, user("msg_u4", T0 + 9_000, "fourth question")]) {
			mock.emitTestEvent("message.updated", {
				sessionID: SESSION_ID,
				info: message.info,
			});
			mock.emitTestEvent("message.part.updated", {
				sessionID: SESSION_ID,
				part: message.parts[0],
			});
		}
		await waitFor(
			async () => (await messageRows(dbPath)).length === 2,
			"stored anchors",
		);
		await restartWithRest(mock, dbPath, [
			u1,
			u2,
			user("msg_u3", T0 + 7_000, "third question"),
			user("msg_u4", T0 + 9_000, "fourth question"),
		]);
		await waitFor(
			async () => (await messageRows(dbPath)).length === 4,
			"head and interior import",
		);
		expect((await messageRows(dbPath)).map((row) => row.id)).toEqual([
			"msg_u1",
			"msg_u2",
			"msg_u3",
			"msg_u4",
		]);
		expect(await historyComplete(dbPath)).toBe(true);
	});

	it("imports an interior REST user and repairs assistant ownership", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-turn-repair-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 200, []);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("message.updated", {
			sessionID: SESSION_ID,
			info: u1.info,
		});
		mock.emitTestEvent("message.part.updated", {
			sessionID: SESSION_ID,
			part: u1.parts[0],
		});
		streamLiveAssistant(mock, "msg_a1", T0 + 3_000, "answer");
		mock.emitTestEvent("message.updated", {
			sessionID: SESSION_ID,
			info: assistantInfo("msg_a1", T0 + 3_000, T0 + 5_000),
		});
		await waitFor(
			async () => (await messageRows(dbPath))[0]?.is_streaming === 0,
			"completed live assistant",
		);
		await stack.stop();
		stack = undefined;
		mock.setExactResponse("GET", restPath, 200, [
			u1,
			user("msg_u_missing", T0 + 2_000, "missing question"),
			{
				info: assistantInfo("msg_a1", T0 + 3_000, T0 + 5_000, "msg_u_missing"),
				parts: [textPart("msg_a1", "answer")],
			},
		]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.status", {
			sessionID: SESSION_ID,
			status: { type: "idle" },
		});
		await waitFor(
			async () => (await messageRows(dbPath)).length === 3,
			"REST reconciliation",
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect((await messageRows(dbPath)).map((row) => row.id)).toEqual([
			"msg_u1",
			"msg_u_missing",
			"msg_a1",
		]);
		expect(await historyComplete(dbPath)).toBe(true);
		expect(await readTurns(dbPath)).toContainEqual(
			expect.objectContaining({
				user_message_id: "msg_u1",
				assistant_message_id: null,
				state: "pending",
			}),
		);
		expect(await readTurns(dbPath)).toContainEqual(
			expect.objectContaining({
				user_message_id: "msg_u_missing",
				assistant_message_id: "msg_a1",
				state: "completed",
			}),
		);
	}, 60_000);

	it("imports an equal-time interior REST message", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-equal-time-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 200, []);
		stack = await startStack(mock, dbPath);
		for (const id of ["msg_A", "msg_a"]) {
			const message = user(id, T0 + 1_000, id);
			mock.emitTestEvent("message.updated", {
				sessionID: SESSION_ID,
				info: message.info,
			});
			mock.emitTestEvent("message.part.updated", {
				sessionID: SESSION_ID,
				part: message.parts[0],
			});
		}
		await waitFor(
			async () => (await messageRows(dbPath)).length === 2,
			"stored equal-time anchors",
		);
		await readStore(
			dbPath,
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql`UPDATE messages SET created_at = ${T0 + 1_000} WHERE session_id = ${SESSION_ID}`,
			),
		);
		await stack.stop();
		stack = undefined;
		mock.setExactResponse("GET", restPath, 200, [
			user("msg_A", T0 + 1_000, "msg_A"),
			user("msg_Z", T0 + 1_000, "msg_Z"),
			user("msg_a", T0 + 1_000, "msg_a"),
		]);
		const requestsBefore = mock.diagnostics.filter(
			(entry) =>
				entry.event === "request" &&
				entry.detail?.startsWith(`GET ${restPath}`),
		).length;
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.status", {
			sessionID: SESSION_ID,
			status: { type: "idle" },
		});
		await waitFor(
			() =>
				mock?.diagnostics.filter(
					(entry) =>
						entry.event === "request" &&
						entry.detail?.startsWith(`GET ${restPath}`),
				).length !== requestsBefore,
			"equal-time REST reconciliation",
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect((await messageRows(dbPath)).map((row) => row.id)).toEqual([
			"msg_A",
			"msg_Z",
			"msg_a",
		]);
		expect(await historyComplete(dbPath)).toBe(true);
	}, 60_000);

	it.each([
		"message",
		"part",
	] as const)("keeps history pending when a stored %s is absent from REST", async (removed) => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-rest-removal-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 200, []);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("message.updated", {
			sessionID: SESSION_ID,
			info: u1.info,
		});
		mock.emitTestEvent("message.part.updated", {
			sessionID: SESSION_ID,
			part: u1.parts[0],
		});
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_u1"] === "first question",
			"stored message and part",
		);
		await stack.stop();
		stack = undefined;
		mock.setExactResponse(
			"GET",
			restPath,
			200,
			removed === "message" ? [] : [{ info: u1.info, parts: [] }],
		);
		const requestsBefore = mock.diagnostics.filter(
			(entry) =>
				entry.event === "request" &&
				entry.detail?.startsWith(`GET ${restPath}`),
		).length;
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.status", {
			sessionID: SESSION_ID,
			status: { type: "idle" },
		});
		await waitFor(
			() =>
				mock?.diagnostics.filter(
					(entry) =>
						entry.event === "request" &&
						entry.detail?.startsWith(`GET ${restPath}`),
				).length !== requestsBefore,
			"REST removal reconciliation",
		);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(await historyComplete(dbPath)).toBe(false);
		expect((await projectedTexts(dbPath))["msg_u1"]).toBe("first question");
	}, 60_000);

	it.each([
		"message",
		"part",
	] as const)("invalidates complete history on live %s removal", async (removed) => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-live-removal-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		mock.setExactResponse("GET", `/session/${SESSION_ID}/message`, 200, [u1]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(() => historyComplete(dbPath), "complete imported history");
		if (removed === "message") {
			mock.emitTestEvent("message.removed", {
				sessionID: SESSION_ID,
				messageID: "msg_u1",
			});
		} else {
			mock.emitTestEvent("message.part.removed", {
				sessionID: SESSION_ID,
				messageID: "msg_u1",
				partID: "prt_msg_u1_text",
			});
		}
		await waitFor(
			async () => !(await historyComplete(dbPath)),
			"history invalidation after live removal",
			3_000,
		);
		expect((await projectedTexts(dbPath))["msg_u1"]).toBe("first question");
	}, 60_000);

	it("keeps an absent unsettled REST assistant pending", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-unsettled-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		mock.setExactResponse("GET", `/session/${SESSION_ID}/message`, 200, [
			u1,
			{ info: assistantInfo("msg_a_pending", T0 + 2_000), parts: [] },
		]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(
			async () => (await messageRows(dbPath)).length === 1,
			"settled REST user",
		);
		expect((await messageRows(dbPath)).map((row) => row.id)).toEqual([
			"msg_u1",
		]);
		expect(await historyComplete(dbPath)).toBe(false);
	}, 60_000);

	it("rechecks pending history after a live assistant completes without restart", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-pending-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		mock.setExactResponse("GET", `/session/${SESSION_ID}/message`, 200, [
			{
				info: assistantInfo("msg_a1", T0 + 2_000, T0 + 5_000),
				parts: [textPart("msg_a1", "answer")],
			},
		]);
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a1", T0 + 2_000, "answer");
		await waitFor(
			async () => (await messageRows(dbPath))[0]?.is_streaming === 1,
			"streaming row",
		);
		expect(await historyComplete(dbPath)).toBe(false);
		mock.emitTestEvent("message.updated", {
			sessionID: SESSION_ID,
			info: assistantInfo("msg_a1", T0 + 2_000, T0 + 5_000),
		});
		await waitFor(
			() => historyComplete(dbPath),
			"history to become complete after live SSE",
			10_000,
		);
	}, 60_000);

	it("corrects a mismatched stored message without repeated REST fetches", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-mismatch-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		const requestCount = () =>
			mock?.diagnostics.filter(
				(entry) =>
					entry.event === "request" &&
					entry.detail?.startsWith(`GET ${restPath}`),
			).length ?? 0;
		mock.setExactResponse("GET", restPath, 200, [
			{
				info: assistantInfo("msg_a1", T0 + 2_000, T0 + 5_000),
				parts: [textPart("msg_a1", "different answer")],
			},
		]);
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a1", T0 + 2_000, "live answer");
		mock.emitTestEvent("message.updated", {
			sessionID: SESSION_ID,
			info: assistantInfo("msg_a1", T0 + 2_000, T0 + 5_000),
		});
		await waitFor(() => historyComplete(dbPath), "REST correction", 12_000);
		expect(requestCount()).toBeLessThanOrEqual(4);
		expect((await projectedTexts(dbPath))["msg_a1"]).toBe("different answer");
	}, 60_000);

	it("preserves a busy turn with no assistant during reconciliation", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-busy-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 200, []);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("message.updated", {
			sessionID: SESSION_ID,
			info: u1.info,
		});
		mock.emitTestEvent("message.part.updated", {
			sessionID: SESSION_ID,
			part: u1.parts[0],
		});
		await waitFor(
			async () => (await readTurns(dbPath)).length === 1,
			"user turn",
		);
		await readStore(
			dbPath,
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql`UPDATE turns SET state = 'running' WHERE user_message_id = 'msg_u1'`,
			),
		);
		await waitFor(
			async () => (await readTurns(dbPath))[0]?.state === "running",
			"busy turn",
		);
		await readStore(
			dbPath,
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql`UPDATE sessions SET history_complete = 0 WHERE id = ${SESSION_ID}`,
			),
		);
		await stack.stop();
		stack = undefined;

		mock.setExactResponse("GET", restPath, 200, [u1]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(() => historyComplete(dbPath), "reconciled busy session");
		expect(await readTurns(dbPath)).toMatchObject([
			{
				user_message_id: "msg_u1",
				assistant_message_id: null,
				state: "running",
			},
		]);
	}, 60_000);

	it("preserves a resumed turn owned by its second streaming assistant", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-resumed-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 200, []);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("message.updated", {
			sessionID: SESSION_ID,
			info: u1.info,
		});
		mock.emitTestEvent("message.part.updated", {
			sessionID: SESSION_ID,
			part: u1.parts[0],
		});
		streamLiveAssistant(mock, "msg_a1", T0 + 2_000, "first answer");
		mock.emitTestEvent("message.updated", {
			sessionID: SESSION_ID,
			info: assistantInfo("msg_a1", T0 + 2_000, T0 + 5_000),
		});
		await waitFor(
			async () => (await readTurns(dbPath))[0]?.state === "completed",
			"first assistant completion",
		);
		streamLiveAssistant(mock, "msg_a2", T0 + 6_000, "second answer");
		await waitFor(
			async () =>
				(await readTurns(dbPath))[0]?.assistant_message_id === "msg_a2",
			"resumed assistant",
		);
		await readStore(
			dbPath,
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql`UPDATE sessions SET history_complete = 0 WHERE id = ${SESSION_ID}`,
			),
		);
		await stack.stop();
		stack = undefined;

		mock.setExactResponse("GET", restPath, 200, [
			u1,
			{
				info: assistantInfo("msg_a1", T0 + 2_000, T0 + 5_000),
				parts: [textPart("msg_a1", "first answer")],
			},
		]);
		stack = await startStack(mock, dbPath);
		const requestsBefore = mock.diagnostics.filter(
			(entry) =>
				entry.event === "request" &&
				entry.detail?.startsWith(`GET ${restPath}`),
		).length;
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(
			() =>
				mock?.diagnostics.filter(
					(entry) =>
						entry.event === "request" &&
						entry.detail?.startsWith(`GET ${restPath}`),
				).length !== requestsBefore,
			"resumed session REST reconciliation",
		);
		expect(await historyComplete(dbPath)).toBe(false);
		expect(await readTurns(dbPath)).toMatchObject([
			{
				user_message_id: "msg_u1",
				assistant_message_id: "msg_a2",
				state: "running",
			},
		]);
	}, 60_000);

	it("bounds REST retry attempts while an outage delivers a burst of events", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-backoff-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		const requestCount = () =>
			mock?.diagnostics.filter(
				(entry) =>
					entry.event === "request" &&
					entry.detail?.startsWith(`GET ${restPath}`),
			).length ?? 0;
		mock.setExactResponse("GET", restPath, 400, { error: "unavailable" });
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a2", T0 + 7_000, "live answer");
		await waitFor(() => requestCount() > 0, "the initial REST attempt");
		await new Promise((resolve) => setTimeout(resolve, 200));
		const beforeBurst = requestCount();
		for (let index = 0; index < 5; index++) {
			mock.emitTestEvent("message.part.updated", {
				sessionID: SESSION_ID,
				part: textPart("msg_a2", `live answer ${"01234".slice(0, index + 1)}`),
			});
		}
		await waitFor(
			async () =>
				(await projectedTexts(dbPath))["msg_a2"] === "live answer 01234",
			"all live deltas during retry backoff",
		);
		expect(requestCount()).toBe(beforeBurst);
		expect((await projectedTexts(dbPath))["msg_a2"]).toBe("live answer 01234");
	}, 60_000);

	it("serves backfilled messages after a live anchor despite provider clock skew", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-clock-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 200, []);
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a1", T0 + 1_000, "first answer");
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a1"] === "first answer",
			"live anchor",
		);
		await stack.stop();
		stack = undefined;

		mock.setExactResponse("GET", restPath, 200, [
			{
				info: assistantInfo("msg_a1", T0 + 1_000, T0 + 2_000),
				parts: [textPart("msg_a1", "first answer")],
			},
			user("msg_u2", T0 + 1_001, "second question"),
			{ info: assistantInfo("msg_a3", T0 + 1_002), parts: [] },
		]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(
			async () =>
				(await projectedTexts(dbPath))["msg_u2"] === "second question",
			"tail REST user",
		);
		streamLiveAssistant(mock, "msg_a3", T0 + 1_002, "third answer");
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a3"] === "third answer",
			"third message",
		);
		expect((await messageRows(dbPath)).map((row) => row.id)).toEqual([
			"msg_a1",
			"msg_u2",
			"msg_a3",
		]);
	}, 60_000);

	it("orders clock-reversed snapshots by REST time and attaches by parentID", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-clock-turn-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		mock.setExactResponse("GET", restPath, 200, []);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("message.updated", {
			sessionID: SESSION_ID,
			info: u1.info,
		});
		mock.emitTestEvent("message.part.updated", {
			sessionID: SESSION_ID,
			part: u1.parts[0],
		});
		streamLiveAssistant(mock, "msg_a1", T0 + 1_001, "first answer");
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a1"] === "first answer",
			"stored first turn",
		);
		await readStore(
			dbPath,
			Effect.flatMap(SqlClient.SqlClient, (sql) =>
				Effect.gen(function* () {
					yield* sql`UPDATE messages SET created_at = ${T0 + 1_000} WHERE id = 'msg_u1'`;
					yield* sql`UPDATE messages SET created_at = ${T0 + 1_001} WHERE id = 'msg_a1'`;
					yield* sql`UPDATE turns SET requested_at = ${T0 + 1_000} WHERE id = 'msg_u1'`;
				}),
			),
		);
		await stack.stop();
		stack = undefined;
		mock.setExactResponse("GET", restPath, 200, [
			user("msg_u1", T0 + 1_000, "first question"),
			{
				info: assistantInfo("msg_a1", T0 + 500, T0 + 501),
				parts: [textPart("msg_a1", "first answer")],
			},
			user("msg_u2", T0 + 498, "second question"),
			{
				info: assistantInfo("msg_a2", T0 + 2_000, T0 + 2_100),
				parts: [textPart("msg_a2", "second answer")],
			},
		]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(
			async () =>
				(await projectedTexts(dbPath))["msg_u2"] === "second question",
			"clock-reversed REST user",
		);
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a2"] === "second answer",
			"clock-reversed REST assistant",
		);
		expect(await historyComplete(dbPath)).toBe(false);
		const rows = await messageRows(dbPath);
		expect(rows.map((row) => row.id)).toEqual([
			"msg_u2",
			"msg_a1",
			"msg_u1",
			"msg_a2",
		]);
		expect(rows[2]?.created_at).toBeGreaterThan(rows[1]?.created_at ?? 0);
		const turns = await readStore(
			dbPath,
			Effect.flatMap(
				SqlClient.SqlClient,
				(sql) =>
					sql<{ user_message_id: string; assistant_message_id: string | null }>`
					SELECT user_message_id, assistant_message_id FROM turns
					WHERE session_id = ${SESSION_ID} ORDER BY requested_at`,
			),
		);
		expect(turns).toEqual([
			{ user_message_id: "msg_u2", assistant_message_id: "msg_a2" },
			{ user_message_id: "msg_u1", assistant_message_id: "msg_a1" },
		]);
	}, 60_000);

	it("leaves provider-ahead unsettled REST history pending", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-ahead-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const ahead = Date.now() + 300_000;
		mock.setExactResponse("GET", `/session/${SESSION_ID}/message`, 200, [
			user("msg_u1", ahead, "first question"),
			{ info: assistantInfo("msg_a2", ahead + 1_000), parts: [] },
		]);
		stack = await startStack(mock, dbPath);
		streamLiveAssistant(mock, "msg_a2", ahead + 1_000, "live answer");
		await waitFor(
			async () => (await projectedTexts(dbPath))["msg_a2"] === "live answer",
			"live message",
		);
		const rows = await messageRows(dbPath);
		expect(rows.map((row) => row.id)).toEqual(["msg_a2"]);
		expect(await historyComplete(dbPath)).toBe(false);
	}, 60_000);

	it("invalidates on an untranslated step part, then snapshots the REST correction once", async () => {
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "conduit-iea-step-recheck-")),
			"events.sqlite",
		);
		mock = new MockOpenCodeServer(loadOpenCodeRecording("chat-simple"));
		await mock.start();
		const restPath = `/session/${SESSION_ID}/message`;
		const step = {
			id: "prt_late_step",
			sessionID: SESSION_ID,
			messageID: "msg_a1",
			type: "step-finish",
			cost: 0.01,
		};
		mock.setExactResponse("GET", restPath, 200, [
			u1,
			{ ...a1, parts: [textPart("msg_a1", "first answer")] },
		]);
		stack = await startStack(mock, dbPath);
		mock.emitTestEvent("session.created", {
			info: { id: SESSION_ID, title: "Existing session" },
		});
		await waitFor(() => historyComplete(dbPath), "initial complete history");
		const snapshotCount = async () => {
			const [row] = await readStore(
				dbPath,
				Effect.flatMap(
					SqlClient.SqlClient,
					(sql) =>
						sql<{
							n: number;
						}>`SELECT COUNT(*) AS n FROM events WHERE session_id = ${SESSION_ID} AND type = 'message.snapshot'`,
				),
			);
			return row?.n ?? 0;
		};
		expect(await snapshotCount()).toBe(2);
		mock.setExactResponse("GET", restPath, 200, [
			u1,
			{ ...a1, parts: [textPart("msg_a1", "first answer"), step] },
		]);
		mock.emitTestEvent("message.part.updated", {
			sessionID: SESSION_ID,
			part: step,
		});
		await waitFor(
			async () => !(await historyComplete(dbPath)),
			"invalidated history",
		);
		mock.emitTestEvent("session.status", {
			sessionID: SESSION_ID,
			status: { type: "idle" },
		});
		await waitFor(() => historyComplete(dbPath), "corrected step snapshot");
		const rows = await readStore(
			dbPath,
			Effect.flatMap(makeReadQueryEffect, (readQuery) =>
				readQuery.getSessionMessagesWithParts(SESSION_ID),
			),
		);
		expect(
			rows.find((row) => row.id === "msg_a1")?.parts.map((part) => part.type),
		).toEqual(["text", "step-finish"]);
		expect(await snapshotCount()).toBe(3);
		mock.emitTestEvent("session.status", {
			sessionID: SESSION_ID,
			status: { type: "idle" },
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(await snapshotCount()).toBe(3);
		const requestsBefore = mock.diagnostics.filter(
			(entry) =>
				entry.event === "request" &&
				entry.detail?.startsWith(`GET ${restPath}`),
		).length;
		await restartWithRest(mock, dbPath, [
			u1,
			{ ...a1, parts: [textPart("msg_a1", "first answer"), step] },
		]);
		await waitFor(
			() =>
				(mock?.diagnostics.filter(
					(entry) =>
						entry.event === "request" &&
						entry.detail?.startsWith(`GET ${restPath}`),
				).length ?? 0) > requestsBefore,
			"unchanged REST fetch",
		);
		await waitFor(() => historyComplete(dbPath), "unchanged REST recheck");
		expect(await snapshotCount()).toBe(3);
	}, 60_000);
});
