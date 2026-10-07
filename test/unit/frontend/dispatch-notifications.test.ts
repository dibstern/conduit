import { seedSessions } from "../stores/session-fixtures.js";
// RPC alerts notify without changing the viewed transcript.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const triggerNotificationsMock = vi.hoisted(() => vi.fn());

// Mock the notification module to spy on triggerNotifications
vi.mock("../../../src/lib/frontend/stores/ws-notifications.js", () => ({
	triggerNotifications: triggerNotificationsMock,
	setPushActive: vi.fn(),
	isPushActive: vi.fn(() => false),
	NOTIF_TYPES: new Set(["done", "error"]),
}));

// Mock DOMPurify (required by chat.svelte.ts → markdown.ts)
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

// Mock ui.svelte.js
vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: vi.fn(),
	showBanner: vi.fn(),
	removeBanner: vi.fn(),
	setClientCount: vi.fn(),
}));

import { applyAlert } from "../../../src/lib/frontend/stores/alerts.js";
import {
	clearMessages,
	getOrCreateSessionActivity,
	isProcessing,
	isStreaming,
	phaseToStreaming,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { showToast } from "../../../src/lib/frontend/stores/ui.svelte.js";

beforeEach(() => {
	sessionState.currentId = "test-session";
	// Register sessions used by the alert tests.
	seedSessions([
		{ id: "test-session", title: "", status: "idle" },
		{ id: "s1", title: "", status: "idle" },
	]);
	clearMessages();
	triggerNotificationsMock.mockClear();
	vi.mocked(showToast).mockClear();
});

afterEach(() => {
	clearMessages();
});

describe("applyAlert fires the ding for a session no tab is viewing", () => {
	it("calls triggerNotifications with a synthetic done message", () => {
		applyAlert({ _tag: "alert", kind: "done", alertId: "a1" });
		expect(triggerNotificationsMock).toHaveBeenCalledOnce();
		expect(triggerNotificationsMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "done", alertId: "a1" }),
		);
	});

	it("calls triggerNotifications and toasts for an error", () => {
		applyAlert({
			_tag: "alert",
			kind: "error",
			alertId: "a2",
			message: "Something failed",
		});
		expect(triggerNotificationsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "done",
				code: 1,
				error: "Something failed",
			}),
		);
		expect(showToast).toHaveBeenCalledOnce();
	});

	it("threads sessionId and alertId to triggerNotifications", () => {
		applyAlert({
			_tag: "alert",
			kind: "done",
			sessionId: "sess-xyz",
			alertId: "turn-1:done",
		});
		expect(triggerNotificationsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "done",
				sessionId: "sess-xyz",
				alertId: "turn-1:done",
			}),
		);
	});

	it("does NOT update chat state (only triggers notification)", () => {
		phaseToStreaming(getOrCreateSessionActivity("test-session"));

		applyAlert({
			_tag: "alert",
			kind: "done",
			sessionId: "test-session",
			alertId: "a3",
		});

		expect(isProcessing()).toBe(true);
		expect(isStreaming()).toBe(true);
	});
});
