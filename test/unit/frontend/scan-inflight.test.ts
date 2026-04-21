// ─── Scan In-Flight State ───────────────────────────────────────────────────
// Verifies that the scanInFlight flag is properly managed across all outcomes:
// success (scan_result), error (INSTANCE_ERROR), and state reset.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock DOMPurify (required by chat.svelte.ts → markdown.ts)
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	clearInstanceState,
	getScanResult,
	handleScanResult,
	isScanInFlight,
	triggerScan,
} from "../../../src/lib/frontend/stores/instance.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

beforeEach(() => {
	sessionState.currentId = "test-session";
	// Register sessions so routePerSession's unknown-session guard passes.
	sessionState.sessions.set("test-session", { id: "test-session", title: "" });
	sessionState.sessions.set("s1", { id: "s1", title: "" });
});

describe("scanInFlight state management", () => {
	it("triggerScan sets scanInFlight and sends scan_now message", () => {
		clearInstanceState();
		const sendFn = vi.fn();
		triggerScan(sendFn);
		expect(isScanInFlight()).toBe(true);
		expect(sendFn).toHaveBeenCalledWith({ type: "scan_now" });
	});

	it("handleScanResult clears scanInFlight", () => {
		clearInstanceState();
		const sendFn = vi.fn();
		triggerScan(sendFn);
		expect(isScanInFlight()).toBe(true);

		handleScanResult({
			type: "scan_result",
			discovered: [4098],
			lost: [],
			active: [4096, 4098],
		});

		expect(isScanInFlight()).toBe(false);
		expect(getScanResult()).toEqual({
			discovered: [4098],
			lost: [],
			active: [4096, 4098],
		});
	});

	it("stores active ports from scan result", () => {
		clearInstanceState();
		const sendFn = vi.fn();
		triggerScan(sendFn);

		handleScanResult({
			type: "scan_result",
			discovered: [],
			lost: [],
			active: [4096, 4097],
		});

		expect(isScanInFlight()).toBe(false);
		const result = getScanResult();
		expect(result).toEqual({
			discovered: [],
			lost: [],
			active: [4096, 4097],
		});
	});

	it("clears scanInFlight when server responds with INSTANCE_ERROR", () => {
		clearInstanceState();
		const sendFn = vi.fn();
		triggerScan(sendFn);
		expect(isScanInFlight()).toBe(true);

		// Server sends error instead of scan_result (e.g. triggerScan not wired)
		const errorMsg: RelayMessage = {
			type: "error",
			sessionId: "s1",
			code: "INSTANCE_ERROR",
			message: "Port scanning not available",
		};
		handleMessage(errorMsg);

		// scanInFlight must be cleared so the UI doesn't hang on "Scanning..."
		expect(isScanInFlight()).toBe(false);
	});
});
