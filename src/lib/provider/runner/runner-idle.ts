import {
	DEFAULT_AUTO_SETTLE_AFTER_DAYS,
	loadDaemonConfigResult,
} from "../../daemon/config-persistence.js";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import type { SessionOutput } from "./session-runner.js";

/** Reuse the daemon's inactivity setting without adding a runner-specific knob. */
export function makeRunnerIdleExit(
	onIdle: () => void,
	testIdleWindowMs?: number | null,
	dayMs = 86_400_000,
	autoSettleAfterDays?: number | null,
	hasHeldWork?: () => boolean,
	configDir = DEFAULT_CONFIG_DIR,
) {
	let lastActivityAt = Date.now();
	let turns = 0;
	let sdkTurnInFlight = false;
	let backgroundWork = false;
	const timer = setInterval(
		() => {
			if (turns > 0 || sdkTurnInFlight || backgroundWork || hasHeldWork?.())
				return;
			let days = autoSettleAfterDays;
			// Only an older daemon can launch us without a snapshot. Keep that
			// peer's disk-based sweep until it supplies one, rather than guessing.
			if (days === undefined && testIdleWindowMs === undefined) {
				const loaded = loadDaemonConfigResult(configDir);
				if (loaded._tag === "Failure" && loaded.failure._tag !== "NotFound") {
					console.error(loaded.failure.message);
					return;
				}
				days =
					loaded._tag === "Success"
						? loaded.success.autoSettleAfterDays
						: undefined;
			}
			const idleWindowMs =
				testIdleWindowMs !== undefined
					? testIdleWindowMs
					: days === null
						? null
						: (days ?? DEFAULT_AUTO_SETTLE_AFTER_DAYS) * dayMs;
			if (
				idleWindowMs !== null &&
				Date.now() - lastActivityAt >= idleWindowMs
			) {
				clearInterval(timer);
				onIdle();
			}
		},
		Math.min(60_000, Math.max(1, testIdleWindowMs ?? dayMs)),
	);
	return {
		get quiescent() {
			return (
				turns === 0 && !sdkTurnInFlight && !backgroundWork && !hasHeldWork?.()
			);
		},
		setTurnInFlight(inFlight: boolean) {
			sdkTurnInFlight = inFlight;
			lastActivityAt = Date.now();
		},
		beginTurn(days?: number | null) {
			// A rolled-back daemon omits this metadata; retain the last supplied snapshot.
			if (days !== undefined) autoSettleAfterDays = days;
			turns++;
			lastActivityAt = Date.now();
		},
		endTurn() {
			turns--;
			lastActivityAt = Date.now();
		},
		activity(output?: SessionOutput) {
			if (output?.type === "background-task") {
				const live =
					output.transition.kind === "snapshot" &&
					output.transition.tasks.length > 0;
				// Ambient-only SDK snapshots are not session activity.
				if (!backgroundWork && !live) return;
				backgroundWork = live;
			}
			lastActivityAt = Date.now();
		},
		close() {
			clearInterval(timer);
		},
	};
}
