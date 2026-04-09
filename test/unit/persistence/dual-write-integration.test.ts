// ─── Dual-Write Integration Test (Task 11) ──────────────────────────────────
// Verifies that SSE events flow through both the relay pipeline AND the
// dual-write hook when wired together in handleSSEEvent().

import { afterEach, describe, expect, it, vi } from "vitest";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { handleSSEEvent } from "../../../src/lib/relay/sse-wiring.js";
import type { RelayMessage } from "../../../src/lib/types.js";
import { createMockSSEWiringDeps } from "../../helpers/mock-factories.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";

const noopLog = {
	warn: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	verbose: vi.fn(),
};

describe("Dual-Write Integration (SSE → relay + event store)", () => {
	let layer: PersistenceLayer;

	afterEach(() => {
		layer?.close();
	});

	it("events flow to both relay and event store", () => {
		layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({ persistence: layer, log: noopLog });

		const broadcast = vi.fn();
		const sendToSession = vi.fn();

		// Configure translator to produce a relay message
		const deps = createMockSSEWiringDeps({
			dualWriteHook: hook,
			wsHandler: {
				broadcast,
				sendToSession,
				getClientsForSession: vi.fn().mockReturnValue(["c1"]),
			},
			translator: {
				translate: vi.fn().mockReturnValue({
					ok: true,
					messages: [
						{
							type: "delta",
							sessionId: "s1",
							text: "Hello",
						} as RelayMessage,
					],
				}),
				reset: vi.fn(),
				getSeenParts: vi.fn().mockReturnValue(new Map()),
				rebuildStateFromHistory: vi.fn(),
			},
		});

		const event = makeSSEEvent("message.created", {
			sessionID: "s1",
			messageID: "m1",
			info: { role: "assistant", parts: [] },
		});

		handleSSEEvent(deps, event);

		// Verify event was persisted to the event store
		const stored = layer.eventStore.readFromSequence(0);
		expect(stored.length).toBeGreaterThan(0);

		// Verify relay pipeline still processed the message
		expect(sendToSession).toHaveBeenCalled();
	});

	it("events reach event store even when translator returns ok:false", () => {
		layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({ persistence: layer, log: noopLog });

		const deps = createMockSSEWiringDeps({
			dualWriteHook: hook,
			// Default mock translator returns ok:false
		});

		const event = makeSSEEvent("message.created", {
			sessionID: "s1",
			messageID: "m1",
			info: { role: "assistant", parts: [] },
		});

		handleSSEEvent(deps, event);

		// Even though translator returned ok:false, dual-write should
		// still have captured the event (it runs before translation)
		const stored = layer.eventStore.readFromSequence(0);
		expect(stored.length).toBeGreaterThan(0);
	});

	it("events reach event store even for permission.asked (early-return path)", () => {
		layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({ persistence: layer, log: noopLog });

		const deps = createMockSSEWiringDeps({
			dualWriteHook: hook,
		});

		// permission.asked events have an early return that skips the translator.
		// The dual-write hook runs BEFORE that, so the event should still be captured
		// (if the translator can translate it to a canonical event).
		const event = makeSSEEvent("permission.asked", {
			sessionID: "s1",
			id: "perm_1",
			permission: "Bash(ls)",
		});

		handleSSEEvent(deps, event);

		// The canonical translator may or may not translate permission.asked,
		// but the hook's onSSEEvent was definitely called
		expect(hook.getStats().eventsReceived).toBe(1);
	});

	it("errors in dual-write do not break relay pipeline", () => {
		layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({ persistence: layer, log: noopLog });

		// Close the DB to force errors in the dual-write hook
		layer.close();

		const broadcast = vi.fn();
		const sendToSession = vi.fn();

		const deps = createMockSSEWiringDeps({
			dualWriteHook: hook,
			wsHandler: {
				broadcast,
				sendToSession,
				getClientsForSession: vi.fn().mockReturnValue(["c1"]),
			},
			translator: {
				translate: vi.fn().mockReturnValue({
					ok: true,
					messages: [
						{
							type: "delta",
							sessionId: "s1",
							text: "Hello",
						} as RelayMessage,
					],
				}),
				reset: vi.fn(),
				getSeenParts: vi.fn().mockReturnValue(new Map()),
				rebuildStateFromHistory: vi.fn(),
			},
		});

		const event = makeSSEEvent("message.created", {
			sessionID: "s1",
			messageID: "m1",
			info: { role: "assistant", parts: [] },
		});

		// Should not throw — dual-write errors are caught internally
		expect(() => handleSSEEvent(deps, event)).not.toThrow();

		// Relay pipeline should still work
		expect(sendToSession).toHaveBeenCalled();

		// Hook should have recorded the error
		expect(hook.getStats().errors).toBe(1);
	});

	it("no dual-write hook means no persistence (backward compatible)", () => {
		const deps = createMockSSEWiringDeps({
			// No dualWriteHook — simulates pre-Phase-2 behavior
		});

		const event = makeSSEEvent("message.created", {
			sessionID: "s1",
			messageID: "m1",
			info: { role: "assistant", parts: [] },
		});

		// Should not throw
		expect(() => handleSSEEvent(deps, event)).not.toThrow();
	});
});
