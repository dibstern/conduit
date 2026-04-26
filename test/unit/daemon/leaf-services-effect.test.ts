// ─── Leaf Service Effect Layers ─────────────────────────────────────────────
// Tests for Effect-native layer replacements of daemon leaf services.

import { describe, it } from "@effect/vitest";
import {
	Context,
	Duration,
	Effect,
	Exit,
	Layer,
	Scope,
	TestClock,
} from "effect";
import { expect, vi } from "vitest";
import {
	StorageMonitorLive,
	StorageMonitorTag,
} from "../../../src/lib/effect/storage-monitor-layer.js";

/** Helper: build the layer, run the body, then close the scope. */
const withMonitor = (
	config: {
		getStorageUsage: () => Effect.Effect<number>;
		persistence: { evictOldEvents: () => Effect.Effect<void> };
		checkInterval: Duration.DurationInput;
		highWaterMark: number;
	},
	body: (
		svc: Context.Tag.Service<typeof StorageMonitorTag>,
	) => Effect.Effect<void>,
) =>
	Effect.gen(function* () {
		const layer = StorageMonitorLive(config);
		const scope = yield* Scope.make();
		const ctx = yield* Layer.buildWithScope(layer, scope);
		const svc = Context.get(ctx, StorageMonitorTag);

		// Advance TestClock past zero so the forked fiber's initial check runs
		yield* TestClock.adjust(Duration.millis(1));

		yield* body(svc);
		yield* Scope.close(scope, Exit.void);
	});

describe("Leaf service Layers", () => {
	describe("StorageMonitor", () => {
		it.scoped("Layer constructs and provides tag", () =>
			Effect.gen(function* () {
				const layer = StorageMonitorLive({
					getStorageUsage: vi.fn().mockReturnValue(Effect.succeed(0.5)),
					persistence: {
						evictOldEvents: vi.fn().mockReturnValue(Effect.succeed(undefined)),
					},
					checkInterval: Duration.seconds(60),
					highWaterMark: 0.9,
				});

				const scope = yield* Scope.make();
				const ctx = yield* Layer.buildWithScope(layer, scope);
				const svc = Context.get(ctx, StorageMonitorTag);
				const usage = yield* svc.getUsage();
				expect(typeof usage).toBe("number");
				yield* Scope.close(scope, Exit.void);
			}),
		);

		it.scoped("background check records usage from getStorageUsage", () =>
			withMonitor(
				{
					getStorageUsage: vi.fn().mockReturnValue(Effect.succeed(0.42)),
					persistence: {
						evictOldEvents: vi.fn().mockReturnValue(Effect.succeed(undefined)),
					},
					checkInterval: Duration.seconds(60),
					highWaterMark: 0.9,
				},
				(svc) =>
					Effect.gen(function* () {
						const usage = yield* svc.getUsage();
						expect(usage).toBe(0.42);
						const lastCheck = yield* svc.getLastCheck();
						expect(lastCheck).toBeGreaterThan(0);
					}),
			),
		);

		it.scoped("evicts when usage exceeds high-water mark", () => {
			const evictOldEvents = vi.fn().mockReturnValue(Effect.succeed(undefined));
			return withMonitor(
				{
					getStorageUsage: vi.fn().mockReturnValue(Effect.succeed(0.95)),
					persistence: { evictOldEvents },
					checkInterval: Duration.seconds(60),
					highWaterMark: 0.9,
				},
				() =>
					Effect.sync(() => {
						expect(evictOldEvents).toHaveBeenCalled();
					}),
			);
		});

		it.scoped("does not evict when usage is below high-water mark", () => {
			const evictOldEvents = vi.fn().mockReturnValue(Effect.succeed(undefined));
			return withMonitor(
				{
					getStorageUsage: vi.fn().mockReturnValue(Effect.succeed(0.5)),
					persistence: { evictOldEvents },
					checkInterval: Duration.seconds(60),
					highWaterMark: 0.9,
				},
				() =>
					Effect.sync(() => {
						expect(evictOldEvents).not.toHaveBeenCalled();
					}),
			);
		});

		it.scoped("scope close interrupts background fiber cleanly", () =>
			Effect.gen(function* () {
				const layer = StorageMonitorLive({
					getStorageUsage: vi.fn().mockReturnValue(Effect.succeed(0.5)),
					persistence: {
						evictOldEvents: vi.fn().mockReturnValue(Effect.succeed(undefined)),
					},
					checkInterval: Duration.millis(50),
					highWaterMark: 0.9,
				});

				const scope = yield* Scope.make();
				yield* Layer.buildWithScope(layer, scope);
				const exit = yield* Effect.exit(Scope.close(scope, Exit.void));
				expect(Exit.isSuccess(exit)).toBe(true);
			}),
		);
	});
});
