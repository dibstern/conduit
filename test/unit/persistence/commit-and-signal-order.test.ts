import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { SqlClient, Statement } from "effect/sql";
import { expect, vi } from "vitest";
import {
	type SessionEventBus,
	SessionEventBusLive,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	flushPendingWrites,
	makeCommitAndSignal,
	queuePendingWrite,
} from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { SessionStateProjectionNotifierTag } from "../../../src/lib/persistence/effect/session-state-projection-notifier.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeRunnerAuthority } from "../../../src/lib/provider/runner/runner-authority.js";

const testLayer = Layer.merge(
	makePersistenceEffectLayer(
		":memory:",
		"test-project",
		undefined,
		SessionEventBusLive,
	),
	SessionEventBusLive,
);

const created = (sessionId: string) =>
	canonicalEvent("session.created", sessionId, {
		sessionId,
		title: sessionId,
		provider: "claude",
	});

describe("commit advance ordering", () => {
	it.effect(
		"S7round2 flushes maintenance queued while the input invariant reads before committing",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const write = yield* makeCommitAndSignal;
				yield* sql`CREATE TABLE late_commit_maintenance (value TEXT)`;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				let gated = false;
				const committed = vi.fn();
				const writing = yield* write
					.write(() => Effect.void)
					.pipe(
						Effect.provideService(Statement.CurrentTransformer, (statement) => {
							if (
								gated ||
								!statement.compile()[0].includes("FROM pending_inputs pending")
							)
								return Effect.succeed(statement);
							gated = true;
							return Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release)),
								Effect.as(statement),
							);
						}),
						Effect.forkChild,
					);
				yield* Deferred.await(entered);
				queuePendingWrite(sql, "during-input-invariant", {
					apply:
						sql`INSERT INTO late_commit_maintenance VALUES ('committed')`.pipe(
							Effect.asVoid,
						),
					committed,
				});
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(writing);
				expect(yield* sql`SELECT value FROM late_commit_maintenance`).toEqual([
					{ value: "committed" },
				]);
				expect(committed).toHaveBeenCalledTimes(1);
				yield* flushPendingWrites(sql);
				expect(yield* sql`SELECT value FROM late_commit_maintenance`).toEqual([
					{ value: "committed" },
				]);
				expect(committed).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(testLayer)),
	);

	it.live(
		"does not flush a superseded grant's queued write after replacement",
		() =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const authority = yield* makeRunnerAuthority();
				const old = (yield* authority.adopt(
					[{ runnerId: "old", sessionId: "session", registeredAt: 1 }],
					"live",
				)).grants.get("old");
				if (!old) return yield* Effect.die("missing old grant");
				yield* sql`CREATE TABLE queued_runner_writes (value TEXT)`;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const committed: string[] = [];
				queuePendingWrite(sql, "blocker", {
					apply: Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(release)),
					),
				});
				queuePendingWrite(sql, "runner-write", {
					apply: authority
						.guarded(
							old,
							{ kind: "evidence" },
							sql`INSERT INTO queued_runner_writes VALUES ('old')`,
						)
						.pipe(Effect.asVoid),
					committed: () => committed.push("old"),
				});
				const flushing = yield* flushPendingWrites(sql).pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				const fresh = (yield* authority.adopt(
					[
						{
							runnerId: "fresh",
							sessionId: "session",
							registeredAt: 2,
							entry: {},
						},
					],
					"live",
				)).grants.get("fresh");
				if (!fresh) return yield* Effect.die("missing fresh grant");
				expect(authority.records.get("old")?.tag).toEqual({
					_tag: "Exiting",
					reason: "superseded",
				});
				queuePendingWrite(sql, "runner-write", {
					apply: authority
						.guarded(
							fresh,
							{ kind: "evidence" },
							sql`INSERT INTO queued_runner_writes VALUES ('fresh')`,
						)
						.pipe(Effect.asVoid),
					committed: () => committed.push("fresh"),
				});
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(flushing);
				expect(yield* sql`SELECT value FROM queued_runner_writes`).toEqual([
					{ value: "fresh" },
				]);
				expect(committed).toEqual(["fresh"]);
				yield* flushPendingWrites(sql);
				expect(committed).toEqual(["fresh"]);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect(
		"publishes only committed run transitions despite rollback and a reused report",
		() =>
			Effect.gen(function* () {
				const writer = yield* makeCommitAndSignal;
				const sql = yield* SqlClient.SqlClient;
				const owner = { provider: "claude", metadata: { runId: "owned-run" } };
				yield* writer([
					created("owned-session"),
					canonicalEvent(
						"run.requested",
						"owned-session",
						{ runId: "owned-run", inputId: "owned-input" },
						owner,
					),
					canonicalEvent(
						"message.created",
						"owned-session",
						{
							sessionId: "owned-session",
							messageId: "owned-input",
							inputId: "owned-input",
							role: "user",
						},
						owner,
					),
					canonicalEvent(
						"run.started",
						"owned-session",
						{ requestedRunId: "owned-run", inputId: "owned-input" },
						owner,
					),
				]);
				const events = yield* (yield* SessionEventBusTag).subscribe();
				const report = new Set<string>();
				const rolledBack = canonicalEvent(
					"turn.completed",
					"owned-session",
					{ messageId: "" },
					owner,
				);
				yield* Effect.exit(
					writer([rolledBack], {
						endedRunEvents: report,
						beforeCommit: Effect.die("rollback the terminal"),
					}),
				);
				expect(report.size).toBe(0);
				expect(yield* sql`SELECT status FROM provider_runs`).toEqual([
					{ status: "running" },
				]);
				const terminal = canonicalEvent(
					"turn.completed",
					"owned-session",
					{ messageId: "" },
					owner,
				);
				yield* writer([terminal], { endedRunEvents: report });
				expect(report.has(terminal.eventId)).toBe(true);
				const duplicate = canonicalEvent(
					"turn.completed",
					"owned-session",
					{ messageId: "" },
					owner,
				);
				// A caller's reused collection cannot manufacture a second transition.
				report.add(duplicate.eventId);
				yield* writer([duplicate], { endedRunEvents: report });
				const delivered = yield* events.pipe(Stream.take(2), Stream.runCollect);
				expect(delivered.map((event) => event.runEnded ?? false)).toEqual([
					true,
					false,
				]);
			}).pipe(Effect.provide(testLayer)),
	);

	it.effect("publishes committed events before invoking the notifier", () =>
		Effect.gen(function* () {
			const order: string[] = [];
			const bus = yield* SessionEventBusTag;
			const recordingBus: SessionEventBus = {
				...bus,
				publish: (events) =>
					Effect.sync(() => {
						order.push("publish");
					}).pipe(Effect.andThen(bus.publish(events))),
			};
			const writer = yield* makeCommitAndSignal.pipe(
				Effect.provideService(SessionEventBusTag, recordingBus),
			);
			yield* writer([created("ordered")]).pipe(
				Effect.provideService(SessionStateProjectionNotifierTag, {
					sessionStateProjected: () => Effect.sync(() => order.push("notify")),
				}),
			);
			expect(order).toEqual(["publish", "notify"]);
		}).pipe(Effect.provide(testLayer, { local: true })),
	);
	it.effect("does not notify while recover replays the event log", () => {
		const sessionStateProjected = vi.fn(() => Effect.void);
		return Effect.gen(function* () {
			const store = yield* EventStoreEffectTag;
			const runner = yield* ProjectionRunnerEffectTag;
			yield* store.append(created("replayed"));
			yield* runner.recover();
			expect(sessionStateProjected).not.toHaveBeenCalled();
		}).pipe(
			Effect.provideService(SessionStateProjectionNotifierTag, {
				sessionStateProjected,
			}),
			Effect.provide(testLayer, { local: true }),
		);
	});

	it.effect(
		"notifies after the event and its projection have committed",
		() => {
			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const sessionStateProjected = vi.fn((sessionId: string) =>
					sql<{
						title: string;
					}>`SELECT title FROM sessions WHERE id = ${sessionId}`.pipe(
						Effect.tap((rows) =>
							Effect.sync(() => expect(rows).toEqual([{ title: sessionId }])),
						),
						Effect.orDie,
						Effect.asVoid,
					),
				);
				const writer = yield* makeCommitAndSignal;
				yield* writer([created("committed")]).pipe(
					Effect.provideService(SessionStateProjectionNotifierTag, {
						sessionStateProjected,
					}),
				);
				expect(sessionStateProjected).toHaveBeenCalledOnce();
				expect(sessionStateProjected).toHaveBeenCalledWith(
					"committed",
					"session.created",
				);
			}).pipe(Effect.provide(testLayer, { local: true }));
		},
	);

	it.effect(
		"notifies once for every successfully projected batch event",
		() => {
			const sessionStateProjected = vi.fn(() => Effect.void);
			return Effect.gen(function* () {
				const writer = yield* makeCommitAndSignal;
				yield* writer([created("first"), created("second")]);
				expect(sessionStateProjected.mock.calls).toEqual([
					["first", "session.created"],
					["second", "session.created"],
				]);
			}).pipe(
				Effect.provideService(SessionStateProjectionNotifierTag, {
					sessionStateProjected,
				}),
				Effect.provide(testLayer, { local: true }),
			);
		},
	);

	it.effect("projects successfully when the notifier service is absent", () =>
		Effect.gen(function* () {
			const writer = yield* makeCommitAndSignal;
			yield* writer([created("without-notifier")]);
			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{ title: string }>`
				SELECT title FROM sessions WHERE id = 'without-notifier'`;
			expect(rows).toEqual([{ title: "without-notifier" }]);
		}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect(
		"allows afterCommit to commit again after publishing its own advance",
		() =>
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				const bus = yield* SessionEventBusTag;
				const advances = yield* bus.subscribeAdvances();
				const writer = yield* makeCommitAndSignal;
				yield* writer([created("a")], {
					afterCommit: writer([created("b")]).pipe(Effect.orDie),
				});
				const received = yield* Stream.runCollect(Stream.take(advances, 2));
				expect(Array.from(received, (advance) => advance.version)).toEqual([
					1, 2,
				]);
			}).pipe(Effect.provide(testLayer, { local: true })),
	);

	it.effect(
		"publishes in commit order across writers while afterCommit is stalled",
		() =>
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				const bus = yield* SessionEventBusTag;
				const advances = yield* bus.subscribeAdvances();
				const firstWriter = yield* makeCommitAndSignal;
				const secondWriter = yield* makeCommitAndSignal;
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const first = yield* firstWriter([created("a")], {
					afterCommit: Effect.andThen(
						Deferred.succeed(entered, undefined),
						Deferred.await(release),
					),
				}).pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				yield* secondWriter([created("b")]);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(first);
				const received = yield* Stream.runCollect(Stream.take(advances, 2));
				expect(Array.from(received, (advance) => advance.version)).toEqual([
					1, 2,
				]);
			}).pipe(Effect.provide(testLayer, { local: true })),
	);
});
