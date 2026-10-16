import { mkdirSync, writeFileSync } from "node:fs";
import { SqlClient } from "@effect/sql";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDetailEnvelopeSchema } from "../../../src/lib/contracts/ws-rpc.js";
import {
	applyTranscriptEnvelope,
	type TranscriptEntry,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
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
					"SELECT type, data FROM events WHERE session_id = ? AND type IN ('session.rewound', 'session.rewind_undone', 'session.rewind_committed', 'message.removed') ORDER BY sequence",
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
) {
	const created = await client.createSession("Pending rewind", {
		providerId: "opencode",
	});
	const sessionId = String(created["id"]);
	const createdAt = Date.now();
	harness.mock.injectSSEEvents(
		messageIds.flatMap((id, index) => [
			{
				type: "message.updated",
				properties: {
					info: {
						id,
						sessionID: sessionId,
						role: index % 2 === 0 ? "user" : "assistant",
						time: { created: createdAt, completed: createdAt },
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

describe("OpenCode pending rewind through the relay", () => {
	let harness: RelayHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async (context) => {
		if (!harness) return;
		const fixture = harness;
		harness = undefined;
		try {
			evidence["requests"] = fixture.mock.diagnostics.filter(
				(entry) =>
					entry.event === "request" &&
					/\/(revert|unrevert|prompt_async)(?:\?|$)/.test(entry.detail ?? ""),
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
					.prepare("SELECT version FROM sessions WHERE id = ?")
					.get(sessionId) as { version: number };
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

	// Failure cases: equal timestamps change the cut, another tab misses the
	// pending point, paging leaks hidden messages, undo loses turns, or duplicate
	// provider removals fail after the committed transcript has removed them.
	it("hides and restores turns across tabs, then commits once on the next prompt", async () => {
		harness = await createRelayHarness();
		evidence = { tickets: ["conduit-test-qqqm", "conduit-test-bu61"] };
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const sessionId = await seedTurns(harness, client);
		const second = await harness.connectWsClient();
		await second.switchSession(sessionId);
		const target = hiddenIds[0] as string;
		const rewind = () =>
			client.rpcCall((rpc) =>
				rpc.RewindSession({
					sessionId,
					messageId: target,
				}),
			);

		await rewind();
		expect(harness.mock.requestBodies).toContainEqual({
			method: "POST",
			path: `/session/${sessionId}/revert`,
			body: JSON.stringify({ messageID: target }),
		});
		await vi.waitFor(() => {
			for (const tab of [client, second])
				expect(detailState(tab, sessionId)).toEqual({
					ids: [...keptIds].sort(),
					pending: target,
				});
		});
		const pendingPage = await second.loadMoreHistory(sessionId);
		for (const id of hiddenIds)
			expect(pendingPage.messages.map((message) => message.id)).not.toContain(
				id,
			);
		expect(pendingPage.messages.map((message) => message.id)).toEqual(
			expect.arrayContaining(keptIds),
		);
		await expect(
			second.loadMoreHistory(sessionId, hiddenIds[1]),
		).rejects.toThrow();
		const earlier = await second.loadMoreHistory(sessionId, keptIds[1]);
		expect(earlier.messages.map((message) => message.id)).toContain(keptIds[0]);
		for (const id of hiddenIds)
			expect(earlier.messages.map((message) => message.id)).not.toContain(id);
		evidence["pending"] = persistedRewinds(harness, sessionId);
		expect(
			persistedRewinds(harness, sessionId).events.map(({ type }) => type),
		).toEqual(["session.rewound"]);
		expect(
			persistedRewinds(harness, sessionId).messages.map(({ id }) => id),
		).toEqual(expect.arrayContaining(seededIds));
		const reloaded = await harness.connectWsClient();
		await reloaded.switchSession(sessionId);
		expect(detailState(reloaded, sessionId)).toEqual({
			ids: [...keptIds].sort(),
			pending: target,
		});

		await second.rpcCall((rpc) => rpc.UndoRewind({ sessionId }));
		expect(
			harness.mock.diagnostics.filter((entry) =>
				entry.detail?.startsWith(`POST /session/${sessionId}/unrevert`),
			),
		).toHaveLength(1);
		await vi.waitFor(() => {
			for (const tab of [client, second, reloaded])
				expect(detailState(tab, sessionId)).toEqual({
					ids: [...seededIds].sort(),
					pending: null,
				});
		});
		expect(
			(await second.loadMoreHistory(sessionId)).messages.map(({ id }) => id),
		).toEqual(expect.arrayContaining(seededIds));

		await rewind();
		await client.sendMessage("Commit the rewind", { sessionId });
		await client.waitForTurnEnd(sessionId);
		await vi.waitFor(() => {
			const state = persistedRewinds(harness as RelayHarness, sessionId);
			expect(state.session.pending_rewind_message_id).toBeNull();
			for (const id of hiddenIds)
				expect(state.messages.map((message) => message.id)).not.toContain(id);
			expect(state.tombstones.map((tombstone) => tombstone.message_id)).toEqual(
				expect.arrayContaining(hiddenIds),
			);
		});
		const beforeDuplicate = persistedRewinds(harness, sessionId);
		for (const id of hiddenIds)
			harness.mock.emitTestEvent("message.removed", {
				sessionID: sessionId,
				messageID: id,
			});
		// A provider event after both repeated removals fences their ingestion.
		harness.mock.injectSSEEvents([
			{
				type: "message.updated",
				properties: {
					info: {
						id: "rewind-removal-fence",
						sessionID: sessionId,
						role: "assistant",
						time: { created: Date.now() },
					},
				},
			},
		]);
		await vi.waitFor(() =>
			expect(
				persistedRewinds(harness as RelayHarness, sessionId).messages,
			).toContainEqual({
				id: "rewind-removal-fence",
			}),
		);
		const committed = persistedRewinds(harness, sessionId);
		expect(committed.tombstones).toEqual(beforeDuplicate.tombstones);
		expect(committed.events).toEqual(beforeDuplicate.events);
		const removals = committed.events
			.filter((event) => event.type === "message.removed")
			.map(
				(event) => (JSON.parse(event.data) as { messageId: string }).messageId,
			);
		expect(removals.sort()).toEqual([...hiddenIds].sort());
		const reopened = await harness.connectWsClient();
		await reopened.switchSession(sessionId);
		expect(detailState(reopened, sessionId)).toEqual({
			ids: [...keptIds].sort(),
			pending: null,
		});
		const history = await reopened.loadMoreHistory(sessionId);
		for (const id of hiddenIds)
			expect(history.messages.map((message) => message.id)).not.toContain(id);
		await expect(
			reopened.rpcCall((rpc) => rpc.UndoRewind({ sessionId })),
		).rejects.toThrow();
		evidence["committed"] = committed;
		evidence["reload"] = history;
	}, 60_000);

	it("keeps the canonical transcript unchanged when revert or unrevert fails", async () => {
		harness = await createRelayHarness();
		evidence = { ticket: "conduit-test-bu61" };
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const sessionId = await seedTurns(harness, client);
		const target = hiddenIds[0] as string;
		const rewind = () =>
			client.rpcCall((rpc) =>
				rpc.RewindSession({
					sessionId,
					messageId: target,
				}),
			);
		harness.mock.setExactResponse("POST", `/session/${sessionId}/revert`, 500, {
			error: "revert failed",
		});
		await expect(rewind()).rejects.toThrow();
		expect(persistedRewinds(harness, sessionId).events).toEqual([]);
		expect(detailState(client, sessionId)).toEqual({
			ids: [...seededIds].sort(),
			pending: null,
		});
		harness.mock.setExactResponse("POST", `/session/${sessionId}/revert`, 200, {
			id: sessionId,
		});
		await rewind();
		const pending = persistedRewinds(harness, sessionId);
		harness.mock.setExactResponse(
			"POST",
			`/session/${sessionId}/unrevert`,
			500,
			{
				error: "unrevert failed",
			},
		);
		await expect(
			client.rpcCall((rpc) => rpc.UndoRewind({ sessionId })),
		).rejects.toThrow();
		expect(persistedRewinds(harness, sessionId)).toEqual(pending);
		const reloaded = await harness.connectWsClient();
		await reloaded.switchSession(sessionId);
		expect(detailState(reloaded, sessionId)).toEqual({
			ids: [...keptIds].sort(),
			pending: target,
		});
		evidence["pendingAfterFailure"] = pending;
	}, 45_000);
});
