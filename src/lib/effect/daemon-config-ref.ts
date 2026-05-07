// ─── DaemonConfigRef ────────────────────────────────────────────────────────
// A single Ref<DaemonRuntimeConfig> replacing the 8 mutable `let` variables
// in daemon-main.ts (port, host, pinHash, tlsEnabled, keepAwake,
// keepAwakeCommand, keepAwakeArgs, shuttingDown) plus related runtime state.
//
// Pattern:
//   DaemonConfigRefTag → Ref.Ref<DaemonRuntimeConfig>
//   DaemonConfigRefLive(initial) → Layer providing the Tag

import { Context, Layer, Ref } from "effect";

// ─── Interface ──────────────────────────────────────────────────────────────

export interface DaemonRuntimeConfig {
	readonly port: number;
	readonly host: string;
	readonly pinHash: string | null;
	readonly tlsEnabled: boolean;
	readonly keepAwake: boolean;
	readonly keepAwakeCommand: string | undefined;
	readonly keepAwakeArgs: string[] | undefined;
	readonly shuttingDown: boolean;
	readonly dismissedPaths: ReadonlySet<string>;
	readonly startTime: number;
	readonly hostExplicit: boolean;
	readonly persistedSessionCounts: ReadonlyMap<string, number>;
}

// ─── Context Tag ────────────────────────────────────────────────────────────

export class DaemonConfigRefTag extends Context.Tag("DaemonConfigRef")<
	DaemonConfigRefTag,
	Ref.Ref<DaemonRuntimeConfig>
>() {}

// ─── Layer factory ──────────────────────────────────────────────────────────

export const DaemonConfigRefLive = (initial: DaemonRuntimeConfig) =>
	Layer.effect(DaemonConfigRefTag, Ref.make(initial));

// ─── Convenience builder ────────────────────────────────────────────────────

/** Build initial config from DaemonOptions + disk state. */
export const makeDaemonConfigFromOptions = (options: {
	port?: number;
	host?: string;
	pinHash?: string;
	tlsEnabled?: boolean;
	keepAwake?: boolean;
	keepAwakeCommand?: string;
	keepAwakeArgs?: string[];
	dismissedPaths?: string[];
	startTime?: number;
	persistedSessionCounts?: ReadonlyMap<string, number>;
}): DaemonRuntimeConfig => ({
	port: options.port ?? 2633,
	host: options.host ?? "127.0.0.1",
	pinHash: options.pinHash ?? null,
	tlsEnabled: options.tlsEnabled ?? false,
	keepAwake: options.keepAwake ?? false,
	keepAwakeCommand: options.keepAwakeCommand,
	keepAwakeArgs: options.keepAwakeArgs,
	shuttingDown: false,
	dismissedPaths: new Set(options.dismissedPaths ?? []),
	startTime: options.startTime ?? Date.now(),
	hostExplicit: options.host !== undefined,
	persistedSessionCounts: new Map(options.persistedSessionCounts ?? []),
});
