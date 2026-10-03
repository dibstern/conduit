import {
	DEFAULT_AUTO_SETTLE_AFTER_DAYS,
	loadDaemonConfig,
} from "../../daemon/config-persistence.js";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import type { ClaudeSessionOutput } from "./claude-session-runner.js";

/** Reuse the daemon's inactivity setting without adding a runner-specific knob. */
export function makeClaudeRunnerIdleExit(
	onIdle: () => void,
	testIdleWindowMs?: number | null,
	dayMs = 86_400_000,
	configDir = DEFAULT_CONFIG_DIR,
	hasHeldWork?: () => boolean,
) {
	let lastActivityAt = Date.now();
	let turns = 0;
	let backgroundWork = false;
	const timer = setInterval(
		() => {
			if (turns > 0 || backgroundWork || hasHeldWork?.()) return;
			// Resolve configuration on the background sweep, never on send or output.
			const days = loadDaemonConfig(configDir)?.autoSettleAfterDays;
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
			return turns === 0 && !backgroundWork && !hasHeldWork?.();
		},
		beginTurn() {
			turns++;
			lastActivityAt = Date.now();
		},
		endTurn() {
			turns--;
			lastActivityAt = Date.now();
		},
		activity(output?: ClaudeSessionOutput) {
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
