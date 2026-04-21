// ─── Synthesized status events carry correct sessionId ──────────────────────
// Asserts that synthesized `status` events from switchClientToSession and
// synthesized `done` from patchMissingDone include the correct sessionId.
//
// Server Task 1: sessionId was added to every per-session RelayMessage variant.

import { describe, expect, it, vi } from "vitest";
import {
	patchMissingDone,
	type SessionHistorySource,
	type SessionSwitchDeps,
	switchClientToSession,
} from "../../../src/lib/session/session-switch.js";
import type { RelayMessage } from "../../../src/lib/types.js";

// ─── Helper: build full deps for switchClientToSession ──────────────────────

function createFullDeps(
	overrides?: Partial<SessionSwitchDeps>,
): SessionSwitchDeps {
	return {
		sessionMgr: {
			loadPreRenderedHistory: vi.fn().mockResolvedValue({
				messages: [],
				hasMore: false,
			}),
			seedPaginationCursor: vi.fn(),
		},
		wsHandler: {
			sendTo: vi.fn(),
			setClientSession: vi.fn(),
		},
		statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
		pollerManager: {
			isPolling: vi.fn().mockReturnValue(true),
			startPolling: vi.fn(),
		},
		log: { info: vi.fn(), warn: vi.fn() },
		getInputDraft: vi.fn().mockReturnValue(undefined),
		...overrides,
	};
}

// ─── switchClientToSession: status event sessionId ──────────────────────────

describe("switchClientToSession status event sessionId", () => {
	it("sends status event with sessionId matching the target session", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_target_42");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, m]) => (m as { type: string }).type === "status",
		);
		expect(statusMsg).toBeDefined();
		const payload = statusMsg?.[1] as Extract<RelayMessage, { type: "status" }>;
		expect(payload.sessionId).toBe("ses_target_42");
	});

	it("status sessionId is the correct session, not any random value", async () => {
		const deps = createFullDeps();
		const targetId = "ses_correct_session";

		await switchClientToSession(deps, "c1", targetId);

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, m]) => (m as { type: string }).type === "status",
		);
		const payload = statusMsg?.[1] as Extract<RelayMessage, { type: "status" }>;
		// Must match exactly — not "c1" (clientId), not empty, not undefined
		expect(payload.sessionId).toBe(targetId);
		expect(payload.sessionId).not.toBe("c1");
		expect(payload.sessionId).not.toBe("");
	});

	it("session_switched message also includes correct sessionId", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_sw_check");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, m]) => (m as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		const payload = switchMsg?.[1] as Extract<
			RelayMessage,
			{ type: "session_switched" }
		>;
		expect(payload.sessionId).toBe("ses_sw_check");
		expect(payload.id).toBe("ses_sw_check");
	});

	it("status is 'processing' with correct sessionId when poller says busy", async () => {
		const deps = createFullDeps({
			statusPoller: { isProcessing: vi.fn().mockReturnValue(true) },
		});

		await switchClientToSession(deps, "c1", "ses_busy");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, m]) => (m as { type: string }).type === "status",
		);
		const payload = statusMsg?.[1] as Extract<RelayMessage, { type: "status" }>;
		expect(payload.sessionId).toBe("ses_busy");
		expect(payload.status).toBe("processing");
	});

	it("status is 'processing' with correct sessionId when overrides has active timeout", async () => {
		const deps = createFullDeps({
			statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
			overrides: {
				hasActiveProcessingTimeout: vi.fn().mockReturnValue(true),
			},
		});

		await switchClientToSession(deps, "c1", "ses_claude_busy");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, m]) => (m as { type: string }).type === "status",
		);
		const payload = statusMsg?.[1] as Extract<RelayMessage, { type: "status" }>;
		expect(payload.sessionId).toBe("ses_claude_busy");
		expect(payload.status).toBe("processing");
	});

	it("status is 'idle' with correct sessionId when both poller and overrides say idle", async () => {
		const deps = createFullDeps({
			statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
			overrides: {
				hasActiveProcessingTimeout: vi.fn().mockReturnValue(false),
			},
		});

		await switchClientToSession(deps, "c1", "ses_idle");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, m]) => (m as { type: string }).type === "status",
		);
		const payload = statusMsg?.[1] as Extract<RelayMessage, { type: "status" }>;
		expect(payload.sessionId).toBe("ses_idle");
		expect(payload.status).toBe("idle");
	});
});

// ─── patchMissingDone: synthesized done sessionId ───────────────────────────

describe("patchMissingDone synthesized done sessionId", () => {
	it("synthesized done includes the correct sessionId", () => {
		const sid = "ses_patch_correct";
		const source: SessionHistorySource = {
			kind: "cached-events",
			events: [
				{ type: "user_message", sessionId: sid, text: "hi" },
				{ type: "delta", sessionId: sid, text: "response" },
			],
			hasMore: false,
		};

		const result = patchMissingDone(source, undefined, sid);

		expect(result.kind).toBe("cached-events");
		if (result.kind === "cached-events") {
			const done = result.events.find((e) => e.type === "done");
			expect(done).toBeDefined();
			expect((done as { sessionId: string }).sessionId).toBe(sid);
		}
	});

	it("synthesized done sessionId matches the session argument, not events", () => {
		// Events have sessionId "ses_old" but we pass "ses_new" as the session param
		const source: SessionHistorySource = {
			kind: "cached-events",
			events: [
				{ type: "user_message", sessionId: "ses_old", text: "hi" },
				{ type: "delta", sessionId: "ses_old", text: "response" },
			],
			hasMore: false,
		};

		const result = patchMissingDone(source, undefined, "ses_new");

		expect(result.kind).toBe("cached-events");
		if (result.kind === "cached-events") {
			const done = result.events.find((e) => e.type === "done");
			expect(done).toBeDefined();
			// The sessionId should be the one passed to patchMissingDone, not from events
			expect((done as { sessionId: string }).sessionId).toBe("ses_new");
		}
	});

	it("synthesized done has code 0 (clean exit)", () => {
		const source: SessionHistorySource = {
			kind: "cached-events",
			events: [
				{ type: "user_message", sessionId: "s1", text: "hi" },
				{ type: "delta", sessionId: "s1", text: "response" },
			],
			hasMore: false,
		};

		const result = patchMissingDone(source, undefined, "s1");

		if (result.kind === "cached-events") {
			const done = result.events.find((e) => e.type === "done");
			expect((done as { code: number }).code).toBe(0);
		}
	});
});
