// A single Ref<DaemonRuntimeConfig> replacing the 8 mutable `let` variables
// in daemon-main.ts (port, host, pinHash, tlsEnabled, keepAwake,
// keepAwakeCommand, keepAwakeArgs, shuttingDown) plus related runtime state.
//
// Pattern:
//   DaemonConfigRefTag → Ref.Ref<DaemonRuntimeConfig>
//   DaemonConfigRefLive(initial) → Layer providing the Tag

import { Context, Effect, Layer, Ref } from "effect";
import type { UsageLimitsSetting } from "../../../contracts/limit-recovery.js";
import { DEFAULT_AUTO_SETTLE_AFTER_DAYS } from "../../../daemon/config-persistence.js";
import type { DaemonStatus } from "../../../daemon/daemon-types.js";

export interface DaemonRuntimeConfig {
	readonly port: number;
	readonly host: string;
	readonly pinHash: string | null;
	readonly tlsEnabled: boolean;
	readonly tailscaleServeEnabled?: boolean;
	readonly tailscaleServeCleanupPending?: boolean;
	readonly tailscaleServe?: DaemonStatus["tailscaleServe"];
	readonly keepAwake: boolean;
	readonly autoSettleAfterDays?: number | null;
	readonly usageLimits?: UsageLimitsSetting;
	readonly keepAwakeCommand: string | undefined;
	readonly keepAwakeArgs: string[] | undefined;
	readonly claudeConfigDir: string | undefined;
	readonly newSessionProject?: string;
	readonly shuttingDown: boolean;
	readonly startTime: number;
	readonly hostExplicit: boolean;
	readonly persistedSessionCounts: ReadonlyMap<string, number>;
}

export class DaemonConfigRefTag extends Context.Tag("DaemonConfigRef")<
	DaemonConfigRefTag,
	Ref.Ref<DaemonRuntimeConfig>
>() {}

export interface DaemonConfigMirror {
	readonly set: (config: DaemonRuntimeConfig) => Effect.Effect<void>;
}

export class DaemonConfigMirrorTag extends Context.Tag("DaemonConfigMirror")<
	DaemonConfigMirrorTag,
	DaemonConfigMirror
>() {}

export const DaemonConfigMirrorLive = (mirror: DaemonConfigMirror) =>
	Layer.succeed(DaemonConfigMirrorTag, mirror);

export const DaemonConfigRefLive = (initial: DaemonRuntimeConfig) =>
	Layer.effect(DaemonConfigRefTag, Ref.make(initial));

export const commitDaemonRuntimeConfig = (
	update: (config: DaemonRuntimeConfig) => DaemonRuntimeConfig,
) =>
	Effect.gen(function* () {
		const ref = yield* DaemonConfigRefTag;
		const next = yield* Ref.updateAndGet(ref, update);
		// DaemonLive omits the legacy config mirror when no mirror is configured.
		const mirror = yield* Effect.serviceOption(DaemonConfigMirrorTag);
		if (mirror._tag === "Some") {
			yield* mirror.value.set(next);
		}
		return next;
	});

/** Build initial config from DaemonOptions + disk state. */
export const makeDaemonConfigFromOptions = (options: {
	port?: number;
	host?: string;
	hostExplicit?: boolean;
	pinHash?: string;
	tlsEnabled?: boolean;
	tailscaleServeEnabled?: boolean;
	tailscaleServeCleanupPending?: boolean;
	keepAwake?: boolean;
	autoSettleAfterDays?: number | null;
	usageLimits?: UsageLimitsSetting;
	keepAwakeCommand?: string;
	keepAwakeArgs?: string[];
	claudeConfigDir?: string;
	newSessionProject?: string;
	startTime?: number;
	persistedSessionCounts?: ReadonlyMap<string, number>;
}): DaemonRuntimeConfig => ({
	port: options.port ?? 2633,
	host: options.host ?? "127.0.0.1",
	pinHash: options.pinHash ?? null,
	tlsEnabled: options.tailscaleServeEnabled
		? false
		: (options.tlsEnabled ?? false),
	tailscaleServeEnabled: options.tailscaleServeEnabled ?? false,
	tailscaleServeCleanupPending: options.tailscaleServeCleanupPending ?? false,
	keepAwake: options.keepAwake ?? false,
	autoSettleAfterDays:
		options.autoSettleAfterDays === undefined
			? DEFAULT_AUTO_SETTLE_AFTER_DAYS
			: options.autoSettleAfterDays,
	...(options.usageLimits !== undefined && {
		usageLimits: options.usageLimits,
	}),
	keepAwakeCommand: options.keepAwakeCommand,
	keepAwakeArgs: options.keepAwakeArgs,
	claudeConfigDir: options.claudeConfigDir,
	...(options.newSessionProject !== undefined && {
		newSessionProject: options.newSessionProject,
	}),
	shuttingDown: false,
	startTime: options.startTime ?? Date.now(),
	hostExplicit: options.hostExplicit ?? false,
	persistedSessionCounts: new Map(options.persistedSessionCounts ?? []),
});
