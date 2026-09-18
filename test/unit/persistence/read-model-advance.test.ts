// The projection path is the only thing that announces a read-model change.
// Each test drives a real producer against a real SQLite file with the real
// projectors, and observes what reached the bus — never a projector directly.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Exit, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import type { ReadModelAdvance } from "../../../src/lib/contracts/read-model-advance.js";
import { applySessionCommand } from "../../../src/lib/domain/relay/Services/session-command.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const recordingBus = (advances: ReadModelAdvance[]) =>
	Layer.succeed(SessionEventBusTag, {
		publish: () => Effect.void,
		publishAdvance: (advance) => Effect.sync(() => void advances.push(advance)),
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	} satisfies SessionEventBus);

const withPersistence = async <A>(
	body: (
		advances: ReadModelAdvance[],
	) => Effect.Effect<A, unknown, PersistenceEffectContext>,
): Promise<A> => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-read-model-advance-"));
	const advances: ReadModelAdvance[] = [];
	const bus = recordingBus(advances);
	const persistence = makePersistenceEffectLayer(
		join(dir, "events.db"),
		createAllEffectProjectors(),
		bus,
	);
	try {
		return await Effect.runPromise(
			body(advances).pipe(
				Effect.provide(Layer.merge(persistence, bus)),
				Effect.orDie,
			),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

it("a committed session write announces the session and stamps its row", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;

			yield* commit([
				canonicalEvent(
					"session.created",
					"s1",
					{ sessionId: "s1", title: "First", provider: "claude" },
					{ provider: "claude" },
				),
			]);

			const rows = yield* sql<{
				version: number;
			}>`SELECT version FROM sessions WHERE id = 's1'`;

			expect(advances).toEqual([
				{ version: 1, sessionIds: ["s1"], removedSessionIds: [] },
			]);
			expect(rows).toEqual([{ version: 1 }]);
		}),
	);
});

it("applySessionCommand announces through the projection path, not its own", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;

			yield* commit([
				canonicalEvent(
					"session.created",
					"s1",
					{ sessionId: "s1", title: "First", provider: "claude" },
					{ provider: "claude" },
				),
			]);
			advances.length = 0;

			yield* applySessionCommand({
				type: "session.renamed",
				data: { sessionId: "s1", title: "Renamed" },
			});

			const rows = yield* sql<{
				version: number;
			}>`SELECT version FROM sessions WHERE id = 's1'`;

			expect(advances).toEqual([
				{ version: 2, sessionIds: ["s1"], removedSessionIds: [] },
			]);
			expect(rows).toEqual([{ version: 2 }]);
		}),
	);
});

it("a subagent message announces the session that owns the row, not the event's", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;

			// The parent drives the turn, so the event is filed under it; the
			// message row belongs to the subagent session the user is watching.
			for (const id of ["parent", "sub"]) {
				yield* commit([
					canonicalEvent(
						"session.created",
						id,
						{ sessionId: id, title: id, provider: "claude" },
						{ provider: "claude" },
					),
				]);
			}
			advances.length = 0;

			yield* commit([
				canonicalEvent(
					"message.created",
					"parent",
					{ sessionId: "sub", messageId: "m1", role: "assistant" },
					{ provider: "claude" },
				),
			]);

			const rows = yield* sql<{
				session_id: string;
				version: number;
			}>`SELECT session_id, version FROM messages WHERE id = 'm1'`;

			expect(rows).toEqual([{ session_id: "sub", version: 3 }]);
			// "sub" can only have come from the message row's own session_id — no
			// event in this batch carries it as its sessionId. "parent" is absent
			// because nothing wrote a parent row: the event header named it, but the
			// advance reports the rows the handlers actually touched.
			expect(
				advances.map((advance) => ({
					version: advance.version,
					sessionIds: [...advance.sessionIds].sort(),
					removedSessionIds: [...advance.removedSessionIds],
				})),
			).toEqual([{ version: 3, sessionIds: ["sub"], removedSessionIds: [] }]);
		}),
	);
});

it("a replayed write advances the version of the row it changed", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			const runner = yield* ProjectionRunnerEffectTag;

			yield* commit([
				canonicalEvent(
					"session.created",
					"s1",
					{ sessionId: "s1", title: "Old", provider: "claude" },
					{ provider: "claude" },
				),
			]);
			yield* commit([
				canonicalEvent(
					"session.renamed",
					"s1",
					{ sessionId: "s1", title: "Latest" },
					{ provider: "claude" },
				),
			]);
			const [before] = yield* sql<{ version: number }>`
				SELECT version FROM sessions WHERE id = 's1'`;

			// Recovery re-applies events the read model has already seen. This one
			// carries an older sequence than the row's current version, and it
			// really does change the row — so the row has to move forward, or a
			// subscriber holding the pre-replay version never learns of the change.
			yield* runner.projectEvent({
				...canonicalEvent(
					"session.renamed",
					"s1",
					{ sessionId: "s1", title: "Replayed" },
					{ provider: "claude" },
				),
				sequence: 1,
				streamVersion: 0,
			});

			const [after] = yield* sql<{ title: string; version: number }>`
				SELECT title, version FROM sessions WHERE id = 's1'`;
			expect(after?.title).toBe("Replayed");
			expect(after?.version).toBeGreaterThan(before?.version ?? 0);
		}),
	);
});

it("a subagent message advances the session row the handler actually wrote", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;

			for (const id of ["parent", "sub"]) {
				yield* commit([
					canonicalEvent(
						"session.created",
						id,
						{ sessionId: id, title: id, provider: "claude" },
						{ provider: "claude" },
					),
				]);
			}
			const [baseline] = yield* sql<{ version: number }>`
				SELECT version FROM sessions WHERE id = 'sub'`;

			// Filed under the parent, but the session handler denormalizes
			// last_message_at onto `sub`. That row changed, so that row must move.
			yield* commit([
				canonicalEvent(
					"message.created",
					"parent",
					{ sessionId: "sub", messageId: "m1", role: "assistant" },
					{ provider: "claude" },
				),
			]);

			const [sub] = yield* sql<{ version: number }>`
				SELECT version FROM sessions WHERE id = 'sub'`;
			expect(sub?.version).toBeGreaterThan(baseline?.version ?? 0);
		}),
	);
});

it("a replay the message guard declines leaves the message row alone", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			const runner = yield* ProjectionRunnerEffectTag;

			yield* commit([
				canonicalEvent(
					"session.created",
					"s1",
					{ sessionId: "s1", title: "First", provider: "claude" },
					{ provider: "claude" },
				),
			]);
			yield* commit([
				canonicalEvent(
					"message.created",
					"s1",
					{ sessionId: "s1", messageId: "m1", role: "assistant" },
					{ provider: "claude" },
				),
			]);
			yield* commit([
				canonicalEvent(
					"text.delta",
					"s1",
					{ messageId: "m1", partId: "p1", text: "hello" },
					{ provider: "claude" },
				),
			]);

			const [before] = yield* sql<{ text: string; version: number }>`
				SELECT text, version FROM messages WHERE id = 'm1'`;

			// Rewind only the message projector, so recovery re-delivers a delta the
			// row has already absorbed. `last_applied_seq` is what stops the text
			// doubling, and that guard returns before any payload statement runs.
			yield* sql`UPDATE projector_cursors SET last_applied_seq = 0 WHERE projector_name = 'message'`;
			yield* runner.recover();

			const [after] = yield* sql<{ text: string; version: number }>`
				SELECT text, version FROM messages WHERE id = 'm1'`;

			expect(after?.text).toBe(before?.text);
			// Nothing wrote this row, so nothing may claim it moved: a bumped version
			// here sends every subscriber back to re-read an unchanged message.
			expect(after?.version).toBe(before?.version);
		}),
	);
});

it("a redelivered message.created does not move the row it did not write", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;

			// Two distinct events announcing the same message: a provider that
			// re-emits, which the store accepts and the projector must absorb.
			const created = () =>
				canonicalEvent(
					"message.created",
					"s1",
					{ sessionId: "s1", messageId: "m1", role: "assistant" },
					{ provider: "claude" },
				);

			yield* commit([
				canonicalEvent(
					"session.created",
					"s1",
					{ sessionId: "s1", title: "First", provider: "claude" },
					{ provider: "claude" },
				),
			]);
			yield* commit([created()]);

			const [before] = yield* sql<{ version: number }>`
				SELECT version FROM messages WHERE id = 'm1'`;

			// The insert conflicts and is ignored. The session row does move — its
			// last_message_at is rewritten — but the message row is untouched.
			yield* commit([created()]);

			const [after] = yield* sql<{ version: number }>`
				SELECT version FROM messages WHERE id = 'm1'`;
			expect(after?.version).toBe(before?.version);
		}),
	);
});

it("the seam refuses to run inside a transaction it does not own", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;

			yield* commit([
				canonicalEvent(
					"session.created",
					"s1",
					{ sessionId: "s1", title: "First", provider: "claude" },
					{ provider: "claude" },
				),
			]);
			advances.length = 0;

			// Inside an enclosing transaction the seam's own `withTransaction` is a
			// savepoint, so returning from it is not a COMMIT. Publishing there would
			// announce a version the outer rollback takes back — and hand the same
			// number out again later, to a subscriber that has already passed it.
			const exit = yield* Effect.exit(
				sql.withTransaction(
					commit([
						canonicalEvent(
							"session.renamed",
							"s1",
							{ sessionId: "s1", title: "Renamed" },
							{ provider: "claude" },
						),
					]),
				),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			expect(advances).toEqual([]);
			// Refused before any write, not after one.
			const rows = yield* sql<{ title: string }>`
				SELECT title FROM sessions WHERE id = 's1'`;
			expect(rows).toEqual([{ title: "First" }]);
		}),
	);
});

it("a write body cannot announce rows its own rollback took back", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			const eventStore = yield* EventStoreEffectTag;

			yield* commit([
				canonicalEvent(
					"session.created",
					"s1",
					{ sessionId: "s1", title: "First", provider: "claude" },
					{ provider: "claude" },
				),
			]);
			advances.length = 0;
			const [before] = yield* sql<{ value: number }>`
				SELECT value FROM read_model_counter WHERE id = 1`;

			// The body opens a transaction of its own — a savepoint inside the
			// seam's — projects into it, fails, and swallows the failure. The
			// savepoint rolls back; the seam's accumulators do not, so it would
			// otherwise commit nothing and announce a version that was never
			// persisted, then hand that same number to the next batch.
			const exit = yield* Effect.exit(
				commit.write((project) =>
					sql
						.withTransaction(
							Effect.gen(function* () {
								const appended = yield* eventStore.appendBatch([
									canonicalEvent(
										"session.renamed",
										"s1",
										{ sessionId: "s1", title: "Renamed" },
										{ provider: "claude" },
									),
								]);
								yield* project(appended);
								return yield* Effect.fail("inner failed" as const);
							}),
						)
						.pipe(Effect.catchAll(() => Effect.void)),
				),
			);

			expect(Exit.isFailure(exit)).toBe(true);
			expect(advances).toEqual([]);

			const [after] = yield* sql<{ value: number }>`
				SELECT value FROM read_model_counter WHERE id = 1`;
			expect(after?.value).toBe(before?.value);

			const rows = yield* sql<{ title: string }>`
				SELECT title FROM sessions WHERE id = 's1'`;
			expect(rows).toEqual([{ title: "First" }]);
		}),
	);
});

const createdSession = (id: string, parentId?: string) =>
	canonicalEvent(
		"session.created",
		id,
		{
			sessionId: id,
			title: id,
			provider: "claude",
			...(parentId ? { parentId } : {}),
		},
		{ provider: "claude" },
	);

it("a delete announces the session it removed and the subagents it took with it", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;

			yield* commit([createdSession("parent")]);
			yield* commit([createdSession("sub", "parent")]);
			yield* commit([createdSession("bystander")]);
			advances.length = 0;

			yield* applySessionCommand({
				type: "session.deleted",
				data: { sessionId: "parent" },
			});

			// The subagent row goes inside SQLite, through the parent_id cascade,
			// where no statement names it — so "sub" can only have come from the
			// handler reading the subtree before the delete.
			expect(
				yield* sql<{ id: string }>`SELECT id FROM sessions ORDER BY id`,
			).toEqual([{ id: "bystander" }]);
			expect(
				advances.map((advance) => ({
					version: advance.version,
					sessionIds: [...advance.sessionIds].sort(),
					removedSessionIds: [...advance.removedSessionIds].sort(),
				})),
			).toEqual([
				{ version: 4, sessionIds: [], removedSessionIds: ["parent", "sub"] },
			]);
		}),
	);
});

it("a delete of a session that is already gone announces nothing", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;

			yield* commit([createdSession("s1")]);
			yield* commit([
				canonicalEvent(
					"session.deleted",
					"s1",
					{ sessionId: "s1" },
					{ provider: "claude" },
				),
			]);
			advances.length = 0;

			// Replay re-applies the delete. The row is already gone, so there is no
			// removal to announce — the same rule that keeps a declined write quiet.
			yield* commit([
				canonicalEvent(
					"session.deleted",
					"s1",
					{ sessionId: "s1" },
					{ provider: "claude" },
				),
			]);

			expect(advances).toEqual([]);
		}),
	);
});

const deletedSession = (id: string) =>
	canonicalEvent(
		"session.deleted",
		id,
		{ sessionId: id },
		{ provider: "claude" },
	);

// A commit is a sequence, not a set. The advance has to describe the row the
// commit left behind, so the last thing that happened to a session is the only
// thing worth announcing about it — unioning the two lists, or letting removal
// win, tells a subscriber to drop a session that is still there.
it("a delete followed by a re-create in one commit announces the row that survived", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;

			yield* commit([createdSession("s1")]);
			advances.length = 0;

			yield* commit([deletedSession("s1"), createdSession("s1")]);

			expect(
				yield* sql<{
					id: string;
					version: number;
				}>`SELECT id, version FROM sessions`,
			).toEqual([{ id: "s1", version: 2 }]);
			expect(advances).toEqual([
				{ version: 2, sessionIds: ["s1"], removedSessionIds: [] },
			]);
		}),
	);
});

it("a re-create followed by a delete in one commit announces only the removal", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;

			yield* commit([createdSession("s2"), deletedSession("s2")]);

			expect(yield* sql<{ id: string }>`SELECT id FROM sessions`).toEqual([]);
			expect(advances).toEqual([
				{ version: 1, sessionIds: [], removedSessionIds: ["s2"] },
			]);
		}),
	);
});

it("a body that projects twice is judged by its last projection, not the union", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			const eventStore = yield* EventStoreEffectTag;

			yield* commit([createdSession("s3")]);
			advances.length = 0;

			// Two projections, two versions, one advance. The seam folds across
			// projection calls for the same reason the runner folds across events.
			yield* commit.write((project) =>
				Effect.gen(function* () {
					yield* project(yield* eventStore.appendBatch([deletedSession("s3")]));
					yield* project(yield* eventStore.appendBatch([createdSession("s3")]));
				}),
			);

			expect(
				yield* sql<{
					id: string;
					version: number;
				}>`SELECT id, version FROM sessions`,
			).toEqual([{ id: "s3", version: 3 }]);
			expect(advances).toEqual([
				{ version: 3, sessionIds: ["s3"], removedSessionIds: [] },
			]);
		}),
	);
});
