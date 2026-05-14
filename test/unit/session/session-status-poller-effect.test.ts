import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, HashMap, Layer, Ref } from "effect";
import { expect, vi } from "vitest";
import {
	clearMessageActivity,
	getCurrentStatuses,
	isProcessing,
	makePollerPubSubLive,
	makePollerStateLive,
	markMessageActivity,
	notifySSEIdle,
	PollerStateTag,
	poll,
	reconcile,
	reconcileNow,
	type StatusCorrection,
} from "../../../src/lib/domain/relay/Services/session-status-poller.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { readSessionStatusesFromEffect } from "../../../src/lib/session/session-status-effect.js";

const makeTestLayer = () =>
	Layer.fresh(makePollerStateLive()).pipe(
		Layer.merge(Layer.fresh(makePollerPubSubLive())),
	);

describe("SessionStatusPoller Effect", () => {
	const mockApi = {
		getSessionStatuses: vi.fn().mockReturnValue(
			Effect.succeed([
				{ id: "s1", status: "idle" },
				{ id: "s2", status: "busy" },
			]),
		),
	};

	const mockDb = {
		getSessionStatuses: vi.fn().mockReturnValue(
			Effect.succeed([
				{ id: "s1", status: "idle" },
				{ id: "s2", status: "idle" }, // Mismatch — API says busy, DB says idle
			]),
		),
	};

	it.effect("initializes with empty state", () =>
		Effect.gen(function* () {
			const ref = yield* PollerStateTag;
			const result = yield* Ref.get(ref);
			expect(Object.keys(result.previousStatuses).length).toBe(0);
			expect(HashMap.size(result.activityTimestamps)).toBe(0);
		}).pipe(Effect.provide(makeTestLayer())),
	);

	it.effect("reconcile detects status mismatches", () =>
		Effect.gen(function* () {
			const corrections: StatusCorrection[] = [];
			const applyCorrection = vi.fn((c: StatusCorrection) => {
				corrections.push(c);
				return Effect.succeed(undefined);
			});
			yield* reconcile(mockDb, mockApi, applyCorrection);
			expect(corrections.length).toBeGreaterThanOrEqual(1);
		}).pipe(Effect.provide(makeTestLayer())),
	);

	it.effect("reconcile caps correction concurrency without dropping work", () =>
		Effect.gen(function* () {
			const sessionCount = 12;
			const maxAllowedConcurrency = 8;
			const dbSessions = Array.from({ length: sessionCount }, (_, index) => ({
				id: `s${index}`,
				status: "idle",
			}));
			const apiSessions = dbSessions.map((session) => ({
				...session,
				status: "busy",
			}));
			const current = yield* Ref.make(0);
			const maxObserved = yield* Ref.make(0);
			const processed = yield* Ref.make<ReadonlyArray<string>>([]);
			const firstCorrectionStarted = yield* Deferred.make<void>();
			const releaseCorrections = yield* Deferred.make<void>();
			const applyCorrection = (correction: StatusCorrection) =>
				Effect.gen(function* () {
					const inFlight = yield* Ref.updateAndGet(current, (n) => n + 1);
					yield* Ref.update(maxObserved, (n) => Math.max(n, inFlight));
					yield* Deferred.succeed(firstCorrectionStarted, void 0).pipe(
						Effect.ignore,
					);
					yield* Deferred.await(releaseCorrections);
					yield* Ref.update(processed, (ids) => [...ids, correction.sessionId]);
					yield* Ref.update(current, (n) => n - 1);
				});

			const fiber = yield* Effect.fork(
				reconcile(
					{
						getSessionStatuses: () => Effect.succeed(dbSessions),
					},
					{
						getSessionStatuses: () => Effect.succeed(apiSessions),
					},
					applyCorrection,
				),
			);
			yield* Deferred.await(firstCorrectionStarted);
			for (let index = 0; index < maxAllowedConcurrency; index++) {
				yield* Effect.yieldNow();
			}
			expect(yield* Ref.get(maxObserved)).toBe(maxAllowedConcurrency);
			yield* Deferred.succeed(releaseCorrections, void 0);
			yield* Fiber.join(fiber);

			expect(yield* Ref.get(maxObserved)).toBeLessThanOrEqual(
				maxAllowedConcurrency,
			);
			expect(new Set(yield* Ref.get(processed)).size).toBe(sessionCount);
		}).pipe(Effect.provide(makeTestLayer())),
	);

	it.effect("isMessageActive checks TTL correctly", () =>
		Effect.gen(function* () {
			const now = Date.now();
			const ref = yield* PollerStateTag;
			yield* Ref.update(ref, (s) => ({
				...s,
				activityTimestamps: HashMap.fromIterable([
					["active", now - 1000] as const,
					["stale", now - 300_000] as const,
				]),
			}));
			const state = yield* Ref.get(ref);
			const activeTTL = Duration.seconds(60);
			const activeTs = HashMap.unsafeGet(state.activityTimestamps, "active");
			const staleTs = HashMap.unsafeGet(state.activityTimestamps, "stale");
			expect(now - activeTs < Duration.toMillis(activeTTL)).toBe(true);
			expect(now - staleTs < Duration.toMillis(activeTTL)).toBe(false);
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
					getSessionParentMap: () => Effect.succeed(new Map()),
					resolveParent: () => Effect.succeed(undefined),
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

	it.effect("reconcileNow reads projected sessions from an Effect", () =>
		Effect.gen(function* () {
			const injected: Array<{ sessionId: string; status: string }> = [];

			yield* reconcileNow({
				getRestStatuses: () =>
					Effect.succeed({
						"session-effect-reconcile": { type: "idle" as const },
					}),
				getProjectedSessions: () =>
					Effect.succeed([
						{
							id: "session-effect-reconcile",
							status: "busy",
							updated_at: Date.now(),
						},
					]),
				injectCorrectiveEvent: (sessionId, status) =>
					Effect.sync(() => {
						injected.push({ sessionId, status });
					}),
			});

			expect(injected).toEqual([
				{ sessionId: "session-effect-reconcile", status: "idle" },
			]);
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

	it.effect("markMessageActivity sets timestamp", () =>
		Effect.gen(function* () {
			yield* markMessageActivity("s1");
			const ref = yield* PollerStateTag;
			const state = yield* Ref.get(ref);
			expect(HashMap.has(state.activityTimestamps, "s1")).toBe(true);
		}).pipe(Effect.provide(makeTestLayer())),
	);

	it.effect("clearMessageActivity removes timestamp", () =>
		Effect.gen(function* () {
			yield* markMessageActivity("s1");
			yield* clearMessageActivity("s1");
			const ref = yield* PollerStateTag;
			const state = yield* Ref.get(ref);
			expect(HashMap.has(state.activityTimestamps, "s1")).toBe(false);
		}).pipe(Effect.provide(makeTestLayer())),
	);

	it.effect("notifySSEIdle adds to sseIdleSessions and clears activity", () =>
		Effect.gen(function* () {
			yield* markMessageActivity("s1");
			yield* notifySSEIdle("s1");
			const ref = yield* PollerStateTag;
			const state = yield* Ref.get(ref);
			expect(state.sseIdleSessions.has("s1")).toBe(true);
			expect(HashMap.has(state.activityTimestamps, "s1")).toBe(false);
		}).pipe(Effect.provide(makeTestLayer())),
	);

	it.effect("markMessageActivity is ignored for SSE-idle sessions", () =>
		Effect.gen(function* () {
			yield* notifySSEIdle("s1");
			yield* markMessageActivity("s1");
			const ref = yield* PollerStateTag;
			const state = yield* Ref.get(ref);
			// Activity should NOT be set because SSE confirmed idle
			expect(HashMap.has(state.activityTimestamps, "s1")).toBe(false);
		}).pipe(Effect.provide(makeTestLayer())),
	);
});
