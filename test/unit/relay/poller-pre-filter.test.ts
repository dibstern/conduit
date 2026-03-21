import { describe, expect, it } from "vitest";
import { classifyPollerBatch } from "../../../src/lib/relay/poller-pre-filter.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

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
			{ type: "model_info" },
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

	it("returns hasContentActivity true for error events", () => {
		const events = [
			{ type: "error", code: "ERR", message: "fail" },
		] as RelayMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(true);
	});

	it("returns hasContentActivity true for thinking_delta", () => {
		const events = [{ type: "thinking_delta" }] as RelayMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(true);
	});

	it("returns hasContentActivity false for connection_status", () => {
		const events = [{ type: "connection_status" }] as RelayMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(false);
	});

	it("returns hasContentActivity false for client_count", () => {
		const events = [{ type: "client_count" }] as RelayMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(false);
	});
});
