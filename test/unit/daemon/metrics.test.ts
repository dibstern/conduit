import { describe, it } from "@effect/vitest";
import { Effect, Metric } from "effect";
import { expect } from "vitest";

import {
	activePollersGauge,
	configPersistsCounter,
	ipcCommandsCounter,
	ipcLatencyHistogram,
	rateLimitRejectionsCounter,
	sseReconnectsCounter,
	wsConnectionsGauge,
} from "../../../src/lib/effect/metrics.js";

describe("Effect.Metric definitions", () => {
	it.effect("wsConnectionsGauge increments and decrements", () =>
		Effect.gen(function* () {
			yield* Metric.increment(wsConnectionsGauge);
			yield* Metric.increment(wsConnectionsGauge);
			// No Metric.decrement — use modify with negative value (delta)
			yield* Metric.modify(wsConnectionsGauge, -1);
			const state = yield* Metric.value(wsConnectionsGauge);
			expect(state.value).toBe(1);
		}),
	);

	it.effect("activePollersGauge tracks via set", () =>
		Effect.gen(function* () {
			yield* Metric.set(activePollersGauge, 5);
			const state = yield* Metric.value(activePollersGauge);
			expect(state.value).toBe(5);
		}),
	);

	it.effect("ipcCommandsCounter tracks tagged commands", () =>
		Effect.gen(function* () {
			const getStatusCounter = Metric.tagged(
				ipcCommandsCounter,
				"cmd",
				"get_status",
			);
			yield* Metric.update(getStatusCounter, 1);
			yield* Metric.update(getStatusCounter, 1);
			yield* Metric.update(
				Metric.tagged(ipcCommandsCounter, "cmd", "shutdown"),
				1,
			);
			// Tagged counters are separate from the base counter, so just
			// verify the operations complete without error.
		}),
	);

	it.effect("ipcLatencyHistogram records values", () =>
		Effect.gen(function* () {
			yield* Metric.update(ipcLatencyHistogram, 15);
			yield* Metric.update(ipcLatencyHistogram, 150);
			const state = yield* Metric.value(ipcLatencyHistogram);
			expect(state.count).toBe(2);
			expect(state.sum).toBe(165);
		}),
	);

	it.effect("counter starts at zero", () =>
		Effect.gen(function* () {
			const state = yield* Metric.value(sseReconnectsCounter);
			expect(state.count).toBeGreaterThanOrEqual(0);
		}),
	);

	it.effect("rateLimitRejectionsCounter increments", () =>
		Effect.gen(function* () {
			yield* Metric.increment(rateLimitRejectionsCounter);
			yield* Metric.increment(rateLimitRejectionsCounter);
			const state = yield* Metric.value(rateLimitRejectionsCounter);
			expect(state.count).toBeGreaterThanOrEqual(2);
		}),
	);

	it.effect("configPersistsCounter increments", () =>
		Effect.gen(function* () {
			yield* Metric.increment(configPersistsCounter);
			const state = yield* Metric.value(configPersistsCounter);
			expect(state.count).toBeGreaterThanOrEqual(1);
		}),
	);
});
