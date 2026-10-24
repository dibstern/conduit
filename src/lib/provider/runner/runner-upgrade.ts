import { Effect } from "effect";
import * as Failure from "../../effect/failure-classification.js";
import type {
	RunnerLiveQueryConfiguration,
	RunnerSettingsSnapshot,
} from "../claude/claude-runner-snapshot.js";
import type { SessionFailure } from "./session-runner.js";

export type {
	RunnerLiveQueryConfiguration,
	RunnerSettingsSnapshot,
} from "../claude/claude-runner-snapshot.js";

export interface RunnerUpgradeState {
	readonly quiescent: boolean;
	/** Native turn activity, excluding background work. Older runners omit it. */
	readonly turnInFlight?: boolean;
	readonly revision: number;
	readonly snapshot?: RunnerSettingsSnapshot;
	readonly resumeSessionId?: string;
	readonly liveConfiguration?: RunnerLiveQueryConfiguration;
	readonly frozen?: boolean;
}

export interface RunnerUpgrade {
	state?: RunnerUpgradeState | undefined;
	activity: number;
	inFlight: boolean;
	failures: number;
	retryAt: number;
	attemptActivity?: number;
	boundaryWaiting?: boolean;
	/** Changed settings rule out a warm switch, so only a restart upgrades. */
	settingsDeferred?: boolean;
}

/** Warming is independent of admission. A send invalidates only the attempt. */
export function makeRunnerUpgrade<
	T extends { upgrade: RunnerUpgrade },
>(options: {
	readonly eligible: (sessionId: string, runner: T) => boolean;
	readonly create: (
		sessionId: string,
		runner: T,
	) => Effect.Effect<T, SessionFailure>;
	readonly warm: (
		sessionId: string,
		runner: T,
		replacement: T,
	) => Effect.Effect<void, SessionFailure>;
	readonly commit: (
		sessionId: string,
		runner: T,
		replacement: T,
		activity: number,
	) => Effect.Effect<boolean, SessionFailure>;
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
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						if (Failure.isInterruptedOnly(cause)) return;
						runner.upgrade.failures++;
						runner.upgrade.retryAt =
							Date.now() +
							Math.min(
								2000,
								100 * 2 ** Math.min(runner.upgrade.failures - 1, 5),
							);
						options.failed(sessionId, runner, Failure.squashCause(cause));
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
