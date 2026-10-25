import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Effect, Layer } from "effect";

/**
 * Logs a rate-limited warning when the daemon's event loop stalls. Sampling is
 * native, so an idle daemon pays no JS wakeups beyond one check per interval.
 */
export const monitorEventLoopBlocks = ({
	checkMs = 1_000,
	thresholdMs = 250,
	warnEveryMs = 30_000,
} = {}) =>
	Effect.gen(function* () {
		const histogram = yield* Effect.acquireRelease(
			Effect.sync(() => {
				const histogram = monitorEventLoopDelay({ resolution: 50 });
				histogram.enable();
				return histogram;
			}),
			(histogram) => Effect.sync(() => histogram.disable()),
		);
		let lastWarningAt = Number.NEGATIVE_INFINITY;
		yield* Effect.gen(function* () {
			while (true) {
				const dueAt = performance.now() + checkMs;
				yield* Effect.sleep(checkMs);
				const now = performance.now();
				// The native sample for a stall can land after this check runs; this
				// check's own lateness always covers it.
				const maxMs = Math.max(histogram.max / 1_000_000, now - dueAt);
				const p99Ms = histogram.percentile(99) / 1_000_000;
				histogram.reset();
				if (maxMs < thresholdMs || now - lastWarningAt < warnEveryMs) continue;
				lastWarningAt = now;
				yield* Effect.logWarning("event loop blocked").pipe(
					Effect.annotateLogs({
						eventLoopDelayMaxMs: maxMs,
						eventLoopDelayP99Ms: p99Ms,
						thresholdMs,
					}),
				);
			}
		}).pipe(Effect.forkScoped);
	});

export const EventLoopBlockMonitorLive = Layer.effectDiscard(
	monitorEventLoopBlocks(),
);
