import { afterEach, describe, expect, it, vi } from "vitest";
import { DualWriteHook } from "../../../src/lib/persistence/dual-write-hook.js";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import type { OpenCodeEvent } from "../../../src/lib/types.js";

function makeSSEEvent(
	type: string,
	properties: Record<string, unknown>,
): OpenCodeEvent {
	return { type, properties } as OpenCodeEvent;
}

const noopLog = {
	warn: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	verbose: vi.fn(),
};

describe("Feature Flag", () => {
	let layer: PersistenceLayer;

	afterEach(() => {
		layer?.close();
	});

	it("enabled=true writes events", () => {
		layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({
			persistence: layer,
			log: noopLog,
			enabled: true,
		});
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "s1",
				messageID: "m1",
				info: { role: "user", parts: [] },
			}),
			"s1",
		);
		expect(layer.eventStore.readFromSequence(0).length).toBeGreaterThan(0);
	});

	it("enabled=false skips all writes", () => {
		layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({
			persistence: layer,
			log: noopLog,
			enabled: false,
		});
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "s1",
				messageID: "m1",
				info: { role: "user", parts: [] },
			}),
			"s1",
		);
		expect(layer.eventStore.readFromSequence(0)).toHaveLength(0);
	});

	it("enabled=undefined defaults to true", () => {
		layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({ persistence: layer, log: noopLog });
		hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: "s1",
				messageID: "m1",
				info: { role: "user", parts: [] },
			}),
			"s1",
		);
		expect(layer.eventStore.readFromSequence(0).length).toBeGreaterThan(0);
	});

	it("onReconnect resets state", () => {
		layer = PersistenceLayer.memory();
		const hook = new DualWriteHook({ persistence: layer, log: noopLog });
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "s1",
				messageID: "m1",
				partID: "p1",
				part: {
					id: "p1",
					type: "tool",
					callID: "c1",
					tool: "bash",
					state: { status: "pending" },
				},
			}),
			"s1",
		);
		hook.onReconnect();
		hook.onSSEEvent(
			makeSSEEvent("message.part.updated", {
				sessionID: "s1",
				messageID: "m1",
				partID: "p1",
				part: {
					id: "p1",
					type: "tool",
					callID: "c1",
					tool: "bash",
					state: { status: "pending" },
				},
			}),
			"s1",
		);
		const toolStarted = layer.eventStore
			.readFromSequence(0)
			.filter((e) => e.type === "tool.started");
		expect(toolStarted).toHaveLength(2);
	});
});
