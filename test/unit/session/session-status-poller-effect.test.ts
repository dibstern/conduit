import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import {
	getCurrentStatuses,
	isProcessing,
	makePollerPubSubLive,
	makePollerStateLive,
	PollerStateTag,
	poll,
} from "../../../src/lib/domain/relay/Services/session-status-poller.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { readSessionStatusesFromEffect } from "../../../src/lib/session/session-status-effect.js";

const makeTestLayer = () =>
	Layer.fresh(makePollerStateLive()).pipe(
		Layer.merge(Layer.fresh(makePollerPubSubLive())),
	);

describe("SessionStatusPoller Effect", () => {
	it.effect("initializes with empty state", () =>
		Effect.gen(function* () {
			const ref = yield* PollerStateTag;
			const result = yield* Ref.get(ref);
			expect(Object.keys(result.previousStatuses).length).toBe(0);
		}).pipe(Effect.provide(makeTestLayer())),
	);

	it.effect("getCurrentStatuses returns empty when no polls have run", () =>
		Effect.gen(function* () {
			const statuses = yield* getCurrentStatuses;
			expect(Object.keys(statuses).length).toBe(0);
		}).pipe(Effect.provide(makeTestLayer())),
	);

	it.effect(
		"poll reads projected statuses from the Effect SQLite read service",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-status-effect-read-"));
			const filename = join(dir, "events.db");
			const layer = Layer.merge(
				makeTestLayer(),
				makePersistenceEffectLayer(filename),
			);

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
				INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES
					('session-idle', 'opencode', 'Idle Session', 'idle', 1, 1),
					('session-busy', 'opencode', 'Busy Session', 'busy', 2, 2)`;

				yield* poll({
					getRawStatuses: () => readSessionStatusesFromEffect,
				});

				const statuses = yield* getCurrentStatuses;
				expect(statuses["session-idle"]).toEqual({ type: "idle" });
				expect(statuses["session-busy"]).toEqual({ type: "busy" });
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect("staleness check skips sessions waiting on the user", () =>
		Effect.gen(function* () {
			const injected: Array<{ sessionId: string; status: string }> = [];
			const longAgo = Date.now() - 31 * 60_000;

			// The first poll runs the staleness pass.
			yield* poll({
				getRawStatuses: () => Effect.succeed({}),
				reconciliation: {
					getProjectedSessions: () =>
						Effect.succeed([
							{ id: "asking", status: "busy", updated_at: longAgo },
							{ id: "hung", status: "busy", updated_at: longAgo },
						]),
					getSessionsAwaitingUser: () => Effect.succeed(new Set(["asking"])),
					injectCorrectiveEvent: (sessionId, status) =>
						Effect.sync(() => {
							injected.push({ sessionId, status });
						}),
				},
			});

			expect(injected).toEqual([{ sessionId: "hung", status: "idle" }]);
		}).pipe(Effect.provide(makeTestLayer())),
	);

	it.effect("isProcessing returns false for unknown session", () =>
		Effect.gen(function* () {
			const result = yield* isProcessing("unknown-session");
			expect(result).toBe(false);
		}).pipe(Effect.provide(makeTestLayer())),
	);

	it.effect("isProcessing returns true for busy session", () =>
		Effect.gen(function* () {
			const ref = yield* PollerStateTag;
			yield* Ref.update(ref, (s) => ({
				...s,
				previousStatuses: {
					s1: { type: "busy" as const },
				},
			}));
			const result = yield* isProcessing("s1");
			expect(result).toBe(true);
		}).pipe(Effect.provide(makeTestLayer())),
	);
});
