import { describe, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Fiber, Option, Result } from "effect";
import { SqlClient } from "effect/sql";
import { expect } from "vitest";
import {
	flushPendingWrites,
	makeCommitAndSignal,
} from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeRunnerAuthority } from "../../../src/lib/provider/runner/runner-authority.js";

describe("runner write authorization boundary", () => {
	it.effect("rejects a planted grant-less runner write before it commits", () =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const writer = yield* makeCommitAndSignal;
			const result = yield* Effect.exit(
				writer(
					[
						canonicalEvent("session.created", "stale", {
							sessionId: "stale",
							provider: "claude",
							title: "Stale output",
						}),
					],
					{ runnerId: "planted-runner" },
				),
			);
			expect(Exit.isFailure(result)).toBe(true);
			if (Exit.isFailure(result)) {
				const defect = Cause.findDefect(result.cause);
				expect(Result.isSuccess(defect)).toBe(true);
				if (Result.isSuccess(defect))
					expect(defect.success).toMatchObject({
						_tag: "MissingWriteAuthorization",
					});
			}
			expect(yield* sql`SELECT id FROM sessions WHERE id = 'stale'`).toEqual(
				[],
			);
			expect(
				yield* sql`SELECT event_id FROM events WHERE session_id = 'stale'`,
			).toEqual([]);
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
		),
	);

	for (const path of ["event", "maintenance"] as const) {
		it.effect(`rejects a ${path} fork that loses the authority context`, () =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const writer = yield* makeCommitAndSignal;
				const authority = yield* makeRunnerAuthority();
				const { grants } = yield* authority.adopt(
					[{ runnerId: "planted-runner", sessionId: "escaped" }],
					"live",
				);
				const grant = grants.get("planted-runner");
				if (!grant)
					return yield* Effect.die("The live runner must have a grant");
				yield* sql`CREATE TABLE planted_writes (value TEXT)`;
				const write =
					path === "event"
						? writer(
								[
									canonicalEvent("session.created", "escaped", {
										sessionId: "escaped",
										provider: "claude",
										title: "Escaped output",
									}),
								],
								{ runnerId: "planted-runner" },
							)
						: flushPendingWrites(
								sql,
								sql`INSERT INTO planted_writes VALUES ('stale')`.pipe(
									Effect.asVoid,
								),
								{ runnerId: "planted-runner" },
							);
				const guarded = yield* authority.guarded(
					grant,
					{ kind: "output" },
					Effect.gen(function* () {
						const fork = yield* Effect.exit(write).pipe(
							Effect.setContext(Context.empty()),
							Effect.forkChild,
						);
						return yield* Fiber.join(fork);
					}),
				);
				expect(Option.isSome(guarded)).toBe(true);
				if (!Option.isSome(guarded)) return;
				const result = guarded.value;
				expect(Exit.isFailure(result)).toBe(true);
				if (Exit.isFailure(result)) {
					const defect = Cause.findDefect(result.cause);
					expect(Result.isSuccess(defect)).toBe(true);
					if (Result.isSuccess(defect))
						expect(defect.success).toMatchObject({
							_tag: "MissingWriteAuthorization",
						});
				}
				expect(
					yield* sql`SELECT id FROM sessions WHERE id = 'escaped'`,
				).toEqual([]);
				expect(yield* sql`SELECT value FROM planted_writes`).toEqual([]);
			}).pipe(
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
	}
});
