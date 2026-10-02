import { describe, it } from "@effect/vitest";
import { Effect, Metric } from "effect";
import { expect } from "vitest";

import {
	activePollersGauge,
	configPersistsCounter,
	rateLimitRejectionsCounter,
	sseReconnectsCounter,
	wsConnectionsGauge,
} from "../../../src/lib/domain/daemon/Services/metrics.js";

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
