import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__setProbeOverrideForTesting,
	getCachedClaudeCapabilities,
	resetCapabilityCacheForTesting,
} from "../../../../src/lib/provider/claude/claude-capabilities-probe.js";

describe("getCachedClaudeCapabilities", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetCapabilityCacheForTesting();
	});

	afterEach(() => {
		vi.useRealTimers();
		__setProbeOverrideForTesting(undefined);
		resetCapabilityCacheForTesting();
	});

	it("invokes the probe once and caches for 5 minutes", async () => {
		const probe = vi.fn().mockResolvedValue({
			models: [
				{ id: "claude-opus-4-7", name: "Opus 4.7", providerId: "claude" },
			],
			commands: [],
			agents: [],
		});
		__setProbeOverrideForTesting(probe);

		const r1 = await getCachedClaudeCapabilities();
		expect(r1.models).toHaveLength(1);
		expect(probe).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(4 * 60 * 1000);
		const r2 = await getCachedClaudeCapabilities();
		expect(r2.models).toHaveLength(1);
		expect(probe).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(2 * 60 * 1000);
		await getCachedClaudeCapabilities();
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("does not cache probe failures", async () => {
		const probe = vi
			.fn()
			.mockRejectedValueOnce(new Error("binary missing"))
			.mockResolvedValueOnce({ models: [], commands: [], agents: [] });
		__setProbeOverrideForTesting(probe);

		await expect(getCachedClaudeCapabilities()).rejects.toThrow(
			"binary missing",
		);
		const r2 = await getCachedClaudeCapabilities();
		expect(r2.models).toEqual([]);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("concurrent calls share one probe invocation", async () => {
		let resolve: (value: { models: []; commands: []; agents: [] }) => void =
			() => {};
		const probe = vi.fn().mockImplementation(
			() =>
				new Promise<{ models: []; commands: []; agents: [] }>((r) => {
					resolve = r;
				}),
		);
		__setProbeOverrideForTesting(probe);

		const calls = [
			getCachedClaudeCapabilities(),
			getCachedClaudeCapabilities(),
			getCachedClaudeCapabilities(),
		];
		resolve({ models: [], commands: [], agents: [] });
		const results = await Promise.all(calls);
		expect(results).toHaveLength(3);
		expect(probe).toHaveBeenCalledTimes(1);
	});
});
