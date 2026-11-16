import { describe, expect, it } from "vitest";
import { classifyPollerBatch } from "../../../src/lib/provider/opencode/poller-pre-filter.js";
import type { BrowserMessage } from "../../../src/lib/shared-types.js";

describe("classifyPollerBatch", () => {
	it("returns hasContentActivity true for delta messages", () => {
		const events = [{ type: "delta", text: "hello" }] as BrowserMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(true);
	});

	it("returns hasContentActivity true for tool_result messages", () => {
		const events = [{ type: "tool_result" }] as BrowserMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(true);
	});

	it("returns hasContentActivity false for empty batch", () => {
		expect(classifyPollerBatch([]).hasContentActivity).toBe(false);
	});

	it("returns hasContentActivity true for done events", () => {
		const events = [{ type: "done", code: 0 }] as BrowserMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(true);
	});

	it("returns hasContentActivity true for thinking_delta", () => {
		const events = [{ type: "thinking_delta" }] as BrowserMessage[];
		expect(classifyPollerBatch(events).hasContentActivity).toBe(true);
	});
});
