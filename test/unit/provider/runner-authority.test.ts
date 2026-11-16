import { it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Fiber,
	Layer,
	Logger,
	Option,
	References,
} from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import { SessionEventBusLive } from "../../../src/lib/domain/project-services/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	type Grant,
	makeRunnerAuthority,
	type Write,
} from "../../../src/lib/provider/runner/runner-authority.js";

const testLayer = Layer.merge(
	makePersistenceEffectLayer(
		":memory:",
		"test-project",
		undefined,
		SessionEventBusLive,
	),
	SessionEventBusLive,
);

it.effect(
	"grants enforce the policy and revoke takes no cohort and leaves no cleanup state",
	() =>
		Effect.gen(function* () {
			const authority = yield* makeRunnerAuthority();
			const starting = (yield* authority.adopt(
				[{ runnerId: "warm", sessionId: "s" }],
				"starting",
			)).grants.get("warm");
			if (!starting) return yield* Effect.die("missing starting grant");
			expect(
				Option.isNone(
					yield* authority.guarded(
						starting,
						{ kind: "output" },
						() => "output",
					),
				),
			).toBe(true);
			expect(
				Option.getOrUndefined(
					yield* authority.guarded(
						starting,
						{ kind: "evidence" },
						() => "fact",
					),
				),
			).toBe("fact");
			const live = (yield* authority.adopt(
				[{ runnerId: "live", sessionId: "s" }],
				"live",
			)).grants.get("live");
			if (!live) return yield* Effect.die("missing live grant");
			let writes = 0;
			expect(
				Option.isSome(
					yield* authority.guarded(live, { kind: "output" }, () => ++writes),
				),
			).toBe(true);
			for (const [grant, runnerId] of [
				[starting, "warm"],
				[live, "live"],
			] as const) {
				expect(yield* authority.revoke(grant, "retired")).toBeUndefined();
				const record = authority.records.get(runnerId);
				expect(record?.tag._tag).toBe("Retired");
				expect(record).not.toHaveProperty("cleanup");
				expect(record?.identity.sessionId).toBe("s");
				expect(
					Option.isNone(
						yield* authority.guarded(grant, { kind: "output" }, () => ++writes),
					),
				).toBe(true);
				expect(
					Option.isSome(
						yield* authority.guarded(
							grant,
							{ kind: "evidence" },
							() => ++writes,
						),
					),
				).toBe(true);
			}
			expect(writes).toBe(3);
		}),
);

it.effect("snapshots cannot mutate records and stale grants never revive", () =>
	Effect.gen(function* () {
		const authority = yield* makeRunnerAuthority();
		const grant = (yield* authority.adopt(
			[{ runnerId: "r", sessionId: "s" }],
			"live",
		)).grants.get("r");
		if (!grant) return yield* Effect.die("missing grant");
		const snapshot = authority.records.get("r");
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot?.identity)).toBe(true);
		authority.observe("r");
		expect(snapshot?.observation).toBe("Pending");
		expect(authority.records.get("r")?.observation).toBe("Observed");
		yield* authority.revoke(grant, "exited");
		expect(
			Option.isNone(
				yield* authority.guarded(grant, { kind: "output" }, () => "no"),
			),
		).toBe(true);
		authority.forget("r");
		yield* authority.adopt([{ runnerId: "r", sessionId: "s" }], "live");
		expect(
			Option.isNone(
				yield* authority.guarded(grant, { kind: "output" }, () => "no"),
			),
		).toBe(true);
		expect(
			Option.isSome(
				yield* authority.guarded(grant, { kind: "evidence" }, () => "fact"),
			),
		).toBe(true);
	}),
);

it.live("revocation rolls back an old write holding the permit", () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const authority = yield* makeRunnerAuthority();
		const grant = (yield* authority.adopt(
			[{ runnerId: "r", sessionId: "s" }],
			"live",
		)).grants.get("r");
		if (!grant) return yield* Effect.die("missing grant");
		yield* sql`CREATE TABLE guarded_writes (value TEXT)`;
		const writer = yield* makeCommitAndSignal;
		const entered = yield* Deferred.make<void>();
		const release = yield* Deferred.make<void>();
		const old = yield* authority
			.guarded(
				grant,
				{ kind: "output" },
				writer.write(
					() =>
						Effect.gen(function* () {
							yield* sql`INSERT INTO guarded_writes VALUES ('stale')`;
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(release);
						}),
					{ runnerId: grant.runnerId },
				),
			)
			.pipe(Effect.forkChild);
		yield* Deferred.await(entered);
		yield* authority.revoke(grant, "retired");
		yield* Deferred.succeed(release, undefined);
		expect(Option.isNone(yield* Fiber.join(old))).toBe(true);
		expect(yield* sql`SELECT * FROM guarded_writes`).toEqual([]);
	}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"runner writes reaching the seam without their grant are defects",
	() =>
		Effect.gen(function* () {
			const writer = yield* makeCommitAndSignal;
			const exit = yield* Effect.exit(
				writer.write(() => Effect.void, { runnerId: "orphan" }),
			);
			expect(exit._tag).toBe("Failure");
		}).pipe(Effect.provide(testLayer)),
);

it.effect(
	"each stale runner and write kind logs once without invoking its thunk",
	() =>
		Effect.gen(function* () {
			const warnings: string[] = [];
			const logs = Logger.layer([
				Logger.make((options) => {
					if (options.logLevel === "Warn")
						warnings.push(String(options.message));
				}),
			]);
			yield* Effect.gen(function* () {
				const authority = yield* makeRunnerAuthority();
				let calls = 0;
				for (const reason of ["superseded", "exited", "retired"] as const) {
					const grant = (yield* authority.adopt(
						[{ runnerId: reason, sessionId: reason }],
						"live",
					)).grants.get(reason);
					if (!grant) return yield* Effect.die("missing grant");
					yield* authority.revoke(grant, reason);
					for (let repeat = 0; repeat < 2; repeat++)
						expect(
							Option.isNone(
								yield* authority.guarded(
									grant,
									{ kind: "output" },
									() => ++calls,
								),
							),
						).toBe(true);
					expect(
						Option.isSome(
							yield* authority.guarded(
								grant,
								{ kind: "evidence" },
								() => "fact",
							),
						),
					).toBe(true);
				}
				expect(calls).toBe(0);
			}).pipe(
				Effect.provide(logs),
				Effect.provideService(References.MinimumLogLevel, "Warn"),
			);
			expect(warnings).toHaveLength(3);
			expect(new Set(warnings).size).toBe(3);
		}),
);

it.effect("the operation's own failure passes through unchanged", () =>
	Effect.gen(function* () {
		const authority = yield* makeRunnerAuthority();
		const grant = (yield* authority.adopt(
			[{ runnerId: "r", sessionId: "s" }],
			"live",
		)).grants.get("r");
		if (!grant) return yield* Effect.die("missing grant");
		const failure = { _tag: "OperationFailed" };
		expect(
			yield* Effect.flip(
				authority.guarded(grant, { kind: "output" }, Effect.fail(failure)),
			),
		).toBe(failure);
	}),
);

it.effect(
	"detaching fences old callbacks and reattachment mints a fresh grant",
	() =>
		Effect.gen(function* () {
			const authority = yield* makeRunnerAuthority<{ id: string }>();
			const grant = (yield* authority.adopt(
				[{ runnerId: "r", sessionId: "s", entry: { id: "old" } }],
				"live",
			)).grants.get("r");
			if (!grant) return yield* Effect.die("missing grant");
			authority.detach("r");
			expect(
				Option.isNone(
					yield* authority.guarded(grant, { kind: "output" }, () => "old"),
				),
			).toBe(true);
			const fresh = (yield* authority.adopt(
				[{ runnerId: "r", sessionId: "s", entry: { id: "new" } }],
				"live",
			)).grants.get("r");
			if (!fresh) return yield* Effect.die("missing fresh grant");
			expect(fresh).not.toBe(grant);
			expect(
				Option.isSome(
					yield* authority.guarded(fresh, { kind: "output" }, () => "new"),
				),
			).toBe(true);
			expect(
				Option.isNone(
					yield* authority.guarded(grant, { kind: "output" }, () => "old"),
				),
			).toBe(true);
		}),
);

it.effect(
	"pre-revocation evidence preserves identity and refuses late changes",
	() =>
		Effect.gen(function* () {
			const authority = yield* makeRunnerAuthority();
			const grant = (yield* authority.adopt(
				[{ runnerId: "r", sessionId: "s", attachmentId: "attached" }],
				"live",
			)).grants.get("r");
			if (!grant) return yield* Effect.die("missing grant");
			const snapshot = authority.records.get("r");
			const evidence = {
				runnerId: "moved",
				sessionId: "foreign",
				attachmentId: "foreign",
				pid: 42,
				startTime: "started",
				signalled: true,
			};
			expect(authority.captureBeforeRevoke("r", evidence)).toBe(true);
			expect([...authority.records.keys()]).toEqual(["r"]);
			expect(authority.records.get("r")?.identity).toMatchObject({
				runnerId: "r",
				sessionId: "s",
				attachmentId: "attached",
				pid: 42,
				startTime: "started",
				signalled: true,
			});
			expect(snapshot?.identity.pid).toBeUndefined();
			yield* authority.revoke(grant, "retired");
			expect(authority.captureBeforeRevoke("r", { ...evidence, pid: 99 })).toBe(
				false,
			);
			expect(authority.records.get("r")?.identity.pid).toBe(42);
		}),
);

it.effect("copied grants are refused for every write kind", () =>
	Effect.gen(function* () {
		const authority = yield* makeRunnerAuthority();
		const granted: Grant[] = [];
		for (const phase of ["starting", "live"] as const) {
			const grant = (yield* authority.adopt(
				[{ runnerId: phase, sessionId: phase }],
				phase,
			)).grants.get(phase);
			if (!grant) return yield* Effect.die("missing grant");
			granted.push(grant);
		}
		const live = (yield* authority.adopt(
			[{ runnerId: "current", sessionId: "current" }],
			"live",
		)).grants.get("current");
		if (!live) return yield* Effect.die("missing live grant");
		granted.push(live);
		for (const grant of granted) {
			const copy = { ...grant };
			const writes: readonly Write[] = [
				{ kind: "output" },
				{ kind: "evidence" },
			];
			for (const write of writes) {
				expect(Option.isNone(authority.authorize(copy, write))).toBe(true);
				expect(
					Option.isNone(yield* authority.guarded(copy, write, () => "forged")),
				).toBe(true);
			}
		}
	}),
);

it.live(
	"a caller cannot swallow the final stale check and report a committed write",
	() => {
		const warnings: string[] = [];
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const authority = yield* makeRunnerAuthority();
			const grant = (yield* authority.adopt(
				[{ runnerId: "r", sessionId: "s" }],
				"live",
			)).grants.get("r");
			if (!grant) return yield* Effect.die("missing grant");
			yield* sql`CREATE TABLE swallowed_stale_writes (value TEXT)`;
			const writer = yield* makeCommitAndSignal;
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const old = yield* authority
				.guarded(
					grant,
					{ kind: "output" },
					writer
						.write(
							() =>
								Effect.gen(function* () {
									yield* sql`INSERT INTO swallowed_stale_writes VALUES ('stale')`;
									yield* Deferred.succeed(entered, undefined);
									yield* Deferred.await(release);
								}),
							{ runnerId: grant.runnerId },
						)
						.pipe(Effect.catchCause(() => Effect.void)),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			yield* authority.revoke(grant, "retired");
			yield* Deferred.succeed(release, undefined);
			expect(Option.isNone(yield* Fiber.join(old))).toBe(true);
			expect(yield* sql`SELECT * FROM swallowed_stale_writes`).toEqual([]);
			expect(warnings).toHaveLength(1);
		}).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((options) => {
						if (options.logLevel === "Warn")
							warnings.push(String(options.message));
					}),
				]),
			),
			Effect.provideService(References.MinimumLogLevel, "Warn"),
			Effect.provide(testLayer),
		);
	},
);
