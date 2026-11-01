// 32.4: each write that first sets a runner's retired_at records its loss (CONTRACT 6.5), against
// real SQLite through the receipt store, the release commit and the projecting write.
// How it could fail:
// 1. a raw Stop retires a runner and records no loss, or only the serving runner's, not its candidates';
// 2. a repeat Stop, or a reconciler upsert that keeps the first retired_at, records a second loss;
// 3. a runner whose session row is gone or has no project fails its retirement instead of recording none;
// 4. a raw loss is never folded (a later batch moves the cursors past it), or folds with no advance;
// 5. a crash after a raw retirement leaves the loss unfolded after a restart;
// 6. the release commit records the loss before its releases, or leaves it for a later commit;
// 7. a failed loss append still commits the retirement;
// 8. a prune removes a retirement row whose loss was never committed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Exit, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import type { ReadModelAdvance } from "../../../src/lib/contracts/read-model-advance.js";
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
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	makeRunnerReceiptStore,
	type RunnerRetirement,
	stopRecord,
} from "../../../src/lib/provider/runner/runner-receipts.js";
import { makeRunnerRunLifecycle } from "../../../src/lib/provider/runner/runner-retirement.js";
import { makeSessionCreatedEvent } from "../../helpers/persistence-factories.js";

const layerAt = (dir: string, advances: ReadModelAdvance[]) => {
	const bus = Layer.succeed(SessionEventBusTag)({
		publish: () => Effect.void,
		publishAdvance: (advance) => Effect.sync(() => void advances.push(advance)),
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	} satisfies SessionEventBus);
	return Layer.merge(
		makePersistenceEffectLayer(
			join(dir, "events.db"),
			"test-project",
			undefined,
			bus,
		),
		bus,
	);
};

/** One store directory; `open` runs a body against a fresh daemon on it. */
const withDir = <A, E>(
	body: (
		open: <B, F>(
			effect: Effect.Effect<
				B,
				F,
				PersistenceEffectContext | SessionEventBusTag
			>,
		) => Effect.Effect<B, F | unknown>,
		advances: ReadModelAdvance[],
	) => Effect.Effect<A, E>,
) =>
	Effect.acquireUseRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), "runner-process-lost-"))),
		(dir) => {
			const advances: ReadModelAdvance[] = [];
			return body(
				(effect) => effect.pipe(Effect.provide(layerAt(dir, advances))),
				advances,
			);
		},
		(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
	);

const target = (runnerId: string, sessionId = "s1"): RunnerRetirement =>
	stopRecord(
		{
			runnerId,
			sessionId,
			driverKind: "claude",
			identity: { tag: "Verified", pid: 123, startTime: "started" },
			reaper: undefined,
			members: [],
		},
		0,
	);

/** Session s1 with Run r1 dispatched to runner R1, held at transmission 1. */
const seed = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	const at = (createdAt: number) => ({ provider: "claude", createdAt });
	yield* commit([
		makeSessionCreatedEvent("s1", { provider: "claude", createdAt: 1000 }),
		canonicalEvent(
			"input.admitted",
			"s1",
			{
				sessionId: "s1",
				inputId: "u1",
				delivery: "queue",
				request: { text: "hi", images: [] },
			},
			at(1001),
		),
		canonicalEvent(
			"input.sent",
			"s1",
			{ sessionId: "s1", inputId: "u1" },
			at(1002),
		),
		canonicalEvent(
			"run.requested",
			"s1",
			{ runId: "r1", inputId: "u1" },
			{ ...at(1003), metadata: { runId: "r1" } },
		),
		canonicalEvent(
			"run.started",
			"s1",
			{ inputId: "u1", requestedRunId: "r1" },
			{ ...at(1004), metadata: { runId: "r1" } },
		),
		canonicalEvent(
			"evidence.process_started",
			"s1",
			{ runnerId: "R1", label: "R1:1", reattached: false },
			at(1005),
		),
		canonicalEvent(
			"run.dispatched",
			"s1",
			{ runId: "r1", runnerId: "R1", commandId: "c1", transmission: 1 },
			at(1006),
		),
	]);
	return commit;
});

const losses = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql<{ session: string; runner: string; at: number }>`
		SELECT session_id AS session, json_extract(data, '$.runnerId') AS runner,
			json_extract(data, '$.retiredAt') AS at
		FROM events WHERE type = 'evidence.process_lost' ORDER BY runner, sequence`;
});

/** Run r1's end entries in the ledger. */
const ends = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	return (yield* sql<{ entry_json: string }>`
		SELECT entry_json FROM run_ledger_entries
		WHERE session_id = 's1' AND json_extract(entry_json, '$.kind') = 'end'
			AND json_extract(entry_json, '$.runId') = 'r1'
		ORDER BY entry_seq`).map(({ entry_json }): unknown =>
		JSON.parse(entry_json),
	);
});
const lost = [{ outcome: "error", reason: { tag: "process_lost" } }];

it.effect(
	"a raw Stop records one loss per runner it retires, folded and announced at the next commit",
	() =>
		withDir((open, advances) =>
			open(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* seed;
					const receipts = yield* makeRunnerReceiptStore(sql);
					yield* receipts.register("R1", { sessionId: "s1" }, "serving");
					yield* receipts.register("R2", { sessionId: "s1" }, "candidate");
					yield* TestClock.setTime(5000);
					expect(yield* receipts.requestStop(target("R1"))).toMatchObject({
						_tag: "Requested",
					});
					expect(yield* losses).toEqual([
						{ session: "s1", runner: "R1", at: 5000 },
						{ session: "s1", runner: "R2", at: 5000 },
					]);
					// Raw: unprojected until the next projecting write.
					expect(yield* ends).toEqual([]);
					const announced = advances.length;
					yield* commit([
						makeSessionCreatedEvent("s2", {
							provider: "claude",
							createdAt: 6000,
						}),
					]);
					expect(yield* ends).toMatchObject(lost);
					expect(
						advances.slice(announced).flatMap((advance) => advance.sessionIds),
					).toContain("s1");
					// A repeat Stop of a retired runner records nothing new.
					yield* TestClock.setTime(7000);
					yield* receipts.requestStop(target("R1"));
					expect(yield* losses).toHaveLength(2);
				}),
			),
		),
);

it.effect(
	"a runner whose session row is gone or has no project retires with no loss",
	() =>
		withDir((open) =>
			open(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const receipts = yield* makeRunnerReceiptStore(sql);
					yield* sql`INSERT INTO sessions (id, project_id, provider, created_at, updated_at) VALUES ('bare', '', 'claude', 1, 1)`;
					yield* receipts.register("ghost", { sessionId: "gone" }, "serving");
					yield* receipts.register("orphan", { sessionId: "bare" }, "serving");
					yield* TestClock.setTime(5000);
					yield* receipts.requestStop(target("ghost", "gone"));
					yield* receipts.requestStop(target("orphan", "bare"));
					yield* receipts.commitRetirement({
						...target("killed", "gone"),
						retiredAt: 5000,
					});
					expect(
						yield* sql`SELECT runner_id, retired_at FROM claude_runner_cursors ORDER BY runner_id`,
					).toEqual([
						{ runner_id: "ghost", retired_at: 5000 },
						{ runner_id: "killed", retired_at: 5000 },
						{ runner_id: "orphan", retired_at: 5000 },
					]);
					expect(yield* losses).toEqual([]);
				}),
			),
		),
);

it.effect(
	"the reconciler's upsert records a loss only when it first sets retired_at, with the row's time",
	() =>
		withDir((open) =>
			open(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* seed;
					const receipts = yield* makeRunnerReceiptStore(sql);
					yield* receipts.register("R1", { sessionId: "s1" }, "serving");
					yield* receipts.commitRetirement({
						...target("R1"),
						retiredAt: 7000,
					});
					yield* receipts.commitRetirement({
						...target("R3"),
						retiredAt: 8000,
					});
					yield* receipts.commitRetirement({
						...target("R3"),
						retiredAt: 9000,
					});
					expect(
						yield* sql`SELECT retired_at FROM claude_runner_cursors WHERE runner_id = 'R3'`,
					).toEqual([{ retired_at: 8000 }]);
					expect(yield* losses).toEqual([
						{ session: "s1", runner: "R1", at: 7000 },
						{ session: "s1", runner: "R3", at: 8000 },
					]);
					// Its loss is committed before any prune can drop the row (6.8).
					yield* receipts.markGone("R3");
					yield* receipts.pruneRetired("R3");
					expect(
						yield* sql`SELECT runner_id FROM claude_runner_cursors WHERE runner_id = 'R3'`,
					).toEqual([]);
					expect(yield* losses).toHaveLength(2);
				}),
			),
		),
);

it.effect(
	"a release commit records the loss after its releases and folds it in that commit",
	() =>
		withDir((open) =>
			open(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const commit = yield* seed;
					const receipts = yield* makeRunnerReceiptStore(sql);
					const lifecycle = makeRunnerRunLifecycle({
						sql,
						commit,
						eventStore: yield* EventStoreEffectTag,
					});
					yield* receipts.register("R1", { sessionId: "s1" }, "serving");
					yield* TestClock.setTime(5000);
					yield* lifecycle.commitStop(
						receipts.requestStopMutation(target("R1"), { _tag: "Idle" }),
						"R1",
						() => ({ reason: "Refused", refusalReason: "exiting" }),
					);
					expect(
						yield* sql`SELECT type FROM events WHERE type IN ('run.released', 'evidence.process_lost') ORDER BY sequence`,
					).toEqual([
						{ type: "run.released" },
						{ type: "evidence.process_lost" },
					]);
					// Projected in that commit: the batch watermark already covers it.
					expect(
						yield* sql`SELECT (SELECT MAX(last_applied_seq) FROM projector_cursors WHERE projector_name LIKE '@batch:%') = (SELECT MAX(sequence) FROM events) AS covered`,
					).toEqual([{ covered: 1 }]);
				}),
			),
		),
);

it.effect("a failed loss append rolls the raw retirement back", () =>
	withDir((open) =>
		open(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* seed;
				const receipts = yield* makeRunnerReceiptStore(sql);
				yield* receipts.register("R1", { sessionId: "s1" }, "serving");
				yield* sql`CREATE TRIGGER reject_loss BEFORE INSERT ON events WHEN NEW.type = 'evidence.process_lost' BEGIN SELECT RAISE(ABORT, 'loss failed'); END`;
				expect(
					Exit.isFailure(
						yield* Effect.exit(receipts.requestStop(target("R1"))),
					),
				).toBe(true);
				expect(
					yield* sql`SELECT retired_at FROM claude_runner_cursors WHERE runner_id = 'R1'`,
				).toEqual([{ retired_at: null }]);
			}),
		),
	),
);

it.effect("startup recovery folds a raw loss a crash left unfolded", () =>
	withDir((open) =>
		Effect.gen(function* () {
			yield* open(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* seed;
					const receipts = yield* makeRunnerReceiptStore(sql);
					yield* receipts.register("R1", { sessionId: "s1" }, "serving");
					yield* receipts.requestStop(target("R1"));
					expect(yield* ends).toEqual([]);
				}),
			);
			yield* open(
				Effect.gen(function* () {
					yield* (yield* ProjectionRunnerEffectTag).recover();
					expect(yield* ends).toMatchObject(lost);
				}),
			);
		}),
	),
);
