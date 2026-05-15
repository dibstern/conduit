import { Context, Effect, Layer } from "effect";
import type { DaemonConfig } from "../../../daemon/config-persistence.js";

export interface ConfigSnapshot {
	readonly build: Effect.Effect<DaemonConfig, unknown>;
}

export class ConfigSnapshotTag extends Context.Tag("ConfigSnapshot")<
	ConfigSnapshotTag,
	ConfigSnapshot
>() {}

export interface ConfigPersistence {
	readonly requestSave: Effect.Effect<void>;
	readonly flush: Effect.Effect<void, unknown>;
}

export class ConfigPersistenceTag extends Context.Tag("ConfigPersistence")<
	ConfigPersistenceTag,
	ConfigPersistence
>() {}

export const requestConfigSave = ConfigPersistenceTag.pipe(
	Effect.flatMap((persistence) => persistence.requestSave),
);

export const ConfigPersistenceNoopLive = Layer.succeed(ConfigPersistenceTag, {
	requestSave: Effect.void,
	flush: Effect.void,
});
