// ─── StorageMonitor Effect Layer ────────────────────────────────────────────
// Pure Effect replacement for the StorageMonitor class.
// Periodically checks storage usage and evicts old events when above high-water mark.
// Background fiber is fork-scoped — automatically interrupted on scope close.
//
// Defines its own Tag that will coexist with the one in services.ts until
// Phase 3 consumer migration.

import { Context, type Duration, Effect, Layer, Ref, Schedule } from "effect";

// ─── Config ─────────────────────────────────────────────────────────────────

export interface StorageMonitorConfig {
	getStorageUsage: () => Effect.Effect<number>;
	persistence: { evictOldEvents: () => Effect.Effect<void> };
	checkInterval: Duration.DurationInput;
	highWaterMark: number;
}

// ─── Service interface ──────────────────────────────────────────────────────

interface StorageMonitorService {
	getUsage: () => Effect.Effect<number>;
	getLastCheck: () => Effect.Effect<number>;
}

// ─── Tag ────────────────────────────────────────────────────────────────────

export class StorageMonitorTag extends Context.Tag("StorageMonitor")<
	StorageMonitorTag,
	StorageMonitorService
>() {}

// ─── Layer ──────────────────────────────────────────────────────────────────

export const StorageMonitorLive = (config: StorageMonitorConfig) =>
	Layer.scoped(
		StorageMonitorTag,
		Effect.gen(function* () {
			const state = yield* Ref.make({ lastCheck: 0, usage: 0 });

			const check = Effect.gen(function* () {
				const usage = yield* config.getStorageUsage();
				yield* Ref.set(state, { lastCheck: Date.now(), usage });
				if (usage > config.highWaterMark) {
					yield* config.persistence.evictOldEvents();
				}
			});

			// Background fiber — retries on unexpected errors
			yield* check.pipe(
				Effect.repeat(Schedule.spaced(config.checkInterval)),
				Effect.retry(
					Schedule.exponential("5 seconds").pipe(
						Schedule.intersect(Schedule.recurs(3)),
					),
				),
				Effect.catchAll((e) =>
					Effect.logWarning("Storage monitor failed after retries", e),
				),
				Effect.forkScoped,
			);

			return {
				getUsage: () => Ref.get(state).pipe(Effect.map((s) => s.usage)),
				getLastCheck: () => Ref.get(state).pipe(Effect.map((s) => s.lastCheck)),
			};
		}),
	);
