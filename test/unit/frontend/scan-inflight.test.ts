// ─── Scan In-Flight State ───────────────────────────────────────────────────
// Verifies that the scanInFlight flag is properly managed across all outcomes:
// success (scan_result), error (INSTANCE_ERROR), and state reset.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock DOMPurify (required by chat.svelte.ts → markdown.ts)
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	beginScan,
	clearInstanceState,
	getScanResult,
	handleScanResult,
	isScanInFlight,
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
	it("beginScan sets scanInFlight without depending on legacy WS commands", () => {
		clearInstanceState();
		beginScan();
		expect(isScanInFlight()).toBe(true);
	});

	it("handleScanResult clears scanInFlight", () => {
		clearInstanceState();
		beginScan();
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
		beginScan();

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

	it("clears scanInFlight when server responds with system_error INSTANCE_ERROR", () => {
		clearInstanceState();
		beginScan();
		expect(isScanInFlight()).toBe(true);

		// Server sends error instead of scan_result.
		const errorMsg: RelayMessage = {
			type: "system_error",
			code: "INSTANCE_ERROR",
			message: "Port scanning not available",
		};
		handleMessage(errorMsg);

		// scanInFlight must be cleared so the UI doesn't hang on "Scanning..."
		expect(isScanInFlight()).toBe(false);
	});

	it("logs system_error messages to the browser console", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const details = {
			sessionId: "ses_1",
			fallbackTitle: "Claude Session 2026-05-17 14:32",
		};
		const errorMsg: RelayMessage = {
			type: "system_error",
			code: "SESSION_TITLE_GENERATION_FAILED",
			message: "Claude session title generation failed; using fallback title.",
			details,
		};

		try {
			handleMessage(errorMsg);

			expect(warnSpy).toHaveBeenCalledWith(
				"[ws]",
				"System error:",
				"SESSION_TITLE_GENERATION_FAILED",
				"Claude session title generation failed; using fallback title.",
				details,
			);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
