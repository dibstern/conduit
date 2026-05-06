// ─── ConfigPersistenceLive ──────────────────────────────────────────────────
// Subscribes to DaemonEventBus for ConfigChanged events and writes config
// to disk using a debounced fiber. Replaces the imperative persistConfig()
// / flushConfigSave() closures in daemon-main.ts.
//
// The ConfigWriterTag service exists for dependency injection — production
// code provides a real disk writer, tests provide a mock.

import { Context, Duration, Effect, Layer, PubSub, Ref, Stream } from "effect";
import {
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "./daemon-config-ref.js";
import { DaemonEventBusTag } from "./daemon-pubsub.js";

// ─── ConfigWriter service ──────────────────────────────────────────────────

export interface ConfigWriter {
	readonly write: (config: DaemonRuntimeConfig) => Effect.Effect<void>;
}

export class ConfigWriterTag extends Context.Tag("ConfigWriter")<
	ConfigWriterTag,
	ConfigWriter
>() {}

// ─── Layer ─────────────────────────────────────────────────────────────────

export const ConfigPersistenceLive = Layer.scopedDiscard(
	Effect.gen(function* () {
		const bus = yield* DaemonEventBusTag;
		const configRef = yield* DaemonConfigRefTag;
		const writer = yield* ConfigWriterTag;
		const sub = yield* PubSub.subscribe(bus);

		yield* Effect.forkScoped(
			Stream.fromQueue(sub).pipe(
				Stream.filter((e) => e._tag === "ConfigChanged"),
				Stream.debounce(Duration.millis(500)),
				Stream.runForEach(() =>
					Effect.gen(function* () {
						const config = yield* Ref.get(configRef);
						yield* writer.write(config);
					}).pipe(
						Effect.catchAll((e) =>
							Effect.logWarning("Config persistence failed").pipe(
								Effect.annotateLogs("error", String(e)),
							),
						),
					),
				),
			),
		);
	}),
);
