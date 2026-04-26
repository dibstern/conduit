// ─── DaemonState Ref & Tag ───────────────────────────────────────────────────
// Replaces ~47 mutable fields on the Daemon class with a single atomic
// Ref<DaemonState>. All daemon subsystems read/write through this Ref,
// giving us fiber-safe atomic snapshots for free.
//
// Pattern:
//   DaemonStateTag → Ref.Ref<DaemonState>
//   makeDaemonStateLive(overrides?) → Layer providing the Tag

import { Context, Effect, Layer, Ref } from "effect";

import { DEFAULT_CONFIG_DIR, DEFAULT_PORT } from "../env.js";

// ─── Supporting interfaces ──────────────────────────────────────────────────

/** Project entry stored in daemon config. */
export interface DaemonProject {
	path: string;
	slug: string;
	title?: string;
	addedAt: number;
	instanceId?: string;
	/** Cached session count from last run — for instant CLI display. */
	sessionCount?: number;
}

/** OpenCode instance configuration. */
export interface DaemonInstanceConfig {
	id: string;
	name: string;
	port: number;
	managed: boolean;
	env?: Record<string, string>;
	url?: string;
}

// ─── DaemonState ────────────────────────────────────────────────────────────

/**
 * Observable + persisted subset of the Daemon class fields.
 *
 * Persisted fields come from DaemonConfig (config-persistence.ts).
 * Runtime-observable fields track transient daemon state.
 * Internal coordination fields manage save coalescing.
 */
export interface DaemonState {
	// ── Persisted fields (mirror DaemonConfig) ──
	pid: number;
	port: number;
	host: string;
	pinHash: string | null;
	tls: boolean;
	tlsCertPath?: string;
	tlsKeyPath?: string;
	debug: boolean;
	keepAwake: boolean;
	keepAwakeCommand?: string;
	keepAwakeArgs?: string[];
	dangerouslySkipPermissions: boolean;
	projects: DaemonProject[];
	instances: DaemonInstanceConfig[];
	dismissedPaths: Set<string>;

	// ── Runtime-observable ──
	clientCount: number;
	shuttingDown: boolean;
	startTime: number;
	configDir: string;
	socketPath: string;
	logPath: string;
	pidPath: string;
	staticDir?: string;

	// ── Internal coordination ──
	pendingSave: boolean;
	needsResave: boolean;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/** Sensible defaults for a fresh daemon with no config. */
export function emptyDaemonState(): DaemonState {
	const configDir = DEFAULT_CONFIG_DIR;
	return {
		// Persisted
		pid: process.pid,
		port: DEFAULT_PORT,
		host: "127.0.0.1",
		pinHash: null,
		tls: false,
		debug: false,
		keepAwake: false,
		dangerouslySkipPermissions: false,
		projects: [],
		instances: [],
		dismissedPaths: new Set<string>(),

		// Runtime-observable
		clientCount: 0,
		shuttingDown: false,
		startTime: Date.now(),
		configDir,
		socketPath: `${configDir}/relay.sock`,
		logPath: `${configDir}/daemon.log`,
		pidPath: `${configDir}/daemon.pid`,

		// Internal coordination
		pendingSave: false,
		needsResave: false,
	};
}

// ─── Context Tag ────────────────────────────────────────────────────────────

/** Tag for the mutable DaemonState Ref in the Effect Context. */
export class DaemonStateTag extends Context.Tag("DaemonState")<
	DaemonStateTag,
	Ref.Ref<DaemonState>
>() {}

// ─── Layer factory ──────────────────────────────────────────────────────────

/**
 * Create a Layer providing DaemonStateTag backed by a Ref.
 *
 * @param overrides - Partial overrides merged on top of `emptyDaemonState()`.
 *   Pass nothing for sensible defaults; pass fields to seed from config.
 */
export const makeDaemonStateLive = (
	overrides?: Partial<DaemonState>,
): Layer.Layer<DaemonStateTag> =>
	Layer.effect(
		DaemonStateTag,
		Effect.gen(function* () {
			const initial: DaemonState = {
				...emptyDaemonState(),
				...overrides,
			};
			return yield* Ref.make(initial);
		}),
	);
