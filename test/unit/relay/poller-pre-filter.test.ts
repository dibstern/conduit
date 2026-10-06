import { describe, expect, it } from "vitest";
import {
	classifyPollerBatch,
	METADATA_TYPES,
} from "../../../src/lib/relay/poller-pre-filter.js";
import {
	KNOWN_RELAY_MESSAGE_TYPES,
	type RelayMessage,
} from "../../../src/lib/shared-types.js";

describe("classifyPollerBatch", () => {
	it("returns hasContentActivity true for delta messages", () => {
		const events = [{ type: "delta", text: "hello" }] as RelayMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(true);
	});

	it("returns hasContentActivity true for tool_result messages", () => {
		const events = [{ type: "tool_result" }] as RelayMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(true);
	});

	it("returns hasContentActivity false for empty batch", () => {
		expect(classifyPollerBatch([]).hasContentActivity).toBe(false);
	});

	it("returns hasContentActivity false for metadata-only batch", () => {
		const events = [
			{ type: "session_list" },
			{ type: "instance_update", instanceId: "i1" },
		] as RelayMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(false);
	});

	it("returns hasContentActivity true when mixed batch has at least one content event", () => {
		const events = [
			{ type: "session_list" },
			{ type: "delta", text: "hi" },
		] as RelayMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(true);
	});

	it("returns hasContentActivity true for done events", () => {
		const events = [{ type: "done", code: 0 }] as RelayMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(true);
	});

	it("returns hasContentActivity true for thinking_delta", () => {
		const events = [{ type: "thinking_delta" }] as RelayMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(true);
	});

	// file_changed was never metadata, and poller batches (message-poller
	// output) never carried it; deleting it changes no classification. The
	// set must only name live frames so a retired type cannot linger here.
	it("classifies only live relay message types as metadata", () => {
		expect(
			[...METADATA_TYPES].filter(
				(type) => !KNOWN_RELAY_MESSAGE_TYPES.has(type),
			),
		).toEqual([]);
		expect(METADATA_TYPES.has("file_changed" as RelayMessage["type"])).toBe(
			false,
		);
	});
});
