import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Scope, TestClock } from "effect";
import { expect, vi } from "vitest";
import { AutoSettleLive } from "../../../src/lib/domain/daemon/Layers/auto-settle-layer.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	type Relay,
	RelayCacheTag,
} from "../../../src/lib/domain/daemon/Services/relay-cache.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const DAY = 86_400_000;

function fakeRelay(
	slug: string,
	sweep: () => Effect.Effect<number, unknown>,
): Relay {
	return {
		slug,
		attach: () => () => {},
		wsHandler: {},
		rpcWsHandler: {} as Relay["rpcWsHandler"],
		stop: () => {},
		settleIdleSessions: sweep,
	};
}

describe("daemon automatic settlement layer", () => {
	it.scoped(
		"ticks a running relay, skips cold empty projects, and survives one project failure",
		() =>
			Effect.gen(function* () {
				const dir = mkdtempSync(join(tmpdir(), "conduit-auto-layer-"));
				const calls: string[] = [];
				const relays = new Map([
					["broken", fakeRelay("broken", () => Effect.fail(new Error("boom")))],
					[
						"running",
						fakeRelay("running", () =>
							Effect.sync(() => {
								calls.push("running");
								return 1;
							}),
						),
					],
				]);
				const get = vi.fn((slug: string) =>
					Effect.succeed(
						relays.get(slug) ?? fakeRelay(slug, () => Effect.succeed(0)),
					),
				);
				const layer = AutoSettleLive.pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							DaemonConfigRefLive(
								makeDaemonConfigFromOptions({ autoSettleAfterDays: 3 }),
							),
							makeProjectRegistryLive([
								{
									slug: "broken",
									title: "Broken",
									directory: dir,
									lastUsed: 3,
								},
								{
									slug: "running",
									title: "Running",
									directory: dir,
									lastUsed: 2,
								},
								{ slug: "cold", title: "Cold", directory: dir, lastUsed: 1 },
							]),
							Layer.succeed(RelayCacheTag, {
								peek: (slug: string) =>
									Effect.succeed(Option.fromNullable(relays.get(slug))),
								get,
								invalidate: () => Effect.void,
							}),
							DaemonEventBusLive,
						),
					),
				);
				const scope = yield* Scope.make();
				try {
					yield* Layer.buildWithScope(layer, scope);
					yield* TestClock.adjust("1 millis");
					expect(calls).toContain("running");
					expect(get).not.toHaveBeenCalled();
					yield* TestClock.adjust("1 minute");
					expect(calls.length).toBeGreaterThanOrEqual(2);
				} finally {
					yield* Scope.close(scope, Exit.void);
					rmSync(dir, { recursive: true, force: true });
				}
			}),
	);

	it.scoped(
		"starts a cold project only when its persisted session is eligible",
		() =>
			Effect.gen(function* () {
				const dir = mkdtempSync(join(tmpdir(), "conduit-auto-cold-"));
				mkdirSync(join(dir, ".conduit"));
				const now = Date.now();
				const old = now - 4 * DAY;
				const dbPath = join(dir, ".conduit", "events.db");
				yield* Effect.gen(function* () {
					const store = yield* EventStoreEffectTag;
					const runner = yield* ProjectionRunnerEffectTag;
					yield* runner.markRecovered();
					for (const event of [
						canonicalEvent(
							"session.created",
							"cold-s1",
							{ sessionId: "cold-s1", title: "Cold", provider: "opencode" },
							{ createdAt: old - 1 },
						),
						canonicalEvent(
							"message.created",
							"cold-s1",
							{ sessionId: "cold-s1", messageId: "m1", role: "assistant" },
							{ createdAt: old },
						),
						canonicalEvent(
							"session.read",
							"cold-s1",
							{ sessionId: "cold-s1" },
							{ createdAt: old + 1 },
						),
					])
						yield* runner.projectEvent(yield* store.append(event));
				}).pipe(Effect.provide(makePersistenceEffectLayer(dbPath)));
				const sweep = vi.fn(() => Effect.succeed(1));
				const get = vi.fn(() => Effect.succeed(fakeRelay("cold", sweep)));
				const layer = AutoSettleLive.pipe(
					Layer.provideMerge(
						Layer.mergeAll(
							DaemonConfigRefLive(
								makeDaemonConfigFromOptions({ autoSettleAfterDays: 3 }),
							),
							makeProjectRegistryLive([
								{ slug: "cold", title: "Cold", directory: dir, lastUsed: 1 },
							]),
							Layer.succeed(RelayCacheTag, {
								peek: () => Effect.succeed(Option.none<Relay>()),
								get,
								invalidate: () => Effect.void,
							}),
							DaemonEventBusLive,
						),
					),
				);
				const scope = yield* Scope.make();
				try {
					yield* TestClock.setTime(now);
					yield* Layer.buildWithScope(layer, scope);
					yield* TestClock.adjust("1 millis");
					expect(get).toHaveBeenCalledWith("cold");
					expect(sweep).toHaveBeenCalled();
				} finally {
					yield* Scope.close(scope, Exit.void);
					rmSync(dir, { recursive: true, force: true });
				}
			}),
	);

	it.scoped("does no project work when disabled", () =>
		Effect.gen(function* () {
			const peek = vi.fn(() => Effect.succeed(Option.none<Relay>()));
			const layer = AutoSettleLive.pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						DaemonConfigRefLive(
							makeDaemonConfigFromOptions({ autoSettleAfterDays: null }),
						),
						makeProjectRegistryLive([
							{
								slug: "cold",
								title: "Cold",
								directory: "/missing",
								lastUsed: 1,
							},
						]),
						Layer.succeed(RelayCacheTag, {
							peek,
							get: () => Effect.fail(new Error("must skip")),
							invalidate: () => Effect.void,
						}),
						DaemonEventBusLive,
					),
				),
			);
			const scope = yield* Scope.make();
			yield* Layer.buildWithScope(layer, scope);
			yield* TestClock.adjust("1 minute");
			expect(peek).not.toHaveBeenCalled();
			yield* Scope.close(scope, Exit.void);
		}),
	);
});
