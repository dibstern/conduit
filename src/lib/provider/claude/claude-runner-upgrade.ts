import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import { Cause, Effect } from "effect";
import type { PreWarmSessionInput } from "../types.js";
import type { ClaudeRunnerFileSettings } from "./claude-runner-settings.js";
import type { ClaudeSessionFailure } from "./claude-session-runner.js";
import type { Options } from "./types.js";

/** Session launch data stays in memory, including across runner replacement. */
export interface ClaudeRunnerSettingsSnapshot {
	readonly input: PreWarmSessionInput;
	readonly claudeSettingsOverrides?: Settings;
	readonly options: Omit<Options, "abortController" | "canUseTool" | "resume">;
	readonly fileSettings?: ClaudeRunnerFileSettings;
}

/** Mutable SDK controls travel separately from the session's launch snapshot. */
export type ClaudeRunnerLiveQueryConfiguration = Pick<
	PreWarmSessionInput,
	"model" | "contextWindow" | "variant" | "permissionMode"
>;

export interface ClaudeRunnerUpgradeState {
	readonly quiescent: boolean;
	readonly revision: number;
	readonly snapshot?: ClaudeRunnerSettingsSnapshot;
	readonly resumeSessionId?: string;
	readonly liveConfiguration?: ClaudeRunnerLiveQueryConfiguration;
	readonly frozen?: boolean;
}

export interface ClaudeRunnerUpgrade {
	state?: ClaudeRunnerUpgradeState | undefined;
	activity: number;
	inFlight: boolean;
	failures: number;
	retryAt: number;
	attemptActivity?: number;
	boundaryWaiting?: boolean;
}

/** Warming is independent of admission. A send invalidates only the attempt. */
export function makeClaudeRunnerUpgrade<
	T extends { upgrade: ClaudeRunnerUpgrade },
>(options: {
	readonly eligible: (sessionId: string, runner: T) => boolean;
	readonly create: (sessionId: string, runner: T) => Effect.Effect<T>;
	readonly warm: (
		sessionId: string,
		runner: T,
		replacement: T,
	) => Effect.Effect<void, ClaudeSessionFailure>;
	readonly commit: (
		sessionId: string,
		runner: T,
		replacement: T,
		activity: number,
	) => Effect.Effect<boolean, ClaudeSessionFailure>;
	readonly stop: (runner: T) => Effect.Effect<void>;
	readonly runFork: (effect: Effect.Effect<void>) => unknown;
	readonly failed: (sessionId: string, runner: T, cause: unknown) => void;
	readonly cancelled: (sessionId: string, runner: T, replacement: T) => void;
}) {
	const consider = (sessionId: string, runner: T): void => {
		if (!options.eligible(sessionId, runner)) return;
		if (runner.upgrade.inFlight) {
			if (runner.upgrade.activity !== runner.upgrade.attemptActivity)
				runner.upgrade.boundaryWaiting = true;
			return;
		}
		runner.upgrade.inFlight = true;
		const activity = runner.upgrade.activity;
		runner.upgrade.attemptActivity = activity;
		let replacement: T | undefined;
		let committed = false;
		options.runFork(
			Effect.gen(function* () {
				// Only a turn boundary schedules a retry. Backoff never holds a send.
				yield* Effect.sleep(Math.max(0, runner.upgrade.retryAt - Date.now()));
				if (
					activity !== runner.upgrade.activity ||
					!options.eligible(sessionId, runner)
				)
					return;
				replacement = yield* options.create(sessionId, runner);
				yield* options.warm(sessionId, runner, replacement);
				committed = yield* options.commit(
					sessionId,
					runner,
					replacement,
					activity,
				);
				if (!committed) options.cancelled(sessionId, runner, replacement);
			}).pipe(
				Effect.catchAllCause((cause) =>
					Effect.sync(() => {
						if (Cause.isInterruptedOnly(cause)) return;
						runner.upgrade.failures++;
						runner.upgrade.retryAt =
							Date.now() +
							Math.min(
								2000,
								100 * 2 ** Math.min(runner.upgrade.failures - 1, 5),
							);
						options.failed(sessionId, runner, Cause.squash(cause));
					}),
				),
				Effect.ensuring(
					Effect.suspend(() =>
						replacement && !committed ? options.stop(replacement) : Effect.void,
					),
				),
				Effect.ensuring(
					Effect.sync(() => {
						runner.upgrade.inFlight = false;
						if (runner.upgrade.boundaryWaiting) {
							runner.upgrade.boundaryWaiting = false;
							consider(sessionId, runner);
						}
					}),
				),
			),
		);
	};
	return consider;
}
