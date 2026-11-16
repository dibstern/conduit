// Failure modes: deleting the cut point exposes its hidden tail; deleting a
// later member commits before the cut itself is gone (OpenCode deletes the tail
// first, one event per message); deleting a kept message commits an unrelated
// rewind; partial projection commits only part of a cut.
// 82tn.51: a rewind is a head move that lands at once, so the cut rows leave the session when it
// lands. OpenCode deleting the cut point then only confirms the move the provider was owed.

import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, it } from "vitest";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/project-services/Services/provider-runtime-ingestion-service.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { readOwedRealignment } from "../../../../src/lib/persistence/effect/head-realignment.js";
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

const seedLandedRewind = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	const sql = yield* SqlClient.SqlClient;
	yield* commit([
		canonicalEvent("session.created", SESSION_ID, {
			sessionId: SESSION_ID,
			title: "Landed rewind",
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
	]);
	// Two ended Runs: the kept one, then the one the rewind cuts.
	for (const [node, parent, rows] of [
		["kept", null, KEPT_IDS],
		["cut", "kept", HIDDEN_IDS],
	] as const) {
		yield* sql`INSERT INTO history_nodes (session_id, id, parent_id, run_id, available, created_at)
			VALUES (${SESSION_ID}, ${node}, ${parent}, ${node}, 1, 0)`;
		yield* sql`UPDATE messages SET history_node_id = ${node} WHERE id IN ${sql.in(rows)}`;
	}
	yield* sql`INSERT INTO history_heads (session_id, node_id) VALUES (${SESSION_ID}, 'cut')`;
	yield* commit([
		canonicalEvent("head.move_started", SESSION_ID, {
			moveId: "rewind",
			kind: "rewind",
			messageId: "cut-user",
			from: "cut",
			to: "kept",
		}),
		canonicalEvent("head.moved", SESSION_ID, { moveId: "rewind", to: "kept" }),
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
		commits: false,
		name: "range member is removed before the target",
	},
	{ messageId: "kept-assistant", commits: false, name: "kept row is removed" },
])("confirms a landed rewind when an upstream $name (82tn.51)", async ({
	messageId,
	commits,
}) => {
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* seedLandedRewind;
			const read = yield* ReadQueryEffectTag;
			const ingestion = yield* ProviderRuntimeIngestionTag;
			const events = yield* EventStoreEffectTag;
			const sql = yield* SqlClient.SqlClient;
			expect(
				(yield* read.getSessionMessagesWithParts(SESSION_ID)).map(
					(row) => row.id,
				),
			).toEqual(KEPT_IDS);
			const before = yield* events.readAllBySession(SESSION_ID);
			yield* ingestion.ingest(upstreamRemoval(messageId));
			const rows = yield* sql<{ id: string }>`SELECT id FROM messages
				WHERE session_id = ${SESSION_ID} ORDER BY created_at, id`;
			const stored = yield* events.readAllBySession(SESSION_ID);
			const expectedKept = KEPT_IDS.filter((id) => id !== messageId);
			// 82tn.51: the cut rows left the session when the move landed; a removal only confirms it.
			expect.soft(rows.map((row) => row.id)).toEqual(expectedKept);
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
			// A removal of a row already off the Head, before the cut point, changes nothing.
			if (messageId === "hidden-assistant")
				expect.soft(stored).toHaveLength(before.length);
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

it("rolls back the entire upstream rewind commit when the range cannot project", async () => {
	const failingProjector: EffectProjector = {
		name: "fail-rewind-commit",
		handles: ["session.rewind_committed"],
		project: (event) =>
			event.type === "session.rewind_committed"
				? Effect.fail(
						new ProjectionError({
							projector: "fail-rewind-commit",
							operation: "project",
							cause: "Test removal projection failure",
						}),
					)
				: Effect.succeed({ stamped: [], removed: [], collections: [] }),
	};
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* seedLandedRewind;
			const ingestion = yield* ProviderRuntimeIngestionTag;
			const sql = yield* SqlClient.SqlClient;
			const events = yield* EventStoreEffectTag;
			const before = yield* events.readAllBySession(SESSION_ID);
			const outcome = yield* Effect.result(
				ingestion.ingest(upstreamRemoval("cut-user")),
			);
			expect.soft(outcome._tag).toBe("Failure");
			expect.soft(yield* events.readAllBySession(SESSION_ID)).toEqual(before);
			// 82tn.51: the move is still owed, so the next send tells the provider again.
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
					(yield* readOwedRealignment(sql, SESSION_ID))?.rewind
						?.targetMessageId,
				)
				.toBe("cut-user");
		}).pipe(
			Effect.provide(
				testLayer([...createAllEffectProjectors(), failingProjector]),
			),
		),
	);
});
