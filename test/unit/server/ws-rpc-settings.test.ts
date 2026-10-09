// Failure modes: setters bypass runtime state, acknowledge an unfinished or
// failed save, a later snapshot erases settings, or getters read stale disk.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Ref } from "effect";
import {
	GetAutoSettleSetting,
	GetUsageLimitsSetting,
	SetAutoSettleSetting,
	SetUsageLimitsSetting,
} from "../../../src/lib/contracts/ws-rpc.js";
import {
	type DaemonConfig,
	defaultDaemonConfig,
	loadDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	ConfigPersistenceLive,
	ConfigSnapshotFromEffectStateLive,
	ConfigWriterTag,
} from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { makeInstanceManagerStateLive } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { settingsHandlers } from "../../../src/lib/server/ws-rpc/settings.js";

describe("settings RPC config persistence", () => {
	it.scoped("updates memory and flushes settings before returning", () =>
		Effect.gen(function* () {
			const configDir = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync("/tmp/rpc-settings-")),
				(directory) =>
					Effect.sync(() =>
						rmSync(directory, { recursive: true, force: true }),
					),
			);
			const writes: DaemonConfig[] = [];
			const state = Layer.mergeAll(
				DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
				makeProjectRegistryLive(),
				makeInstanceManagerStateLive(),
				Layer.succeed(ConfigTag, {
					httpServer: createServer(),
					projectDir: configDir,
					slug: "settings",
					configDir,
					persistenceDbPath: join(configDir, "events.db"),
					publishGlobalSetting: () => Effect.void,
				}),
				Layer.succeed(ConfigWriterTag, {
					write: (config) =>
						Effect.tryPromise(() => saveDaemonConfig(config, configDir)).pipe(
							Effect.tap(() => Effect.sync(() => writes.push(config))),
						),
				}),
			);
			const context = yield* Layer.build(
				ConfigPersistenceLive.pipe(
					Layer.provideMerge(
						ConfigSnapshotFromEffectStateLive.pipe(Layer.provideMerge(state)),
					),
				),
			);
			const configRef = Context.get(context, DaemonConfigRefTag);
			const usageLimits = {
				autoResume: true,
				autoSwitch: true,
				order: ["second", "first"],
			};
			yield* settingsHandlers
				.SetUsageLimitsSetting(new SetUsageLimitsSetting({ usageLimits }))
				.pipe(Effect.provide(context));
			expect((yield* Ref.get(configRef)).usageLimits).toEqual(usageLimits);
			expect(writes).toHaveLength(1);
			expect(loadDaemonConfig(configDir)?.usageLimits).toEqual(usageLimits);
			yield* settingsHandlers
				.SetAutoSettleSetting(
					new SetAutoSettleSetting({
						autoSettleAfterDays: null,
					}),
				)
				.pipe(Effect.provide(context));
			expect((yield* Ref.get(configRef)).autoSettleAfterDays).toBeNull();
			expect(writes).toHaveLength(2);
			expect(loadDaemonConfig(configDir)?.autoSettleAfterDays).toBeNull();

			const persistence = Context.get(context, ConfigPersistenceTag);
			yield* persistence.requestSave;
			yield* persistence.flush;
			expect(loadDaemonConfig(configDir)).toMatchObject({
				usageLimits,
				autoSettleAfterDays: null,
			});
			// A stale disk value must not change what runtime readers observe.
			yield* Effect.tryPromise(() =>
				saveDaemonConfig(defaultDaemonConfig(), configDir),
			);
			expect(
				yield* settingsHandlers
					.GetUsageLimitsSetting(new GetUsageLimitsSetting({}))
					.pipe(Effect.provide(context)),
			).toEqual({ usageLimits });
			expect(
				yield* settingsHandlers
					.GetAutoSettleSetting(new GetAutoSettleSetting({}))
					.pipe(Effect.provide(context)),
			).toEqual({ autoSettleAfterDays: null });
		}),
	);
});
