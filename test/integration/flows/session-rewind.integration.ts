import { channel } from "node:diagnostics_channel";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionDetailEnvelopeSchema } from "../../../src/lib/contracts/ws-rpc.js";
import type { ReadModelRead } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import {
	applyTranscriptEnvelope,
	type TranscriptEntry,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { readOwedRealignment } from "../../../src/lib/persistence/effect/head-realignment.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import type { StoredEventRow } from "../../../src/lib/persistence/effect/stored-event-row.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";
import type { TestWsClient } from "../helpers/test-ws-client.js";

type DetailEnvelope = typeof SessionDetailEnvelopeSchema.Type;
const keptIds = ["a-kept-user", "b-kept-assistant"];
const hiddenIds = ["c-cut-user", "d-hidden-assistant"];
const seededIds = [...keptIds, ...hiddenIds];

/**
 * What a tab holds, folded as the browser folds it: a removed message takes
 * its parts with it, so a message restored without its parts comes back empty.
 * `ids` names only the seeded messages held whole, header and text part.
 */
function detailState(
	client: TestWsClient,
	sessionId: string,
	messageIds = seededIds,
) {
	let entry: TranscriptEntry = {
		project: "integration-test",
		rows: [],
		pending: [],
		hwm: null,
		hasMore: false,
		status: { _tag: "live" },
		waiting: new Map(),
		partOrder: new Map(),
	};
	for (const frame of client.getReceivedOfType("session_detail")) {
		if (frame["sessionId"] !== sessionId) continue;
		entry = applyTranscriptEnvelope(entry, frame as unknown as DetailEnvelope);
	}
	return {
		ids: entry.rows
			.filter(
				({ id, parts }) =>
					messageIds.includes(id) &&
					parts?.some((part) => part.id === `${id}-text`),
			)
			.map(({ id }) => id)
			.sort(),
	};
}

/**
 * 82tn.51: a rewind lands at once as a head move; the provider still owes its cut until the
 * next send tells it. The owed cut's first message, or null once the provider has it.
 */
const owedCut = (harness: DaemonProject, sessionId: string) =>
	harness.run(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			return (
				(yield* readOwedRealignment(sql, sessionId))?.rewind?.targetMessageId ??
				null
			);
		}),
	);

function persistedRewinds(harness: DaemonProject, sessionId: string) {
	const db = new Database(harness.eventsDbPath, { readonly: true });
	try {
		return {
			events: db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND type IN ('head.move_started', 'head.moved', 'session.rewind_committed', 'message.removed', 'turn.error') ORDER BY sequence",
				)
				.all(sessionId) as Array<{ type: string; data: string }>,
			messages: db
				.prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY rowid")
				.all(sessionId) as Array<{ id: string }>,
			tombstones: db
				.prepare(
					"SELECT message_id, version FROM message_tombstones WHERE session_id = ? ORDER BY version",
				)
				.all(sessionId) as Array<{ message_id: string; version: number }>,
		};
	} finally {
		db.close();
	}
}

async function seedTurns(
	harness: DaemonProject,
	client: TestWsClient,
	messageIds = seededIds,
	withTools = false,
	orderedClocks = false,
) {
	const created = await client.createSession("Pending rewind", {
		providerId: "opencode",
	});
	const sessionId = String(created["id"]);
	// Equal provider clocks must order by id regardless of ingestion timing.
	const createdAt = Date.now() - 1000;
	harness.mock.injectSSEEvents(
		messageIds.flatMap((id, index) => [
			{
				type: "message.updated",
				properties: {
					info: {
						id,
						sessionID: sessionId,
						role: index % 2 === 0 ? "user" : "assistant",
						...(index % 2 === 0
							? {
									agent: "build",
									model: {
										providerID: "anthropic",
										modelID: "claude-opus-4-5-20251101",
									},
								}
							: {
									parentID: messageIds[index - 1],
									modelID: "claude-opus-4-5-20251101",
									providerID: "anthropic",
									mode: "build",
									path: { cwd: process.cwd(), root: process.cwd() },
									cost: 0,
									tokens: {
										input: 0,
										output: 0,
										reasoning: 0,
										cache: { read: 0, write: 0 },
									},
								}),
						time: {
							created: createdAt + (orderedClocks ? index : 0),
							...(!withTools ? { completed: createdAt } : {}),
						},
					},
				},
			},
			{
				type: "message.part.updated",
				properties: {
					part: {
						id: `${id}-text`,
						sessionID: sessionId,
						messageID: id,
						type: "text",
						text: id,
					},
				},
			},
			...(withTools && index % 2 === 1
				? [
						{
							type: "message.part.updated",
							properties: {
								part: {
									id: `${id}-tool`,
									sessionID: sessionId,
									messageID: id,
									type: "tool",
									callID: `${id}-call`,
									tool: "bash",
									state: {
										status: "completed",
										input: { command: `echo ${id}` },
										output: id,
										time: { start: createdAt, end: createdAt + 1 },
									},
								},
							},
						},
					]
				: []),
			...(!withTools && index % 2 === 1
				? [
						{
							type: "session.status",
							properties: { sessionID: sessionId, status: { type: "idle" } },
						},
					]
				: []),
		]),
	);
	await vi.waitFor(
		async () => {
			const page = await client.loadMoreHistory(sessionId);
			expect(page.messages.map((message) => message.id)).toEqual(
				expect.arrayContaining(messageIds.slice(-50)),
			);
		},
		{ timeout: messageIds.length > 50 ? 30_000 : 5000 },
	);
	await harness.run(seedNodes(sessionId, messageIds));
	return sessionId;
}

// 82tn.51: a rewind is a head move, so each seeded turn is an ended Run's history node. The
// relay's SSE-only replies end no Run here, so the seed records the nodes a Run's end would.
const seedNodes = (sessionId: string, messageIds: readonly string[]) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		for (let index = 0; index < messageIds.length; index += 2) {
			const node = `seed-${index / 2}`;
			yield* sql`INSERT INTO history_nodes (session_id, id, parent_id, run_id, available, created_at)
				VALUES (${sessionId}, ${node}, ${index === 0 ? null : `seed-${index / 2 - 1}`}, ${node}, 1, 0)`;
			yield* sql`UPDATE messages SET history_node_id = ${node}
				WHERE session_id = ${sessionId} AND id IN ${sql.in(messageIds.slice(index, index + 2))}`;
			yield* sql`INSERT INTO history_heads (session_id, node_id) VALUES (${sessionId}, ${node})
				ON CONFLICT (session_id) DO UPDATE SET node_id = excluded.node_id`;
		}
	});

const rewindProjection = (sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		// Replay assigns its own read-model clock; all persisted content and
		// event sequence references must still match the live projection.
		const content = (rows: readonly Record<string, unknown>[]) =>
			rows.map((row) =>
				Object.fromEntries(
					Object.entries(row).filter(([key]) => key !== "version"),
				),
			);
		return {
			messages: content(
				yield* sql`SELECT * FROM messages WHERE session_id = ${sessionId} ORDER BY id`,
			),
			turns: content(
				yield* sql`SELECT * FROM turns WHERE session_id = ${sessionId} ORDER BY id`,
			),
			tombstones: content(
				yield* sql`SELECT * FROM message_tombstones WHERE session_id = ${sessionId} ORDER BY message_id`,
			),
			parts: content(
				yield* sql`SELECT p.* FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ${sessionId} ORDER BY p.id`,
			),
			session:
				yield* sql`SELECT fork_point_timestamp, last_user_message_at FROM sessions WHERE id = ${sessionId}`,
		};
	});

async function replayRewind(
	sessionId: string,
	rows: readonly StoredEventRow[],
	seededIds: readonly string[],
) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const runner = yield* ProjectionRunnerEffectTag;
			// 82tn.51: the seed's nodes are not journalled, so replay records them where the live seed
			// did: after the seeded turns, before the first head move.
			const moved = rows.findIndex(({ type }) => type === "head.move_started");
			yield* sql`INSERT INTO events ${sql.insert(rows.slice(0, moved).map((row) => ({ ...row })))}`;
			yield* runner.recover();
			yield* seedNodes(sessionId, seededIds);
			yield* sql`INSERT INTO events ${sql.insert(rows.slice(moved).map((row) => ({ ...row })))}`;
			yield* runner.recover();
			expect(yield* runner.getFailures()).toEqual([]);
			return yield* rewindProjection(sessionId);
		}).pipe(
			Effect.provide(
				makePersistenceEffectLayer(":memory:", "integration-test"),
			),
		),
	);
}

describe("OpenCode rewind through the relay", () => {
	let harness: DaemonProject | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async (context) => {
		if (!harness) return;
		const fixture = harness;
		harness = undefined;
		try {
			evidence["bodies"] = fixture.mock.requestBodies;
			evidence["requests"] = fixture.mock.diagnostics.filter(
				(entry) =>
					entry.event === "request" &&
					/\/(revert|unrevert|fork|message\/[^/]+|prompt_async|prompt)(?:\?|$)/.test(
						entry.detail ?? "",
					),
			);
			await fixture.stop();
		} finally {
			mkdirSync("test-results/rewind", { recursive: true });
			writeFileSync(
				`test-results/rewind/opencode-${context.task.name.replace(/\W+/g, "-")}.json`,
				JSON.stringify(evidence, null, 2),
			);
		}
	});

	// Failure cases: a short tail rewrite stamps the entire transcript, a moved
	// cut loses restored parts, or a viewer's newest page leaks hidden messages.
	it("bounds rewind and undo projection writes in a large transcript", async () => {
		harness = await createDaemonProject();
		evidence = { tickets: ["conduit-test-yyin", "conduit-test-qr9d"] };
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const messageIds = Array.from(
			{ length: 200 },
			(_, index) => `large-${String(index).padStart(4, "0")}`,
		);
		const sessionId = await seedTurns(harness, client, messageIds);
		const viewer = await harness.connectWsClient();
		await viewer.switchSession(sessionId);
		expect(detailState(viewer, sessionId, messageIds)).toEqual({
			ids: messageIds.slice(-50),
		});
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			const writes = () => {
				// 82tn.51: a head move tombstones the cut at its version and rewrites no kept row.
				const { version } = db
					.prepare(
						"SELECT MAX((SELECT MAX(p.version) FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ?), (SELECT COALESCE(MAX(version), 0) FROM message_tombstones WHERE session_id = ?)) AS version",
					)
					.get(sessionId, sessionId) as { version: number };
				// Status reconciliation can move the session row after the rewind.
				// Count the transcript writes at their own version instead.
				return {
					version,
					messages: (
						db
							.prepare(
								"SELECT count(*) AS n FROM messages WHERE session_id = ? AND version = ?",
							)
							.get(sessionId, version) as { n: number }
					).n,
					parts: (
						db
							.prepare(
								"SELECT count(*) AS n FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ? AND p.version = ?",
							)
							.get(sessionId, version) as { n: number }
					).n,
				};
			};
			// Opening the session starts its first REST reconcile, which snapshots
			// all 200 rows whenever it lands; let it land before the counted window.
			await vi.waitFor(
				() =>
					expect(
						db
							.prepare("SELECT history_complete FROM sessions WHERE id = ?")
							.get(sessionId),
					).toEqual({ history_complete: 1 }),
				{ timeout: 10_000 },
			);
			let previousVersion = writes().version;
			// 82tn.51: each rewind lands at once, so the next cut must still be on the Head.
			for (const cut of [196, 190, 180]) {
				const messageId = messageIds[cut];
				if (!messageId) throw new Error("Missing large transcript cut");
				await client.rpcCall((rpc) =>
					rpc.RewindSession({
						sessionId,
						messageId,
					}),
				);
				const projected = writes();
				expect(projected.version).toBeGreaterThan(previousVersion);
				previousVersion = projected.version;
				evidence[`cut-${cut}`] = projected;
				// At most the affected tail's headers and one 50-message page.
				expect.soft(projected.messages).toBeLessThanOrEqual(70);
				expect.soft(projected.parts).toBeLessThanOrEqual(50);
				await vi.waitFor(() => {
					// The browser preserves the cold page's floor while dropping rows.
					expect(detailState(viewer, sessionId, messageIds).ids).toEqual(
						messageIds.slice(150, cut),
					);
				});
				const visible = await viewer.loadMoreHistory(sessionId);
				expect(visible.messages.map(({ id }) => id)).toEqual(
					messageIds.slice(cut - visible.messages.length, cut),
				);
			}
			await client.rpcCall((rpc) => rpc.UndoRewind({ sessionId }));
			const undone = writes();
			expect(undone.version).toBeGreaterThan(previousVersion);
			evidence["undo"] = undone;
			expect.soft(undone.messages).toBeLessThanOrEqual(70);
			expect.soft(undone.parts).toBeLessThanOrEqual(50);
			// 82tn.51: the undo takes back the newest move, the rewind to 180.
			await vi.waitFor(() =>
				expect(detailState(viewer, sessionId, messageIds).ids).toEqual(
					messageIds.slice(150, 190),
				),
			);
			const restored = await viewer.loadMoreHistory(sessionId);
			expect(restored.messages.map(({ id }) => id)).toEqual(
				messageIds.slice(190 - restored.messages.length, 190),
			);
			expect(persistedRewinds(harness, sessionId).messages).toHaveLength(190);
		} finally {
			db.close();
		}
	}, 60_000);

	// Failure cases: equal timestamps change the cut, another tab misses the
	// landed cut, paging leaks hidden messages, undo loses turns, or duplicate
	// provider removals fail after the committed transcript has removed them.
	it("commits a long transcript when the cut is removed first, coalesces duplicate removals, then replays it", async () => {
		// Outside the worktree, whose git changes stamp the session and add reads.
		const projectDir = realpathSync(
			mkdtempSync(join(tmpdir(), "rewind-project-")),
		);
		onTestFinished(() => rmSync(projectDir, { recursive: true, force: true }));
		harness = await createDaemonProject("chat-simple", { projectDir });
		evidence = { ticket: "conduit-test-hiuf.4" };
		const fixture = harness;
		const client = await fixture.connectWsClient();
		await client.waitForInitialState();
		const messageIds = Array.from(
			{ length: 24 },
			(_, index) => `range-${String(index).padStart(2, "0")}`,
		);
		const sessionId = await seedTurns(fixture, client, messageIds, true);
		const removedIds = messageIds.slice(2);
		const target = removedIds[0] as string;
		const project = () => fixture.run(rewindProjection(sessionId));
		await vi.waitFor(async () => {
			const seeded = await project();
			expect(
				seeded.parts.filter((part) => part["type"] === "tool"),
			).toHaveLength(12);
			expect(seeded.turns).toHaveLength(12);
			expect(
				seeded.turns.every(
					(turn) => turn["user_message_id"] && turn["assistant_message_id"],
				),
			).toBe(true);
		});
		const db = new Database(fixture.eventsDbPath, { readonly: true });
		// The folder's first git read stamps the session whenever it lands; let it
		// land before the counted window. The folder never changes after it.
		await vi.waitFor(() =>
			expect(
				db
					.prepare("SELECT 1 FROM session_git_published WHERE directory = ?")
					.get(projectDir),
			).toBeDefined(),
		);
		await client.rpcCall((rpc) =>
			rpc.RewindSession({ sessionId, messageId: target }),
		);
		await vi.waitFor(() =>
			expect(detailState(client, sessionId, messageIds)).toEqual({
				ids: messageIds.slice(0, 2),
			}),
		);
		expect(await owedCut(fixture, sessionId)).toBe(target);
		const reads: ReadModelRead[] = [];
		const readChannel = channel("conduit:read-model-read");
		const observeRead = (message: unknown) => {
			const read = message as ReadModelRead;
			if (
				read.source === `session-detail/${sessionId}` &&
				read.kind === "window"
			)
				reads.push(read);
		};
		readChannel.subscribe(observeRead);
		try {
			const { sequence: before } = db
				.prepare("SELECT MAX(sequence) AS sequence FROM events")
				.get() as { sequence: number };
			// The cut commits the whole range. Later duplicate removals and
			// content for that range share its ingestion batch.
			fixture.mock.injectSSEEvents([
				...removedIds.map((messageID) => ({
					type: "message.removed",
					properties: { sessionID: sessionId, messageID },
				})),
				{
					type: "message.part.updated",
					properties: {
						part: {
							id: `${target}-text`,
							sessionID: sessionId,
							messageID: target,
							type: "text",
							text: "must not restore the committed tail",
						},
					},
				},
			]);
			await vi.waitFor(async () =>
				expect(await owedCut(fixture, sessionId)).toBeNull(),
			);
			expect(detailState(client, sessionId, messageIds)).toEqual({
				ids: messageIds.slice(0, 2),
			});
			const appended = db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence",
				)
				.all(sessionId, before) as Array<{ type: string; data: string }>;
			// 82tn.51: the commit names the head move the provider now has.
			expect(
				appended.map(({ type, data }) => ({ type, data: JSON.parse(data) })),
			).toEqual([
				{
					type: "session.rewind_committed",
					data: { messageId: target, moveId: expect.any(String) },
				},
			]);
			expect(reads).toHaveLength(1);
			const live = await project();
			expect(live.messages.map((message) => message["id"])).toEqual(
				messageIds.slice(0, 2),
			);
			expect(live.parts.map((part) => part["id"])).toEqual([
				`${messageIds[0]}-text`,
				`${messageIds[1]}-text`,
				`${messageIds[1]}-tool`,
			]);
			expect(live.tombstones.map((row) => row["message_id"])).toEqual(
				removedIds,
			);
			for (const turn of live.turns) {
				if (removedIds.includes(String(turn["id"]))) {
					expect(turn["user_message_id"]).toBeNull();
					expect(turn["assistant_message_id"]).toBeNull();
				}
			}
			const versions = db
				.prepare(
					"SELECT DISTINCT version FROM message_tombstones WHERE session_id = ?",
				)
				.all(sessionId);
			expect(versions).toHaveLength(1);
			const rows = db
				.prepare(
					"SELECT project_id, sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as StoredEventRow[];
			const replayed = await replayRewind(sessionId, rows, messageIds);
			expect(replayed).toEqual(live);
			// 82tn.51: the harness replays the store without the seed's unjournalled nodes, so its
			// row diffs are expected; replayRewind above replays the rewind with them.
			const parity = await fixture.checkReplayParity();
			expect(parity.danglingPartPointers).toEqual([]);
			evidence["rangeCommit"] = {
				appended,
				reads,
				live,
				replayed,
				parity,
			};
		} finally {
			readChannel.unsubscribe(observeRead);
			db.close();
		}
	}, 60_000);

	async function fixture(ids = seededIds, orderedClocks = false) {
		harness = await createDaemonProject();
		evidence = { ticket: "conduit-test-82tn.55" };
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const sessionId = await seedTurns(
			harness,
			client,
			ids,
			false,
			orderedClocks,
		);
		const second = await harness.connectWsClient();
		await second.switchSession(sessionId);
		return { relay: harness, client, second, sessionId };
	}

	function wire(relay: DaemonProject, sessionId: string) {
		return relay.mock.requestBodies.filter(
			(request) =>
				request.path.startsWith(`/session/${sessionId}/`) &&
				(request.method === "DELETE" ||
					/\/(prompt_async|prompt|revert|unrevert|fork)$/.test(request.path)),
		);
	}

	async function nativeIds(relay: DaemonProject, sessionId: string) {
		const response = await fetch(
			`${relay.mock.url}/session/${sessionId}/message`,
		);
		const messages = (await response.json()) as Array<{ info: { id: string } }>;
		return messages.map(({ info }) => info.id);
	}

	async function rewind(
		client: TestWsClient,
		sessionId: string,
		messageId = "c-cut-user",
	) {
		await client.rpcCall((rpc) => rpc.RewindSession({ sessionId, messageId }));
	}

	it("hides and restores across tabs locally, then deletes the tail before prompting the same session", async () => {
		const { relay, client, second, sessionId } = await fixture();
		const before = relay.mock.diagnostics.length;
		await rewind(client, sessionId);
		await vi.waitFor(() => {
			for (const tab of [client, second])
				expect(detailState(tab, sessionId)).toEqual({ ids: keptIds });
		});
		await second.rpcCall((rpc) => rpc.UndoRewind({ sessionId }));
		await vi.waitFor(() => {
			for (const tab of [client, second])
				expect(detailState(tab, sessionId)).toEqual({ ids: seededIds });
		});
		expect(
			relay.mock.diagnostics
				.slice(before)
				.filter(({ event }) => event === "request"),
		).toEqual([]);
		await rewind(client, sessionId);
		const commitsBeforeDeletion: number[] = [];
		const emit = relay.mock.emitTestEvent.bind(relay.mock);
		vi.spyOn(relay.mock, "emitTestEvent").mockImplementation(
			(type, properties) => {
				if (type === "message.removed")
					commitsBeforeDeletion.push(
						persistedRewinds(relay, sessionId).events.filter(
							({ type }) => type === "session.rewind_committed",
						).length,
					);
				emit(type, properties);
			},
		);
		await client.sendMessage("Commit the rewind", { sessionId });
		await client.waitForTurnEnd(sessionId);
		expect(
			wire(relay, sessionId).map(({ method, path }) => `${method} ${path}`),
		).toEqual([
			`DELETE /session/${sessionId}/message/d-hidden-assistant`,
			`DELETE /session/${sessionId}/message/c-cut-user`,
			`POST /session/${sessionId}/prompt_async`,
		]);
		// 82tn.52: the send first copies the session whole, so the dropped tail stays in
		// OpenCode for a later branch switch, then truncates the same session in place.
		const sent = relay.mock.diagnostics
			.slice(before)
			.flatMap(({ event, detail }) =>
				event === "request" && detail ? [detail.split("?")[0]] : [],
			);
		expect(
			sent.filter((request) => request === `POST /session/${sessionId}/fork`),
		).toHaveLength(1);
		expect(sent.indexOf(`POST /session/${sessionId}/fork`)).toBeLessThan(
			sent.indexOf(`DELETE /session/${sessionId}/message/d-hidden-assistant`),
		);
		expect(commitsBeforeDeletion).toEqual([0, 0]);
		const native = await nativeIds(relay, sessionId);
		expect(native).toEqual(expect.arrayContaining(keptIds));
		for (const id of hiddenIds) expect(native).not.toContain(id);
		const committed = persistedRewinds(relay, sessionId);
		expect(await owedCut(relay, sessionId)).toBeNull();
		expect(
			committed.events.filter(
				({ type }) => type === "session.rewind_committed",
			),
		).toHaveLength(1);
		const history = await client.loadMoreHistory(sessionId);
		const newIds = history.messages
			.map(({ id }) => id)
			.filter((id) => !seededIds.includes(id));
		expect(newIds.length).toBeGreaterThanOrEqual(2);
		for (const tab of [client, second]) {
			await tab.waitForTranscriptMessage(
				(message) => newIds.includes(message.id),
				sessionId,
			);
			expect(tab.getActiveSessionId()).toBe(sessionId);
			expect(detailState(tab, sessionId)).toEqual({ ids: keptIds });
			expect(
				(await tab.loadMoreHistory(sessionId)).messages.map(({ id }) => id),
			).toEqual(history.messages.map(({ id }) => id));
		}
		evidence["committed"] = committed;
		evidence["native"] = native;
		evidence["commitsBeforeDeletion"] = commitsBeforeDeletion;
	});

	it("keeps the cut owed and fails the send when deleting the cut fails (82tn.51)", async () => {
		const { relay, client, sessionId } = await fixture();
		await rewind(client, sessionId);
		relay.mock.setExactResponse(
			"DELETE",
			`/session/${sessionId}/message/c-cut-user`,
			500,
			{ error: "cut delete failed" },
		);
		await client.sendMessage("Must fail", { sessionId });
		await client.waitForTurnEnd(sessionId);
		const owed = persistedRewinds(relay, sessionId);
		expect(
			owed.events.some(
				({ type, data }) =>
					type === "turn.error" && data.includes('"code":"SEND_FAILED"'),
			),
		).toBe(true);
		expect(await owedCut(relay, sessionId)).toBe("c-cut-user");
		expect(
			owed.events.filter(({ type }) => type === "session.rewind_committed"),
		).toEqual([]);
		expect(wire(relay, sessionId).some(({ method }) => method === "POST")).toBe(
			false,
		);
		evidence["owed"] = owed;
	});

	it("converges after partial truncation and commits the cut exactly once on resend", async () => {
		const ids = [...seededIds, "e-middle-user", "f-last-assistant"];
		const { relay, client, sessionId } = await fixture(ids);
		await rewind(client, sessionId);
		const failedPath = `/session/${sessionId}/message/e-middle-user`;
		relay.mock.setExactResponse("DELETE", failedPath, 500, {
			error: "interrupted delete",
		});
		await client.sendMessage("Interrupted turn", {
			sessionId,
			commandId: "retry-first",
		});
		await client.waitForTurnEnd(sessionId);
		expect(
			persistedRewinds(relay, sessionId).events.some(
				({ type, data }) =>
					type === "turn.error" && data.includes('"code":"SEND_FAILED"'),
			),
		).toBe(true);
		expect(await nativeIds(relay, sessionId)).not.toContain("f-last-assistant");
		expect(await owedCut(relay, sessionId)).toBe("c-cut-user");
		relay.mock.setExactResponse("DELETE", failedPath, 200, true);
		await client.sendMessage("Second turn survives", {
			sessionId,
			commandId: "retry-second",
		});
		await client.waitForTurnEnd(sessionId);
		const native = await nativeIds(relay, sessionId);
		expect(native).toEqual(expect.arrayContaining(keptIds));
		for (const id of ids.slice(2)) expect(native).not.toContain(id);
		expect(
			wire(relay, sessionId).filter(({ path }) =>
				path.endsWith("/f-last-assistant"),
			),
		).toHaveLength(1);
		expect(
			wire(relay, sessionId).filter(({ method }) => method === "POST"),
		).toHaveLength(1);
		const state = persistedRewinds(relay, sessionId);
		expect(await owedCut(relay, sessionId)).toBeNull();
		expect(
			state.events.filter(({ type }) => type === "session.rewind_committed"),
		).toHaveLength(1);
		const history = await client.loadMoreHistory(sessionId);
		expect(
			history.messages.some(({ id }) => id === "msg_conduit_retry-second"),
		).toBe(true);
		// 82tn.51: the cut landed before the failed send, so its message is an ordinary failed turn
		// on the new Head and stays shown; the provider never received it and resumes before it.
		expect(
			history.messages.some(({ id }) => id === "msg_conduit_retry-first"),
		).toBe(true);
		evidence["retry"] = { state, native, history };
	});

	it("truncates once for two rapid sends and preserves the second native turn", async () => {
		const { relay, client, second, sessionId } = await fixture();
		await rewind(client, sessionId);
		await Promise.all([
			client.sendMessage("First rapid turn", {
				sessionId,
				commandId: "rapid-first",
			}),
			second.sendMessage("Second rapid turn", {
				sessionId,
				commandId: "rapid-second",
			}),
		]);
		// A submit returns once admitted; truncation runs before each prompt.
		for (const id of ["msg_conduit_rapid-first", "msg_conduit_rapid-second"])
			await client.waitForTranscriptMessage(
				(message) => message.id === id,
				sessionId,
			);
		expect(
			wire(relay, sessionId).filter(({ method }) => method === "DELETE"),
		).toHaveLength(2);
		const history = await client.loadMoreHistory(sessionId);
		const native = await nativeIds(relay, sessionId);
		expect(native).toHaveLength(6);
		expect(history.messages.map(({ id }) => id).sort()).toEqual(native.sort());
		expect(
			wire(relay, sessionId)
				.filter(({ method }) => method === "DELETE")
				.map(({ path }) => path.split("/").at(-1)),
		).toEqual([...hiddenIds].reverse());
		expect(
			persistedRewinds(relay, sessionId).events.filter(
				({ type }) => type === "session.rewind_committed",
			),
		).toHaveLength(1);
	});

	it("orders native messages by creation time before id when a kept conduit id sorts last", async () => {
		const ids = ["msg_conduit_z-kept-user", "b-kept-assistant", ...hiddenIds];
		const { relay, client, sessionId } = await fixture(ids, true);
		await rewind(client, sessionId);
		await client.sendMessage("Clock ordered turn", { sessionId });
		await client.waitForTurnEnd(sessionId);
		expect(
			wire(relay, sessionId)
				.filter(({ method }) => method === "DELETE")
				.map(({ path }) => path.split("/").at(-1)),
		).toEqual([...hiddenIds].reverse());
		expect(await nativeIds(relay, sessionId)).toContain(ids[0]);
	});

	it("fails closed when the rewind anchor is absent from native history", async () => {
		const { relay, client, sessionId } = await fixture();
		await rewind(client, sessionId);
		relay.mock.setExactResponse(
			"GET",
			`/session/${sessionId}/message`,
			200,
			[],
		);
		await client.sendMessage("Cross provider cut", { sessionId });
		await client.waitForTurnEnd(sessionId);
		const owed = persistedRewinds(relay, sessionId);
		expect(
			owed.events.some(
				({ type, data }) =>
					type === "turn.error" && data.includes('"code":"SEND_FAILED"'),
			),
		).toBe(true);
		expect(await owedCut(relay, sessionId)).toBe("c-cut-user");
		expect(
			owed.events.filter(({ type }) => type === "session.rewind_committed"),
		).toEqual([]);
		expect(wire(relay, sessionId)).toEqual([]);
	});

	it("commits only on removal of the cut itself, never another tail message", async () => {
		const { relay, client, sessionId } = await fixture();
		await rewind(client, sessionId);
		await relay.run(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* readOwedRealignment(sql, sessionId, "d-hidden-assistant"),
				).toBeUndefined();
				expect(
					(yield* readOwedRealignment(sql, sessionId, "c-cut-user"))?.events[0]
						?.type,
				).toBe("session.rewind_committed");
			}),
		);
		relay.mock.emitTestEvent("message.removed", {
			sessionID: sessionId,
			messageID: "d-hidden-assistant",
		});
		// 82tn.51: the cut left the Head when the rewind landed, so the tail's removal is ignored
		// and only the cut's own removal confirms the provider has it.
		expect(
			persistedRewinds(relay, sessionId).messages.map(({ id }) => id),
		).not.toContain("d-hidden-assistant");
		relay.mock.emitTestEvent("message.removed", {
			sessionID: sessionId,
			messageID: "c-cut-user",
		});
		await vi.waitFor(async () =>
			expect(await owedCut(relay, sessionId)).toBeNull(),
		);
		expect(
			persistedRewinds(relay, sessionId).events.filter(
				({ type }) => type === "session.rewind_committed",
			),
		).toHaveLength(1);
	});
});
