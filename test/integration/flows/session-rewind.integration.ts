import { channel } from "node:diagnostics_channel";
import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDetailEnvelopeSchema } from "../../../src/lib/contracts/ws-rpc.js";
import type { ReadModelRead } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import {
	applyTranscriptEnvelope,
	type TranscriptEntry,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { readPendingRewindCommit } from "../../../src/lib/persistence/effect/pending-rewind.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { StoredEventRow } from "../../../src/lib/persistence/effect/stored-event-row.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";
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
		pending: entry.pendingRewindMessageId ?? null,
	};
}

function persistedRewinds(harness: RelayHarness, sessionId: string) {
	const db = new Database(harness.eventsDbPath, { readonly: true });
	try {
		return {
			session: db
				.prepare("SELECT pending_rewind_message_id FROM sessions WHERE id = ?")
				.get(sessionId) as { pending_rewind_message_id: string | null },
			events: db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND type IN ('session.rewound', 'session.rewind_undone', 'session.rewind_committed', 'message.removed', 'turn.error') ORDER BY sequence",
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
	harness: RelayHarness,
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
	return sessionId;
}

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
				yield* sql`SELECT pending_rewind_message_id, fork_point_timestamp, last_user_message_at FROM sessions WHERE id = ${sessionId}`,
		};
	});

async function replayRewind(
	sessionId: string,
	rows: readonly StoredEventRow[],
) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const runner = yield* ProjectionRunnerEffectTag;
			yield* sql`INSERT INTO events ${sql.insert(rows.map((row) => ({ ...row })))}`;
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

function legacyRewindRows(
	rows: readonly StoredEventRow[],
	removedIds: readonly string[],
) {
	let offset = 0;
	return rows.flatMap((row) => {
		const shifted = {
			...row,
			sequence: row.sequence + offset,
			stream_version: row.stream_version + offset,
		};
		if (row.type !== "session.rewind_committed") return [shifted];
		offset += removedIds.length;
		return [
			...removedIds.map((messageId, index) => ({
				...shifted,
				sequence: shifted.sequence + index,
				stream_version: shifted.stream_version + index,
				event_id: `legacy-removal-${messageId}`,
				type: "message.removed",
				data: JSON.stringify({ messageId }),
			})),
			{
				...shifted,
				sequence: shifted.sequence + removedIds.length,
				stream_version: shifted.stream_version + removedIds.length,
			},
		];
	});
}

describe("OpenCode pending rewind through the relay", () => {
	let harness: RelayHarness | undefined;
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
		harness = await createRelayHarness();
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
			pending: null,
		});
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			const writes = () => {
				const { version } = db
					.prepare(
						"SELECT MAX(p.version) AS version FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE m.session_id = ?",
					)
					.get(sessionId) as { version: number };
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
			let previousVersion = writes().version;
			for (const cut of [190, 196, 180]) {
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
				expect.soft(projected.parts).toBe(50);
				await vi.waitFor(() => {
					const state = detailState(viewer, sessionId, messageIds);
					expect(state.pending).toBe(messageId);
					// The browser preserves the cold page's floor while hiding rows.
					expect(state.ids).toEqual(messageIds.slice(150, cut));
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
			expect.soft(undone.parts).toBe(50);
			await vi.waitFor(() => {
				const state = detailState(viewer, sessionId, messageIds);
				expect(state.pending).toBeNull();
				expect(state.ids).toEqual(messageIds.slice(150));
			});
			const restored = await viewer.loadMoreHistory(sessionId);
			expect(restored.messages.map(({ id }) => id)).toEqual(
				messageIds.slice(-restored.messages.length),
			);
			expect(persistedRewinds(harness, sessionId).messages).toHaveLength(200);
		} finally {
			db.close();
		}
	}, 60_000);

	it("bounds cut timestamp reconciliation and retains legacy event replay", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const reads = yield* ReadQueryEffectTag;
				const sql = yield* SqlClient.SqlClient;
				const sessionId = "rewind-reconciliation";
				const messageIds = Array.from(
					{ length: 200 },
					(_, index) => `m${String(index).padStart(4, "0")}`,
				);
				yield* commit([
					canonicalEvent("session.created", sessionId, {
						sessionId,
						title: "Cut timestamp reconciliation",
						provider: "opencode",
					}),
					...messageIds.flatMap((messageId, createdAt) => [
						canonicalEvent(
							"message.created",
							sessionId,
							{ sessionId, messageId, role: "assistant" },
							{ createdAt },
						),
						canonicalEvent("text.delta", sessionId, {
							messageId,
							partId: `${messageId}-text`,
							text: messageId,
						}),
					]),
				]);
				const cutId = "m0190";
				// Persisted pre-change events have no previousMessageId.
				yield* commit([
					canonicalEvent("session.rewound", sessionId, { messageId: cutId }),
				]);
				const writes = () =>
					sql<{ messages: number; parts: number }>`SELECT
						(SELECT count(*) FROM messages WHERE session_id = ${sessionId}
							AND version = (SELECT value FROM read_model_counter WHERE id = 1)) AS messages,
						(SELECT count(*) FROM message_parts p JOIN messages m ON m.id = p.message_id
							WHERE m.session_id = ${sessionId}
							AND p.version = (SELECT value FROM read_model_counter WHERE id = 1)) AS parts`;
				expect((yield* writes())[0]).toEqual({ messages: 200, parts: 200 });
				// Writing a hidden cut's text does not move the transcript ordering.
				yield* commit([
					canonicalEvent("text.delta", sessionId, {
						messageId: cutId,
						partId: `${cutId}-text`,
						text: "continued",
					}),
				]);
				expect.soft((yield* writes())[0]).toEqual({ messages: 1, parts: 1 });
				let floor = (yield* reads.readSessionTranscript(sessionId)).version;
				for (const [createdAt, visibleIds, maxMessages] of [
					[196, messageIds.filter((id) => id < "m0196" && id !== cutId), 60],
					[185, messageIds.slice(0, 186), 70],
				] as const) {
					yield* commit([
						canonicalEvent(
							"message.snapshot",
							sessionId,
							{
								messageId: cutId,
								digest: `cut-${createdAt}`,
								message: {
									id: cutId,
									sessionID: sessionId,
									role: "assistant",
									time: { created: createdAt },
									parts: [{ id: `${cutId}-text`, type: "text", text: cutId }],
								},
							},
							{ metadata: { rawSource: "opencode.rest" } },
						),
					]);
					const [projected] = yield* writes();
					expect.soft(projected?.messages).toBeLessThanOrEqual(maxMessages);
					// The cut's snapshot writes one part of its own.
					expect.soft(projected?.parts).toBeLessThanOrEqual(51);
					const transcript =
						yield* reads.getSessionMessagesWithParts(sessionId);
					expect(transcript.map(({ id }) => id)).toEqual(visibleIds);
					const delta = yield* reads.readSessionTranscript(sessionId, {
						after: floor,
						through: (yield* reads.readSessionTranscript(sessionId)).version,
					});
					expect(delta.messages.slice(-50).map(({ id }) => id)).toEqual(
						visibleIds.slice(-50),
					);
					expect(delta.messages.every(({ parts }) => parts.length === 1)).toBe(
						true,
					);
					floor = delta.version;
				}
				yield* commit([canonicalEvent("session.rewind_undone", sessionId, {})]);
				expect((yield* writes())[0]).toEqual({ messages: 200, parts: 200 });
				expect(
					yield* reads.getSessionMessagesWithParts(sessionId),
				).toHaveLength(200);
			}).pipe(
				Effect.provide(
					makePersistenceEffectLayer(":memory:", "rewind-regression"),
				),
			),
		);
	});

	it("replays a range commit and preserves a deferred fork clock before deleting its message", async () => {
		const sessionId = "rewind-range-replay";
		const messageIds = Array.from(
			{ length: 12 },
			(_, index) => `replay-${String(index).padStart(2, "0")}`,
		);
		const removedIds = messageIds.slice(2);
		const target = removedIds[0] as string;
		const forkPoint = messageIds.at(-1) as string;
		const { live, rows } = await Effect.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const sql = yield* SqlClient.SqlClient;
				const snapshot = (messageId: string, createdAt = 100) => {
					const index = messageIds.indexOf(messageId);
					return canonicalEvent(
						"message.snapshot",
						sessionId,
						{
							messageId,
							digest: `${messageId}-${createdAt}`,
							message: {
								id: messageId,
								sessionID: sessionId,
								role: index % 2 === 0 ? "user" : "assistant",
								...(index % 2 === 1 ? { parentID: messageIds[index - 1] } : {}),
								time: { created: createdAt, completed: createdAt },
								parts: [
									{ id: `${messageId}-text`, type: "text", text: messageId },
									...(index % 2 === 1
										? [
												{
													id: `${messageId}-tool`,
													type: "tool",
													tool: "bash",
													callID: `${messageId}-call`,
													state: {
														status: "completed",
														input: { command: "pwd" },
														output: messageId,
													},
												},
											]
										: []),
								],
							},
						},
						{ metadata: { rawSource: "opencode.rest", inherited: true } },
					);
				};
				yield* commit([
					canonicalEvent("session.created", sessionId, {
						sessionId,
						title: "Range replay",
						provider: "opencode",
						forkPointEvent: forkPoint,
						forkPointTimestamp: 0,
					}),
					// Provider clocks and ids determine the range even when receipt
					// order runs backwards.
					...[...messageIds].reverse().map((id) => snapshot(id)),
				]);
				yield* commit([
					canonicalEvent("session.rewound", sessionId, { messageId: target }),
				]);
				const rewind = yield* readPendingRewindCommit(sql, sessionId);
				expect(rewind?.removedMessageIds).toEqual(removedIds);
				expect(rewind?.rewind).toEqual({
					resumeSessionAt: messageIds[1],
					targetMessageId: target,
				});
				if (!rewind) throw new Error("Missing pending rewind");
				expect(rewind.events.map(({ type }) => type)).toEqual([
					"session.rewind_committed",
				]);
				// This snapshot's pending stamp must preserve the fork clock while
				// the same batch's commit removes the message carrying it.
				yield* commit([snapshot(forkPoint, 200), ...rewind.events]);
				return {
					live: yield* rewindProjection(sessionId),
					rows: yield* sql<StoredEventRow>`SELECT project_id, sequence, event_id, session_id, stream_version, type, data, metadata, provider, created_at FROM events WHERE session_id = ${sessionId} ORDER BY sequence`,
				};
			}).pipe(
				Effect.provide(
					makePersistenceEffectLayer(":memory:", "integration-test"),
				),
			),
		);
		expect(live.messages.map((row) => row["id"])).toEqual(
			messageIds.slice(0, 2),
		);
		expect(live.tombstones.map((row) => row["message_id"])).toEqual(removedIds);
		expect(live.parts.filter((row) => row["type"] === "tool")).toHaveLength(1);
		expect(live.session[0]).toEqual(
			expect.objectContaining({
				pending_rewind_message_id: null,
				fork_point_timestamp: 200,
			}),
		);
		const replayed = await replayRewind(sessionId, rows);
		const legacy = await replayRewind(
			sessionId,
			legacyRewindRows(rows, removedIds),
		);
		expect(replayed).toEqual(live);
		expect(legacy).toEqual(live);
		mkdirSync("test-results/rewind", { recursive: true });
		writeFileSync(
			"test-results/rewind/opencode-persistence-range.json",
			JSON.stringify({ live, replayed, legacy }, null, 2),
		);
	});

	// Failure cases: equal timestamps change the cut, another tab misses the
	// pending point, paging leaks hidden messages, undo loses turns, or duplicate
	// provider removals fail after the committed transcript has removed them.
	it("commits a long transcript when the cut is removed first, coalesces duplicate removals, then replays it", async () => {
		harness = await createRelayHarness();
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
		const project = () =>
			fixture.stack.effectRuntime.runtime.runPromise(
				rewindProjection(sessionId),
			);
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
		await client.rpcCall((rpc) =>
			rpc.RewindSession({ sessionId, messageId: target }),
		);
		await vi.waitFor(() =>
			expect(detailState(client, sessionId, messageIds)).toEqual({
				ids: messageIds.slice(0, 2),
				pending: target,
			}),
		);
		const db = new Database(fixture.eventsDbPath, { readonly: true });
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
			await vi.waitFor(() =>
				expect(detailState(client, sessionId, messageIds)).toEqual({
					ids: messageIds.slice(0, 2),
					pending: null,
				}),
			);
			const appended = db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence",
				)
				.all(sessionId, before) as Array<{ type: string; data: string }>;
			expect(appended).toEqual([
				{
					type: "session.rewind_committed",
					data: JSON.stringify({ messageId: target }),
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
			const replayed = await replayRewind(sessionId, rows);
			expect(replayed).toEqual(live);
			// Old logs removed every message before the commit. Its missing cut
			// must leave the kept prefix untouched when those logs replay today.
			const legacy = await replayRewind(
				sessionId,
				legacyRewindRows(rows, removedIds),
			);
			expect(legacy).toEqual(live);
			const parity = await fixture.checkReplayParity();
			expect(parity.diffs).toEqual([]);
			expect(parity.danglingPartPointers).toEqual([]);
			evidence["rangeCommit"] = {
				appended,
				reads,
				live,
				replayed,
				legacy,
				parity,
			};
		} finally {
			readChannel.unsubscribe(observeRead);
			db.close();
		}
	}, 60_000);

	async function fixture(ids = seededIds, orderedClocks = false) {
		harness = await createRelayHarness();
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

	function wire(relay: RelayHarness, sessionId: string) {
		return relay.mock.requestBodies.filter(
			(request) =>
				request.path.startsWith(`/session/${sessionId}/`) &&
				(request.method === "DELETE" ||
					/\/(prompt_async|prompt|revert|unrevert|fork)$/.test(request.path)),
		);
	}

	async function nativeIds(relay: RelayHarness, sessionId: string) {
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
				expect(detailState(tab, sessionId)).toEqual({
					ids: keptIds,
					pending: hiddenIds[0],
				});
		});
		await second.rpcCall((rpc) => rpc.UndoRewind({ sessionId }));
		await vi.waitFor(() => {
			for (const tab of [client, second])
				expect(detailState(tab, sessionId)).toEqual({
					ids: seededIds,
					pending: null,
				});
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
		expect(commitsBeforeDeletion).toEqual([0, 0]);
		const native = await nativeIds(relay, sessionId);
		expect(native).toEqual(expect.arrayContaining(keptIds));
		for (const id of hiddenIds) expect(native).not.toContain(id);
		const committed = persistedRewinds(relay, sessionId);
		expect(committed.session.pending_rewind_message_id).toBeNull();
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
			expect(detailState(tab, sessionId)).toEqual({
				ids: keptIds,
				pending: null,
			});
			expect(
				(await tab.loadMoreHistory(sessionId)).messages.map(({ id }) => id),
			).toEqual(history.messages.map(({ id }) => id));
		}
		evidence["committed"] = committed;
		evidence["native"] = native;
		evidence["commitsBeforeDeletion"] = commitsBeforeDeletion;
	});

	it("keeps the cut pending and fails the send when deleting the cut fails", async () => {
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
		const pending = persistedRewinds(relay, sessionId);
		expect(
			pending.events.some(
				({ type, data }) =>
					type === "turn.error" && data.includes('"code":"SEND_FAILED"'),
			),
		).toBe(true);
		expect(pending.session.pending_rewind_message_id).toBe("c-cut-user");
		expect(
			pending.events.filter(({ type }) => type === "session.rewind_committed"),
		).toEqual([]);
		expect(wire(relay, sessionId).some(({ method }) => method === "POST")).toBe(
			false,
		);
		evidence["pending"] = pending;
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
		expect(
			persistedRewinds(relay, sessionId).session.pending_rewind_message_id,
		).toBe("c-cut-user");
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
		expect(state.session.pending_rewind_message_id).toBeNull();
		expect(
			state.events.filter(({ type }) => type === "session.rewind_committed"),
		).toHaveLength(1);
		const history = await client.loadMoreHistory(sessionId);
		expect(
			history.messages.some(({ id }) => id === "msg_conduit_retry-second"),
		).toBe(true);
		expect(
			history.messages.some(({ id }) => id === "msg_conduit_retry-first"),
		).toBe(false);
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
		expect(
			wire(relay, sessionId).filter(({ method }) => method === "DELETE"),
		).toHaveLength(2);
		for (const id of ["msg_conduit_rapid-first", "msg_conduit_rapid-second"])
			await client.waitForTranscriptMessage(
				(message) => message.id === id,
				sessionId,
			);
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
		const pending = persistedRewinds(relay, sessionId);
		expect(
			pending.events.some(
				({ type, data }) =>
					type === "turn.error" && data.includes('"code":"SEND_FAILED"'),
			),
		).toBe(true);
		expect(pending.session.pending_rewind_message_id).toBe("c-cut-user");
		expect(
			pending.events.filter(({ type }) => type === "session.rewind_committed"),
		).toEqual([]);
		expect(wire(relay, sessionId)).toEqual([]);
	});

	it("commits only on removal of the cut itself, never another tail message", async () => {
		const { relay, client, sessionId } = await fixture();
		await rewind(client, sessionId);
		await relay.stack.effectRuntime.runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				expect(
					yield* readPendingRewindCommit(sql, sessionId, "d-hidden-assistant"),
				).toBeUndefined();
				expect(
					(yield* readPendingRewindCommit(sql, sessionId, "c-cut-user"))
						?.events[0]?.type,
				).toBe("session.rewind_committed");
			}),
		);
		relay.mock.emitTestEvent("message.removed", {
			sessionID: sessionId,
			messageID: "d-hidden-assistant",
		});
		await vi.waitFor(() =>
			expect(
				persistedRewinds(relay, sessionId).messages.map(({ id }) => id),
			).not.toContain("d-hidden-assistant"),
		);
		expect(
			persistedRewinds(relay, sessionId).session.pending_rewind_message_id,
		).toBe("c-cut-user");
		relay.mock.emitTestEvent("message.removed", {
			sessionID: sessionId,
			messageID: "c-cut-user",
		});
		await vi.waitFor(() =>
			expect(
				persistedRewinds(relay, sessionId).session.pending_rewind_message_id,
			).toBeNull(),
		);
		expect(
			persistedRewinds(relay, sessionId).events.filter(
				({ type }) => type === "session.rewind_committed",
			),
		).toHaveLength(1);
	});
});
