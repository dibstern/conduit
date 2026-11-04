import { Option, Schema } from "effect";
import { TasksSnapshotPayloadSchema } from "../../contracts/stored-event.js";
import {
	DEFAULT_AUTO_SETTLE_AFTER_DAYS,
	loadDaemonConfigResult,
} from "../../daemon/config-persistence.js";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { ledgerTask, type Task } from "../run-ledger/run-ledger-model.js";
import type { SessionOutput } from "./session-runner.js";

/** Reuse the daemon's inactivity setting without adding a runner-specific knob. */
export function makeRunnerIdleExit(
	onIdle: () => void,
	testIdleWindowMs?: number | null,
	dayMs = 86_400_000,
	autoSettleAfterDays?: number | null,
	hasHeldWork?: (ignoredTurns?: number) => boolean,
	configDir = DEFAULT_CONFIG_DIR,
) {
	let lastActivityAt = Date.now();
	let turns = 0;
	let sdkTurnInFlight = false;
	// 8.3 (CONTRACT.md 2812-2814): the host's task certainty through the ledger's reducer. A fresh
	// launch has none; a replaced query's tasks are unknown until its first snapshot.
	let tasks:
		| { readonly tag: "Unknown" }
		| { readonly tag: "Known"; readonly tasks: readonly Task[] } = {
		tag: "Known",
		tasks: [],
	};
	// Unknown tasks may still act; monitoring (ambient or a monitor) is not activity.
	const backgroundWork = () =>
		tasks.tag === "Unknown" ||
		tasks.tasks.some((task) => task.class === "work");
	const isQuiescent = (ignoredTurns = 0) =>
		turns <= ignoredTurns &&
		!sdkTurnInFlight &&
		!backgroundWork() &&
		!hasHeldWork?.(ignoredTurns);
	const timer = setInterval(
		() => {
			if (turns > 0 || sdkTurnInFlight || backgroundWork() || hasHeldWork?.())
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
			return isQuiescent();
		},
		isQuiescent,
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
			const snapshot =
				output?.type === "event" &&
				output.event.type === "evidence.tasks_snapshot"
					? Schema.decodeUnknownOption(TasksSnapshotPayloadSchema)(
							output.event.data,
						)
					: Option.none();
			if (Option.isSome(snapshot)) {
				const held = backgroundWork();
				tasks = { tag: "Known", tasks: snapshot.value.tasks.map(ledgerTask) };
				// A list without work after one without work is not activity.
				if (!held && !backgroundWork()) return;
			}
			lastActivityAt = Date.now();
		},
		queryReplaced() {
			tasks = { tag: "Unknown" };
		},
		close() {
			clearInterval(timer);
		},
	};
}
