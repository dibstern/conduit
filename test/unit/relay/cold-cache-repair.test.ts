import { describe, expect, it } from "vitest";
import { repairColdSession } from "../../../src/lib/relay/cold-cache-repair.js";
import type { RelayMessage } from "../../../src/lib/types.js";

describe("repairColdSession", () => {
	it("returns unchanged for empty events", () => {
		const { repaired, changed } = repairColdSession([]);
		expect(repaired).toEqual([]);
		expect(changed).toBe(false);
	});

	it("returns unchanged when last event is done", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "world" },
			{ type: "done", code: 0 },
		];
		const { repaired, changed } = repairColdSession(events);
		expect(repaired).toEqual(events);
		expect(changed).toBe(false);
	});

	it("returns unchanged when last event is result", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "world" },
			{
				type: "result",
				usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
				cost: 0.01,
				duration: 1000,
				sessionId: "s1",
			},
		];
		const { repaired, changed } = repairColdSession(events);
		expect(repaired).toEqual(events);
		expect(changed).toBe(false);
	});

	it("returns unchanged when last event is error", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "world" },
			{ type: "error", code: "STREAM_ERR", message: "fail" },
		];
		const { repaired, changed } = repairColdSession(events);
		expect(repaired).toEqual(events);
		expect(changed).toBe(false);
	});

	it("truncates trailing deltas after last done", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "next question" },
			{ type: "delta", text: "partial" },
		];
		const { repaired, changed } = repairColdSession(events);
		expect(repaired).toEqual([
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "next question" },
		]);
		expect(changed).toBe(true);
	});

	it("truncates trailing tool events after last result", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
			{
				type: "result",
				usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
				cost: 0.01,
				duration: 1000,
				sessionId: "s1",
			},
			{ type: "user_message", text: "next" },
			{ type: "tool_start", id: "t1", name: "Read" },
			{ type: "tool_executing", id: "t1", name: "Read", input: undefined },
		];
		const { repaired, changed } = repairColdSession(events);
		expect(repaired).toEqual([
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
			{
				type: "result",
				usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
				cost: 0.01,
				duration: 1000,
				sessionId: "s1",
			},
			{ type: "user_message", text: "next" },
		]);
		expect(changed).toBe(true);
	});

	it("preserves user_message after terminal but removes streaming events", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "q1" },
			{ type: "delta", text: "a1" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "q2" },
			{ type: "delta", text: "partial-a2" },
			{ type: "thinking_start" },
			{ type: "thinking_delta", text: "hmm" },
		];
		const { repaired, changed } = repairColdSession(events);
		expect(repaired).toEqual([
			{ type: "user_message", text: "q1" },
			{ type: "delta", text: "a1" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "q2" },
		]);
		expect(changed).toBe(true);
	});

	it("keeps only user_messages when no terminal events exist", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "partial" },
			{ type: "tool_start", id: "t1", name: "Read" },
		];
		const { repaired, changed } = repairColdSession(events);
		expect(repaired).toEqual([{ type: "user_message", text: "hello" }]);
		expect(changed).toBe(true);
	});

	it("returns empty when no terminal events and no user_messages", () => {
		const events: RelayMessage[] = [
			{ type: "delta", text: "orphan" },
			{ type: "thinking_start" },
		];
		const { repaired, changed } = repairColdSession(events);
		expect(repaired).toEqual([]);
		expect(changed).toBe(true);
	});

	it("handles done before result ordering", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
			{ type: "done", code: 0 },
			{
				type: "result",
				usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
				cost: 0.01,
				duration: 1000,
				sessionId: "s1",
			},
		];
		const { repaired, changed } = repairColdSession(events);
		expect(repaired).toEqual(events);
		expect(changed).toBe(false);
	});

	it("handles multiple complete turns with no trailing events", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "q1" },
			{ type: "delta", text: "a1" },
			{
				type: "result",
				usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
				cost: 0.01,
				duration: 500,
				sessionId: "s1",
			},
			{ type: "done", code: 0 },
			{ type: "user_message", text: "q2" },
			{ type: "delta", text: "a2" },
			{
				type: "result",
				usage: { input: 15, output: 25, cache_read: 0, cache_creation: 0 },
				cost: 0.02,
				duration: 600,
				sessionId: "s1",
			},
			{ type: "done", code: 0 },
		];
		const { repaired, changed } = repairColdSession(events);
		expect(repaired).toEqual(events);
		expect(changed).toBe(false);
	});

	it("user_message alone (no terminal, no streaming) is preserved", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "just sent" },
		];
		const { repaired, changed } = repairColdSession(events);
		expect(repaired).toEqual(events);
		expect(changed).toBe(false);
	});
});
