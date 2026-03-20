import { describe, expect, it } from "vitest";
import {
	createSessionSSETracker,
	deriveSSECoverage,
} from "../../../src/lib/relay/session-sse-tracker.js";

describe("deriveSSECoverage", () => {
	const THRESHOLD = 5_000;

	it("returns disconnected when global SSE is not connected", () => {
		expect(deriveSSECoverage(false, 1000, 2000, THRESHOLD)).toEqual({
			kind: "disconnected",
		});
	});

	it("returns never-seen when no SSE event recorded for session", () => {
		expect(deriveSSECoverage(true, undefined, 2000, THRESHOLD)).toEqual({
			kind: "never-seen",
		});
	});

	it("returns active when last event is within threshold", () => {
		expect(deriveSSECoverage(true, 1000, 2000, THRESHOLD)).toEqual({
			kind: "active",
			lastEventAt: 1000,
		});
	});

	it("returns stale when last event exceeds threshold", () => {
		expect(deriveSSECoverage(true, 1000, 7000, THRESHOLD)).toEqual({
			kind: "stale",
			lastEventAt: 1000,
		});
	});

	it("returns active at exactly the threshold boundary", () => {
		expect(deriveSSECoverage(true, 1000, 5999, THRESHOLD)).toEqual({
			kind: "active",
			lastEventAt: 1000,
		});
	});

	it("returns stale at exactly the threshold boundary", () => {
		expect(deriveSSECoverage(true, 1000, 6000, THRESHOLD)).toEqual({
			kind: "stale",
			lastEventAt: 1000,
		});
	});
});

describe("createSessionSSETracker", () => {
	it("returns undefined for unknown session", () => {
		const tracker = createSessionSSETracker();
		expect(tracker.getLastEventAt("unknown")).toBeUndefined();
	});

	it("records and retrieves event timestamp", () => {
		const tracker = createSessionSSETracker();
		tracker.recordEvent("s1", 1000);
		expect(tracker.getLastEventAt("s1")).toBe(1000);
	});

	it("overwrites with later timestamp", () => {
		const tracker = createSessionSSETracker();
		tracker.recordEvent("s1", 1000);
		tracker.recordEvent("s1", 2000);
		expect(tracker.getLastEventAt("s1")).toBe(2000);
	});

	it("remove clears tracking for a session", () => {
		const tracker = createSessionSSETracker();
		tracker.recordEvent("s1", 1000);
		tracker.remove("s1");
		expect(tracker.getLastEventAt("s1")).toBeUndefined();
	});
});
