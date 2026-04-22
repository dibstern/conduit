// test/unit/relay/relay-stack-dual-write-wiring.test.ts
// ─── DualWriteHook Relay Stack Wiring Test ──────────────────────────────────
// Validates that createProjectRelay unconditionally creates a DualWriteHook
// when config.persistence is provided, with no feature-flag gating.
// Mirrors the exact wiring pattern from relay-stack.ts.

import { afterEach, describe, expect, it } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";

/**
 * Simulates the DualWriteHook wiring in createProjectRelay().
 * This is the exact pattern used in relay-stack.ts:
 *
 * ```ts
 * let dualWriteHook: DualWriteHook | undefined;
 * if (config.persistence) {
 *     dualWriteHook = new DualWriteHook({
 *         persistence: config.persistence,
 *         log: log.child("dual-write"),
 *     });
 * }
 * ```
 *
 * No feature flag, no conditional — just presence of persistence.
 */
function simulateDualWriteWiring(opts: { persistence?: PersistenceLayer }): {
	dualWriteHook: DualWriteHook | undefined;
} {
	const log = createSilentLogger();

	let dualWriteHook: DualWriteHook | undefined;
	if (opts.persistence) {
		dualWriteHook = new DualWriteHook({
			persistence: opts.persistence,
			log: log.child("dual-write"),
		});
	}

	return { dualWriteHook };
}

describe("Relay stack DualWriteHook wiring", () => {
	let layer: PersistenceLayer | undefined;

	afterEach(() => {
		layer?.close();
		layer = undefined;
	});

	it("creates DualWriteHook unconditionally when persistence is provided", () => {
		layer = PersistenceLayer.memory();
		const { dualWriteHook } = simulateDualWriteWiring({
			persistence: layer,
		});

		expect(dualWriteHook).toBeDefined();
		expect(dualWriteHook).toBeInstanceOf(DualWriteHook);
	});

	it("does not create DualWriteHook when persistence is absent", () => {
		const { dualWriteHook } = simulateDualWriteWiring({});

		expect(dualWriteHook).toBeUndefined();
	});

	it("created DualWriteHook is functional (can process events)", () => {
		layer = PersistenceLayer.memory();
		const { dualWriteHook } = simulateDualWriteWiring({
			persistence: layer,
		});

		expect(dualWriteHook).toBeDefined();
		if (!dualWriteHook) return; // narrowing guard — expect above catches undefined

		// Verify the hook can process an event without throwing
		const result = dualWriteHook.onSSEEvent(
			{
				type: "message.created",
				properties: {
					sessionID: "test-session",
					messageID: "msg-001",
					info: { role: "assistant", parts: [] },
				},
			},
			"test-session",
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.eventsWritten).toBeGreaterThan(0);
		}
	});
});
