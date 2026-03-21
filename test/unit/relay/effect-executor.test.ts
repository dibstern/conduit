import { describe, expect, it } from "vitest";
import {
	type EffectDeps,
	executeEffects,
} from "../../../src/lib/relay/effect-executor.js";
import type { MonitoringEffect } from "../../../src/lib/relay/monitoring-types.js";

function createMockDeps(): EffectDeps & {
	calls: Record<string, unknown[][]>;
} {
	const calls: Record<string, unknown[][]> = {};
	function track(name: string) {
		const bucket: unknown[][] = [];
		calls[name] = bucket;
		return (...args: unknown[]) => {
			bucket.push(args);
		};
	}

	return {
		calls,
		startPoller: track("startPoller") as EffectDeps["startPoller"],
		stopPoller: track("stopPoller") as EffectDeps["stopPoller"],
		sendStatusToSession: track(
			"sendStatusToSession",
		) as EffectDeps["sendStatusToSession"],
		processAndApplyDone: track(
			"processAndApplyDone",
		) as EffectDeps["processAndApplyDone"],
		clearProcessingTimeout: track(
			"clearProcessingTimeout",
		) as EffectDeps["clearProcessingTimeout"],
		clearMessageActivity: track(
			"clearMessageActivity",
		) as EffectDeps["clearMessageActivity"],
		log: {
			info: () => {},
			warn: () => {},
			error: () => {},
		} as EffectDeps["log"],
	};
}

describe("executeEffects", () => {
	it("start-poller calls startPoller", () => {
		const deps = createMockDeps();
		const effects: MonitoringEffect[] = [
			{ effect: "start-poller", sessionId: "s1", reason: "sse-disconnected" },
		];
		executeEffects(effects, deps);
		expect(deps.calls["startPoller"]).toEqual([["s1"]]);
	});

	it("stop-poller calls stopPoller + clearProcessingTimeout + clearMessageActivity (no emitDone)", () => {
		const deps = createMockDeps();
		const effects: MonitoringEffect[] = [
			{ effect: "stop-poller", sessionId: "s1", reason: "idle-no-viewers" },
		];
		executeEffects(effects, deps);
		expect(deps.calls["stopPoller"]).toEqual([["s1"]]);
		expect(deps.calls["clearProcessingTimeout"]).toEqual([["s1"]]);
		expect(deps.calls["clearMessageActivity"]).toEqual([["s1"]]);
	});

	it("notify-busy sends processing status to session", () => {
		const deps = createMockDeps();
		const effects: MonitoringEffect[] = [
			{ effect: "notify-busy", sessionId: "s1" },
		];
		executeEffects(effects, deps);
		expect(deps.calls["sendStatusToSession"]).toEqual([
			["s1", { type: "status", status: "processing" }],
		]);
	});

	it("notify-idle processes done + clears processing timeout + clears message activity", () => {
		const deps = createMockDeps();
		const effects: MonitoringEffect[] = [
			{ effect: "notify-idle", sessionId: "s1", isSubagent: false },
		];
		executeEffects(effects, deps);
		expect(deps.calls["processAndApplyDone"]).toEqual([["s1", false]]);
		expect(deps.calls["clearProcessingTimeout"]).toEqual([["s1"]]);
		expect(deps.calls["clearMessageActivity"]).toEqual([["s1"]]);
	});

	it("notify-idle with isSubagent=true passes isSubagent through", () => {
		const deps = createMockDeps();
		const effects: MonitoringEffect[] = [
			{ effect: "notify-idle", sessionId: "s1", isSubagent: true },
		];
		executeEffects(effects, deps);
		expect(deps.calls["processAndApplyDone"]).toEqual([["s1", true]]);
	});

	it("processes multiple effects in order", () => {
		const deps = createMockDeps();
		const order: string[] = [];
		deps.startPoller = ((sid: string) =>
			order.push(`start:${sid}`)) as EffectDeps["startPoller"];
		deps.stopPoller = ((sid: string) =>
			order.push(`stop:${sid}`)) as EffectDeps["stopPoller"];
		deps.clearProcessingTimeout =
			(() => {}) as EffectDeps["clearProcessingTimeout"];
		deps.clearMessageActivity =
			(() => {}) as EffectDeps["clearMessageActivity"];

		const effects: MonitoringEffect[] = [
			{ effect: "start-poller", sessionId: "s1", reason: "sse-stale" },
			{ effect: "stop-poller", sessionId: "s2", reason: "sse-now-covering" },
		];
		executeEffects(effects, deps);
		expect(order).toEqual(["start:s1", "stop:s2"]);
	});

	it("empty effects array is a no-op", () => {
		const deps = createMockDeps();
		executeEffects([], deps);
		for (const [, calls] of Object.entries(deps.calls)) {
			expect(calls).toEqual([]);
		}
	});
});
