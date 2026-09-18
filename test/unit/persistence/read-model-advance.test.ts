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

			expect(advances).toEqual([{ version: 1, sessionIds: ["s1"] }]);
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

			expect(advances).toEqual([{ version: 2, sessionIds: ["s1"] }]);
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
				})),
			).toEqual([{ version: 3, sessionIds: ["sub"] }]);
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
