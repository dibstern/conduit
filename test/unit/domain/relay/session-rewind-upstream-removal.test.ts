// Failure modes: deleting the cut point exposes its hidden tail; deleting a
// later member leaves an undoable half-removed range; deleting a kept message
// commits an unrelated rewind; partial projection commits only part of a cut.
import { SqlClient } from "@effect/sql";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import {
	createAllEffectProjectors,
	type EffectProjector,
	ProjectionError,
} from "../../../../src/lib/persistence/effect/projectors-effect.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { providerRuntimeEvent } from "../../../helpers/provider-runtime-event.js";

const SESSION_ID = "upstream-rewind";
const KEPT_IDS = ["kept-user", "kept-assistant"];
const HIDDEN_IDS = ["cut-user", "hidden-assistant", "hidden-user"];

const seedPendingRewind = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	yield* commit([
		canonicalEvent("session.created", SESSION_ID, {
			sessionId: SESSION_ID,
			title: "Pending rewind",
			provider: "opencode",
		}),
		...[...KEPT_IDS, ...HIDDEN_IDS].flatMap((id, index) => [
			canonicalEvent(
				"message.created",
				SESSION_ID,
				{
					sessionId: SESSION_ID,
					messageId: id,
					role: index % 2 === 0 ? "user" : "assistant",
				},
				{ createdAt: 100 + index },
			),
			canonicalEvent("text.delta", SESSION_ID, {
				messageId: id,
				partId: `${id}:text`,
				text: id,
			}),
		]),
		canonicalEvent("session.rewound", SESSION_ID, { messageId: "cut-user" }),
	]);
});

const upstreamRemoval = (messageId: string) =>
	providerRuntimeEvent(
		"message.removed",
		SESSION_ID,
		{ messageId },
		{ providerId: "opencode", eventId: `evt_upstream_remove_${messageId}` },
	);

function testLayer(projectors = createAllEffectProjectors()) {
	const persistence = makePersistenceEffectLayer(
		":memory:",
		"test-project",
		projectors,
	);
	return Layer.mergeAll(
		persistence,
		ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
	);
}

it.each([
	{ messageId: "cut-user", commits: true, name: "target arrives first" },
	{
		messageId: "hidden-assistant",
		commits: true,
		name: "range member arrives before the target",
	},
	{ messageId: "kept-assistant", commits: false, name: "kept row is removed" },
])("reconciles a pending rewind when an upstream $name", async ({
	messageId,
	commits,
}) => {
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* seedPendingRewind;
			const read = yield* ReadQueryEffectTag;
			const ingestion = yield* ProviderRuntimeIngestionTag;
			const events = yield* EventStoreEffectTag;
			const sql = yield* SqlClient.SqlClient;
			expect(
				(yield* read.getSessionMessagesWithParts(SESSION_ID)).map(
					(row) => row.id,
				),
			).toEqual(KEPT_IDS);
			yield* ingestion.ingest(upstreamRemoval(messageId));
			const session = yield* read.getSession(SESSION_ID);
			const rows = yield* sql<{ id: string }>`SELECT id FROM messages
				WHERE session_id = ${SESSION_ID} ORDER BY created_at, id`;
			const tombstones = yield* sql<{ message_id: string }>`SELECT message_id
				FROM message_tombstones WHERE session_id = ${SESSION_ID} ORDER BY message_id`;
			const stored = yield* events.readAllBySession(SESSION_ID);
			const expectedKept = KEPT_IDS.filter((id) => id !== messageId);
			// Clearing this persisted point is what removes Undo from all clients.
			expect
				.soft(session?.pending_rewind_message_id)
				.toBe(commits ? null : "cut-user");
			expect
				.soft(rows.map((row) => row.id))
				.toEqual(commits ? expectedKept : [...expectedKept, ...HIDDEN_IDS]);
			expect
				.soft(tombstones.map((row) => row.message_id))
				.toEqual(commits ? [...HIDDEN_IDS].sort() : [messageId]);
			expect
				.soft(
					(yield* read.getSessionMessagesWithParts(SESSION_ID)).map(
						(row) => row.id,
					),
				)
				.toEqual(expectedKept);
			expect
				.soft(
					stored.filter((event) => event.type === "session.rewind_committed"),
				)
				.toHaveLength(commits ? 1 : 0);
			if (commits) {
				// OpenCode can subsequently report the remaining removals again.
				for (const id of HIDDEN_IDS)
					yield* ingestion.ingest(upstreamRemoval(id));
				expect
					.soft(yield* events.readAllBySession(SESSION_ID))
					.toHaveLength(stored.length);
			}
		}).pipe(Effect.provide(testLayer())),
	);
});

it("rolls back the entire upstream rewind commit when a hidden removal cannot project", async () => {
	const failingProjector: EffectProjector = {
		name: "fail-final-hidden-removal",
		handles: ["message.removed"],
		project: (event) =>
			event.type === "message.removed" && event.data.messageId === "hidden-user"
				? Effect.fail(
						new ProjectionError({
							projector: "fail-final-hidden-removal",
							operation: "project",
							cause: "Test removal projection failure",
						}),
					)
				: Effect.succeed({ stamped: [], removed: [], collections: [] }),
	};
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* seedPendingRewind;
			const ingestion = yield* ProviderRuntimeIngestionTag;
			const read = yield* ReadQueryEffectTag;
			const sql = yield* SqlClient.SqlClient;
			const events = yield* EventStoreEffectTag;
			const before = yield* events.readAllBySession(SESSION_ID);
			const outcome = yield* Effect.either(
				ingestion.ingest(upstreamRemoval("cut-user")),
			);
			expect.soft(outcome._tag).toBe("Left");
			expect
				.soft((yield* read.getSession(SESSION_ID))?.pending_rewind_message_id)
				.toBe("cut-user");
			expect
				.soft(
					(yield* sql<{ id: string }>`SELECT id FROM messages
					WHERE session_id = ${SESSION_ID} ORDER BY created_at, id`).map(
						(row) => row.id,
					),
				)
				.toEqual([...KEPT_IDS, ...HIDDEN_IDS]);
			expect.soft(yield* events.readAllBySession(SESSION_ID)).toEqual(before);
			expect
				.soft(
					yield* sql`SELECT message_id FROM message_tombstones WHERE session_id = ${SESSION_ID}`,
				)
				.toHaveLength(0);
		}).pipe(
			Effect.provide(
				testLayer([...createAllEffectProjectors(), failingProjector]),
			),
		),
	);
});

it("commits same-batch late hidden content and drops echoes after the upstream cut", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* seedPendingRewind;
			const ingestion = yield* ProviderRuntimeIngestionTag;
			const read = yield* ReadQueryEffectTag;
			const events = yield* EventStoreEffectTag;
			const sql = yield* SqlClient.SqlClient;
			const lateId = "late-hidden-assistant";
			const targetRemoval = upstreamRemoval("cut-user");
			const staleEvents = [lateId, "cut-user"].flatMap((messageId, index) => [
				providerRuntimeEvent(
					"message.created",
					SESSION_ID,
					{ sessionId: SESSION_ID, messageId, role: "assistant" },
					{
						providerId: "opencode",
						eventId: `evt_stale_create_${messageId}`,
						createdAt: 160 + index,
					},
				),
				providerRuntimeEvent(
					"text.delta",
					SESSION_ID,
					{ messageId, partId: `${messageId}:text`, text: "Stale echo" },
					{
						providerId: "opencode",
						eventId: `evt_stale_text_${messageId}`,
						createdAt: 170 + index,
					},
				),
			]);
			yield* ingestion.ingestBatch([
				providerRuntimeEvent(
					"message.created",
					SESSION_ID,
					{ sessionId: SESSION_ID, messageId: lateId, role: "assistant" },
					{
						providerId: "opencode",
						eventId: "evt_late_hidden_create",
						createdAt: 150,
					},
				),
				providerRuntimeEvent(
					"text.delta",
					SESSION_ID,
					{ messageId: lateId, partId: `${lateId}:text`, text: "Late hidden" },
					{
						providerId: "opencode",
						eventId: "evt_late_hidden_text",
						createdAt: 151,
					},
				),
				targetRemoval,
				...staleEvents,
			]);
			const stored = yield* events.readAllBySession(SESSION_ID);
			const hidden = [...HIDDEN_IDS, lateId].sort();
			expect
				.soft(
					(yield* sql<{ id: string }>`SELECT id FROM messages
					WHERE session_id = ${SESSION_ID} ORDER BY created_at, id`).map(
						(row) => row.id,
					),
				)
				.toEqual(KEPT_IDS);
			expect
				.soft(
					(yield* sql<{
						message_id: string;
					}>`SELECT message_id FROM message_tombstones
					WHERE session_id = ${SESSION_ID} ORDER BY message_id`).map(
						(row) => row.message_id,
					),
				)
				.toEqual(hidden);
			expect
				.soft((yield* read.getSession(SESSION_ID))?.pending_rewind_message_id)
				.toBeNull();
			expect
				.soft(
					stored
						.flatMap((event) =>
							event.type === "message.removed" ? [event.data.messageId] : [],
						)
						.sort(),
				)
				.toEqual(hidden);
			expect
				.soft(
					stored.filter((event) => event.type === "session.rewind_committed"),
				)
				.toHaveLength(1);
			expect
				.soft(stored.find((event) => event.eventId === targetRemoval.eventId))
				.toMatchObject({
					type: "message.removed",
					provider: "opencode",
					createdAt: targetRemoval.createdAt,
					metadata: {
						providerRuntimeEventId: targetRemoval.eventId,
						rawSource: targetRemoval.rawSource.kind,
					},
				});
			for (const echo of staleEvents)
				expect
					.soft(stored.some((event) => event.eventId === echo.eventId))
					.toBe(false);
		}).pipe(Effect.provide(testLayer())),
	);
});
