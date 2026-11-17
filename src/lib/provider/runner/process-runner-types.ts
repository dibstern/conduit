import type { Effect, Option } from "effect";
import type { ProcessTable } from "./process-table.js";
import type { connectRunner } from "./runner-connection.js";
import type {
	RunnerDriverPieces,
	RunnerProviderInstanceDeps,
} from "./runner-provider-instance.js";
import type { RunnerProcessTable } from "./runner-registry.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionTurn,
} from "./session-runner.js";

/** The types the runner modules share, so none imports another's implementation for them. */

export interface ProcessRunnerDeps {
	readonly accountResources?: RunnerProviderInstanceDeps["accountResources"];
	readonly accounts?: Effect.Effect<
		import("../../account-directory.js").AccountsState
	>;
	readonly daemonConfigDir?: string;
	readonly processTable?: RunnerProcessTable;
	readonly processIdentity?: ProcessTable;
	readonly autoSettleAfterDays?: Effect.Effect<number | null | undefined>;
	readonly subagentPollTimeoutMs?: number;
	readonly sessionForkSdk?: import("../claude/claude-provider-runtime.js").ClaudeSessionRunnerDeps["sessionForkSdk"];
	readonly claudeSettingsOverrides?: import("../claude/claude-provider-runtime.js").ClaudeSessionRunnerDeps["claudeSettingsOverrides"];
	readonly projectRootForSession: NonNullable<
		RunnerProviderInstanceDeps["projectRootForSession"]
	>;
	readonly recoveryForSession?: RunnerProviderInstanceDeps["recoveryForSession"];
}

export interface ProcessRunnerDriver {
	readonly spawnEnvironment?: Readonly<Record<string, string>>;
	readonly driverKind: string;
	readonly legacyPrepareTurnEffect?: RunnerDriverPieces["prepareTurnEffect"];
	/** The account owner retains this demand until the native sink is released. */
	readonly withAccountScope?: (
		accountId: string,
		work: Effect.Effect<void>,
	) => Effect.Effect<void, SessionFailure>;
	/** The payload resumes durable state on demand and needs no warm SDK query. */
	readonly coldUpgrade?: true;
	readonly connect: typeof connectRunner;
	readonly settingsDeferredCode: string;
	readonly warmCommand: (
		sessionId: string,
		state: import("./runner-upgrade.js").RunnerUpgradeState,
		snapshot: import("./runner-upgrade.js").RunnerSettingsSnapshot,
	) => Extract<SessionCommand, { type: "pre-warm" }>;
	readonly snapshotCommandSettings: (
		snapshot: import("./runner-upgrade.js").RunnerSettingsSnapshot | undefined,
	) => Omit<
		Extract<SessionCommand, { type: "send-turn" }>,
		"type" | "sinkId" | "aborted" | "input"
	>;
	readonly loginChange: (
		a: {
			readonly configDir: import("./session-runner.js").SessionTurn["configDir"];
			readonly root: string;
			readonly account?: SessionTurn["account"];
			readonly instanceId?: string;
			readonly shellConfig?: SessionTurn["shellConfig"];
		},
		b: {
			readonly configDir: import("./session-runner.js").SessionTurn["configDir"];
			readonly root: string;
			readonly account?: SessionTurn["account"];
			readonly instanceId?: string;
			readonly shellConfig?: SessionTurn["shellConfig"];
		},
	) => "None" | "Settings" | "Account";
}

export interface OwnerSend {
	readonly sessionId: string;
	readonly runId: string;
	readonly commandId: string;
	readonly nativeResumeFallback?: boolean;
	readonly requestSequence?: number;
	readonly attempt?: number;
}

export type Hold =
	| {
			readonly _tag: "Held";
			readonly runner: string;
			readonly transmission: number;
	  }
	| { readonly _tag: "Cleaning"; readonly runner: string }
	| {
			readonly _tag: "Unserved";
			readonly predecessor: Option.Option<{
				readonly runner: string;
				readonly until: number;
			}>;
	  }
	| { readonly _tag: "Busy" }
	| { readonly _tag: "Covered" }
	| { readonly _tag: "Exhausted" }
	| { readonly _tag: "Ended" };
export type Held = Extract<Hold, { _tag: "Held" }>;

export interface RunRelease {
	readonly sessionId: string;
	readonly runId: string;
	readonly runnerId: string;
	readonly commandId: string;
	readonly transmission: number;
	readonly reason: "Refused" | "NotSent" | "JournalAbsent" | "ResumeRejected";
	readonly refusalReason?: "exiting" | "retiring" | "interrupted";
}

/** The feeder's write permission, as Dispatch consumes it, so Dispatch never imports the feeder. */
export interface WritePermission {
	/**
	 * The write's take, in the write's synchronous step (4.4): the hold is
	 * current, coverage has not taken the permission and the runner's stop is
	 * Running. Records the frame written with its connection's refusal reader.
	 */
	readonly write: (refusal: () => RunRelease["refusalReason"]) => boolean;
	/** Coverage's take before the first byte (4.5 NotSent). */
	readonly consume: () => boolean;
	/** Waits while the gate is closed: true to try the write again, false once it never writes. */
	readonly reopened: Effect.Effect<boolean>;
}
