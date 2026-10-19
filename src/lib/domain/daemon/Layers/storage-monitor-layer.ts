import { Context, type Duration, Effect, Layer, Ref, Schedule } from "effect";

export interface StorageMonitorConfig {
	getStorageUsage: () => Effect.Effect<number>;
	persistence: { evictOldEvents: () => Effect.Effect<void> };
	checkInterval: Duration.Input;
	highWaterMark: number;
}

interface StorageMonitorService {
	getUsage: () => Effect.Effect<number>;
	getLastCheck: () => Effect.Effect<number>;
}

export class StorageMonitorTag extends Context.Service<
	StorageMonitorTag,
	StorageMonitorService
>()("StorageMonitor") {}

export const StorageMonitorLive = (config: StorageMonitorConfig) =>
	Layer.effect(
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
					Schedule.max([Schedule.exponential("5 seconds"), Schedule.recurs(3)]),
				),
				Effect.catch((e) =>
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
