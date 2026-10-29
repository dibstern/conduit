import { Clock, Duration, Effect, Schedule } from "effect";
import * as Failure from "../../effect/failure-classification.js";
import type {
	RunnerLiveQueryConfiguration,
	RunnerSettingsSnapshot,
} from "../claude/claude-runner-snapshot.js";
import { runnerRetrySchedule } from "./runner-retry.js";
import type { SessionFailure } from "./session-runner.js";

export type {
	RunnerLiveQueryConfiguration,
	RunnerSettingsSnapshot,
} from "../claude/claude-runner-snapshot.js";

/** The owned terminal delivery is unwinding; this grants no switch permission. */
export interface RunnerSourceDelivery {
	readonly sessionId: string;
	readonly runnerId: string;
	readonly commandId: string;
	readonly sinkId: string;
	readonly inputId: string;
	readonly runId: string;
	readonly generation: number;
}

export interface RunnerUpgradeState {
	readonly quiescent: boolean;
	/** Native turn activity, excluding background work. Older runners omit it. */
	readonly turnInFlight?: boolean;
	readonly revision: number;
	readonly sourceDelivery?: RunnerSourceDelivery;
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
	const newBackoff = Schedule.toStep(runnerRetrySchedule);
	const backoffs = new WeakMap<T, Effect.Success<typeof newBackoff>>();
	const consider = (sessionId: string, runner: T): void => {
		if (!options.eligible(sessionId, runner)) return;
		if (runner.upgrade.inFlight) {
			// Eligibility can return without a new admission.
			runner.upgrade.boundaryWaiting = true;
			return;
		}
		runner.upgrade.inFlight = true;
		const activity = runner.upgrade.activity;
		let replacement: T | undefined;
		let committed = false;
		let interrupted = false;
		const failed = (cause: unknown) =>
			Effect.gen(function* () {
				let backoff = backoffs.get(runner);
				if (!backoff) {
					backoff = yield* newBackoff;
					backoffs.set(runner, backoff);
				}
				// The deadline and its sleep share the Effect clock: a wall-clock
				// deadline under a test or slowed clock fires early or never.
				const now = yield* Clock.currentTimeMillis;
				const [, delay] = yield* backoff(now, undefined).pipe(Effect.orDie);
				runner.upgrade.failures++;
				runner.upgrade.retryAt = now + Duration.toMillis(delay);
				options.failed(sessionId, runner, cause);
			});
		options.runFork(
			Effect.gen(function* () {
				// Only a turn boundary schedules a retry. Backoff never holds a send.
				yield* Effect.sleep(
					Math.max(
						0,
						runner.upgrade.retryAt - (yield* Clock.currentTimeMillis),
					),
				);
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
				if (!committed) {
					options.cancelled(sessionId, runner, replacement);
					yield* failed("Swap commit was refused");
				}
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.gen(function* () {
						if (Failure.isInterruptedOnly(cause)) {
							interrupted = true;
							return;
						}
						yield* failed(Failure.squashCause(cause));
					}),
				),
				Effect.ensuring(
					Effect.suspend(() =>
						replacement && !committed && !interrupted
							? options.stop(replacement)
							: Effect.void,
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
