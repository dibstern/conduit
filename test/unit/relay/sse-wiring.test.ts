import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { shouldCache } from "../../../src/lib/relay/event-pipeline.js";
import {
	extractSessionId,
	handleSSEEvent,
	type SSEWiringDeps,
	wireSSEConsumer,
} from "../../../src/lib/relay/sse-wiring.js";
import { TRUNCATION_THRESHOLD } from "../../../src/lib/relay/truncate-content.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import type { OpenCodeEvent, RelayMessage } from "../../../src/lib/types.js";
import { createMockSSEWiringDeps } from "../../helpers/mock-factories.js";

/** Cast a plain string to PermissionId for test data. */
const pid = (s: string) => s as PermissionId;

// ─── extractSessionId ────────────────────────────────────────────────────────

describe("extractSessionId", () => {
	it("returns top-level sessionID", () => {
		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "s1" },
		};
		expect(extractSessionId(event)).toBe("s1");
	});

	it("returns sessionID nested in part", () => {
		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: { part: { sessionID: "s2" } },
		};
		expect(extractSessionId(event)).toBe("s2");
	});

	it("returns sessionID nested in info", () => {
		const event: OpenCodeEvent = {
			type: "message.updated",
			properties: { info: { sessionID: "s3" } },
		};
		expect(extractSessionId(event)).toBe("s3");
	});

	it("returns id from info for session.updated", () => {
		const event: OpenCodeEvent = {
			type: "session.updated",
			properties: { info: { id: "s4" } },
		};
		expect(extractSessionId(event)).toBe("s4");
	});

	it("returns undefined when no sessionID found", () => {
		const event: OpenCodeEvent = {
			type: "unknown",
			properties: {},
		};
		expect(extractSessionId(event)).toBeUndefined();
	});

	it("prefers top-level sessionID over nested", () => {
		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: {
				sessionID: "top-level",
				part: { sessionID: "nested" },
			},
		};
		expect(extractSessionId(event)).toBe("top-level");
	});
});

// ─── shouldCache ─────────────────────────────────────────────────────────────

describe("shouldCache", () => {
	it("returns true for chat-relevant types", () => {
		const cacheableTypes = [
			"user_message",
			"delta",
			"thinking_start",
			"thinking_delta",
			"thinking_stop",
			"tool_start",
			"tool_executing",
			"tool_result",
			"result",
			"done",
			"error",
		] as const;
		for (const type of cacheableTypes) {
			expect(shouldCache(type)).toBe(true);
		}
	});

	it("returns false for non-chat types", () => {
		const nonCacheable = [
			"file_changed",
			"permission_request",
			"permission_resolved",
			"todo_state",
			"pty_created",
			"pty_output",
			"status",
		] as const;
		for (const type of nonCacheable) {
			expect(shouldCache(type)).toBe(false);
		}
	});
});

// ─── handleSSEEvent ──────────────────────────────────────────────────────────

describe("handleSSEEvent", () => {
	it("translates, caches, and routes events to session viewers", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = { type: "delta", text: "hello" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.translator.translate).toHaveBeenCalledWith(event, {
			sessionId: "active-session",
		});
		expect(deps.messageCache.recordEvent).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("caches and routes events for non-active session to its viewers", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = { type: "delta", text: "hello" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "other-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.messageCache.recordEvent).toHaveBeenCalledWith(
			"other-session",
			translated,
		);
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"other-session",
			translated,
		);
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("caches but does NOT send when no clients are viewing the session", () => {
		const deps = createMockSSEWiringDeps();
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		const translated: RelayMessage = { type: "delta", text: "hello" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "other-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.messageCache.recordEvent).toHaveBeenCalledWith(
			"other-session",
			translated,
		);
		expect(deps.wsHandler.sendToSession).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("clears processing timeout when done event arrives for a session", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = { type: "done", code: 0 };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.overrides.clearProcessingTimeout).toHaveBeenCalledWith(
			"active-session",
		);
	});

	it("clears processing timeout for done on any session (not just active)", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = { type: "done", code: 0 };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "other-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.overrides.clearProcessingTimeout).toHaveBeenCalledWith(
			"other-session",
		);
	});

	it("resets processing timeout on non-done events (inactivity timer)", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = { type: "delta", text: "hello" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.overrides.resetProcessingTimeout).toHaveBeenCalledWith(
			"active-session",
		);
		expect(deps.overrides.clearProcessingTimeout).not.toHaveBeenCalled();
	});

	it("does not reset processing timeout when no sessionID is present", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = { type: "delta", text: "hello" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: {},
		};
		handleSSEEvent(deps, event);

		expect(deps.overrides.resetProcessingTimeout).not.toHaveBeenCalled();
		expect(deps.overrides.clearProcessingTimeout).not.toHaveBeenCalled();
	});

	it("resets processing timeout on non-done events for active session", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = { type: "delta", text: "hello" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.overrides.resetProcessingTimeout).toHaveBeenCalled();
		expect(deps.overrides.clearProcessingTimeout).not.toHaveBeenCalled();
	});

	it("resets processing timeout on non-done events for any session (per-session timer)", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = { type: "delta", text: "hello" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "other-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.overrides.resetProcessingTimeout).toHaveBeenCalledWith(
			"other-session",
		);
		expect(deps.overrides.clearProcessingTimeout).not.toHaveBeenCalled();
	});

	it("resets processing timeout on retry events for active session", () => {
		const deps = createMockSSEWiringDeps();
		// Retry now produces only a single error message (no processing status)
		const messages: RelayMessage[] = [
			{ type: "error", code: "RETRY", message: "Retrying..." },
		];
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages,
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		// The error message should reset the timeout (it's not "done")
		expect(deps.overrides.resetProcessingTimeout).toHaveBeenCalledTimes(1);
		expect(deps.overrides.clearProcessingTimeout).not.toHaveBeenCalled();
	});

	it("does not reset processing timeout when no sessionID is present", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = { type: "delta", text: "hello" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: {},
		};
		handleSSEEvent(deps, event);

		expect(deps.overrides.resetProcessingTimeout).not.toHaveBeenCalled();
		expect(deps.overrides.clearProcessingTimeout).not.toHaveBeenCalled();
	});

	it("routes permission.asked events to permissionBridge", () => {
		const deps = createMockSSEWiringDeps();

		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: { id: "perm-1", permission: "Bash", tool: "Bash" },
		};
		handleSSEEvent(deps, event);

		expect(deps.permissionBridge.onPermissionRequest).toHaveBeenCalledWith(
			event,
		);
	});

	it("broadcast permission_request includes sessionId from the event", () => {
		const deps = createMockSSEWiringDeps();
		// Permission events now go through the bridge, not the translator
		vi.mocked(deps.permissionBridge.onPermissionRequest).mockReturnValue({
			requestId: pid("perm-1"),
			sessionId: "ses-abc",
			toolName: "Bash",
			toolInput: { patterns: [], metadata: {} },
			always: [],
			timestamp: Date.now(),
		});

		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: {
				id: "perm-1",
				permission: "Bash",
				sessionID: "ses-abc",
			},
		};
		handleSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				sessionId: "ses-abc",
			}),
		);
	});

	it("translates and routes question.asked events to the question's session", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = {
			type: "ask_user",
			toolId: "que_q1",
			questions: [],
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "question.asked",
			properties: { id: "q-1", questions: [], sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		// ask_user messages are routed to the question's session, not broadcast
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalledWith(translated);
	});

	it("routes permission.replied events to permissionBridge", () => {
		const deps = createMockSSEWiringDeps();

		const event: OpenCodeEvent = {
			type: "permission.replied",
			properties: { id: "perm-1" },
		};
		handleSSEEvent(deps, event);

		expect(deps.permissionBridge.onPermissionReplied).toHaveBeenCalledWith(
			"perm-1",
		);
	});

	it("does not record non-cacheable events to cache", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = {
			type: "file_changed",
			path: "/foo.ts",
			changeType: "edited",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "file.edited",
			properties: { sessionID: "active-session", file: "/foo.ts" },
		};
		handleSSEEvent(deps, event);

		expect(deps.messageCache.recordEvent).not.toHaveBeenCalled();
		// But it should still route to session viewers
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
	});

	it("suppresses relay-originated user_message echo when pending was recorded", () => {
		const deps = createMockSSEWiringDeps();
		// Simulate: relay sent a message via prompt handler → pending was recorded
		deps.pendingUserMessages.record("active-session", "Hello world");

		const translated: RelayMessage = {
			type: "user_message",
			text: "Hello world",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.created",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		// The user_message should be suppressed — NOT sent or cached
		expect(deps.wsHandler.sendToSession).not.toHaveBeenCalled();
		expect(deps.messageCache.recordEvent).not.toHaveBeenCalled();
	});

	it("allows TUI-originated user_message through when no pending was recorded", () => {
		const deps = createMockSSEWiringDeps();
		// No pendingUserMessages.record() call → message came from TUI/CLI

		const translated: RelayMessage = {
			type: "user_message",
			text: "Hello from TUI",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.created",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		// TUI-originated messages should pass through normally
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
		expect(deps.messageCache.recordEvent).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
	});

	it("does nothing when translator returns not ok", () => {
		const deps = createMockSSEWiringDeps();
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: false,
			reason: "mock skip",
		});

		const event: OpenCodeEvent = {
			type: "unknown.event",
			properties: {},
		};
		handleSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
		expect(deps.messageCache.recordEvent).not.toHaveBeenCalled();
	});

	it("handles array of translated messages", () => {
		const deps = createMockSSEWiringDeps();
		const messages: RelayMessage[] = [
			{ type: "tool_start", id: "call-1", name: "Bash" },
			{
				type: "tool_executing",
				id: "call-1",
				name: "Bash",
				input: { command: "ls" },
			},
		];
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages,
		});

		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.wsHandler.sendToSession).toHaveBeenCalledTimes(2);
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"active-session",
			messages[0],
		);
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"active-session",
			messages[1],
		);
		// Both are cacheable types
		expect(deps.messageCache.recordEvent).toHaveBeenCalledTimes(2);
	});

	it("does not cache or route events with no sessionID", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = { type: "delta", text: "hello" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: {}, // no sessionID
		};
		handleSSEEvent(deps, event);

		// No sessionID means we can't determine which session to cache/route to
		expect(deps.messageCache.recordEvent).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendToSession).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("broadcasts permission_request even when sessionID is missing from SSE event", () => {
		const deps = createMockSSEWiringDeps();
		// Mock the bridge to return a PendingPermission with the data
		vi.mocked(deps.permissionBridge.onPermissionRequest).mockReturnValue({
			requestId: pid("perm-1"),
			sessionId: "",
			toolName: "Bash",
			toolInput: { command: "git status" },
			always: [],
			timestamp: Date.now(),
		});

		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: {
				id: "perm-1",
				permission: "Bash",
				metadata: { command: "git status" },
			},
			// No sessionID!
		};
		handleSSEEvent(deps, event);

		// The permission MUST be broadcast even without sessionID
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				requestId: "perm-1",
				toolName: "Bash",
			}),
		);
	});

	it("broadcasts permission_request with sessionID when present in SSE event", () => {
		const deps = createMockSSEWiringDeps();
		vi.mocked(deps.permissionBridge.onPermissionRequest).mockReturnValue({
			requestId: pid("perm-2"),
			sessionId: "sess-abc",
			toolName: "Write",
			toolInput: { patterns: [], metadata: {} },
			always: [],
			timestamp: Date.now(),
		});

		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: {
				id: "perm-2",
				permission: "Write",
				sessionID: "sess-abc",
			},
		};
		handleSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				requestId: "perm-2",
				sessionId: "sess-abc",
				toolName: "Write",
			}),
		);
	});

	it("sends push notification for permission.asked", () => {
		const mockPush = {
			sendToAll: vi.fn().mockResolvedValue(undefined),
		} as unknown as NonNullable<SSEWiringDeps["pushManager"]>;
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });
		// Bridge returns a PendingPermission so the push path uses its data
		vi.mocked(deps.permissionBridge.onPermissionRequest).mockReturnValue({
			requestId: pid("perm-1"),
			sessionId: "",
			toolName: "Bash",
			toolInput: {},
			always: [],
			timestamp: Date.now(),
		});

		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: { id: "perm-1", permission: "Bash" },
		};
		handleSSEEvent(deps, event);

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(mockPush!.sendToAll).toHaveBeenCalledWith({
			type: "permission_request",
			title: "Permission Needed",
			body: "Bash needs approval",
			tag: "perm-perm-1",
			slug: "test-project",
			sessionId: "",
		});
	});

	it("sends push notification for question.asked", () => {
		const mockPush = {
			sendToAll: vi.fn().mockResolvedValue(undefined),
		} as unknown as NonNullable<SSEWiringDeps["pushManager"]>;
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });

		const event: OpenCodeEvent = {
			type: "question.asked",
			properties: { id: "q-1", questions: [] },
		};
		handleSSEEvent(deps, event);

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(mockPush!.sendToAll).toHaveBeenCalledWith({
			type: "ask_user",
			title: "Question from Agent",
			body: "Agent has a question for you.",
			tag: "opencode-ask",
			slug: "test-project",
		});
	});

	it("sends push notification for done events", () => {
		const mockPush = {
			sendToAll: vi.fn().mockResolvedValue(undefined),
		} as unknown as NonNullable<SSEWiringDeps["pushManager"]>;
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });
		const translated: RelayMessage = { type: "done", code: 0 };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(mockPush!.sendToAll).toHaveBeenCalledWith(
			expect.objectContaining({ type: "done", title: "Task Complete" }),
		);
	});

	it("sends push notification for error events", () => {
		const mockPush = {
			sendToAll: vi.fn().mockResolvedValue(undefined),
		} as unknown as NonNullable<SSEWiringDeps["pushManager"]>;
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });
		const translated: RelayMessage = {
			type: "error",
			code: "SEND_FAILED",
			message: "Something broke",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.error",
			properties: {
				sessionID: "active-session",
				error: { name: "err", data: { message: "Something broke" } },
			},
		};
		handleSSEEvent(deps, event);

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(mockPush!.sendToAll).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "error",
				title: "Error",
				body: "Something broke",
			}),
		);
	});

	it("sends push notification for done/error on ANY session (not just active)", () => {
		const mockPush = {
			sendToAll: vi.fn().mockResolvedValue(undefined),
		} as unknown as NonNullable<SSEWiringDeps["pushManager"]>;
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });
		const translated: RelayMessage = { type: "done", code: 0 };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "other-session" },
		};
		handleSSEEvent(deps, event);

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const calls = vi.mocked(mockPush!.sendToAll).mock.calls;
		const doneCalls = calls.filter(
			(c) => (c[0] as { type: string }).type === "done",
		);
		expect(doneCalls).toHaveLength(1);
	});

	it("calls notifySSEIdle on status poller when session.status:idle arrives", () => {
		const mockStatusPoller = { notifySSEIdle: vi.fn() };
		const deps = createMockSSEWiringDeps({ statusPoller: mockStatusPoller });
		// Translator returns ok: false for idle (no relay messages produced)
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: false,
			reason: "session status: unhandled status type",
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: {
				sessionID: "sess-123",
				status: { type: "idle" },
			},
		};
		handleSSEEvent(deps, event);

		expect(mockStatusPoller.notifySSEIdle).toHaveBeenCalledWith("sess-123");
	});

	it("does not call notifySSEIdle for session.status:busy", () => {
		const mockStatusPoller = { notifySSEIdle: vi.fn() };
		const deps = createMockSSEWiringDeps({ statusPoller: mockStatusPoller });
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: false,
			reason: "session status: unhandled status type",
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: {
				sessionID: "sess-123",
				status: { type: "busy" },
			},
		};
		handleSSEEvent(deps, event);

		expect(mockStatusPoller.notifySSEIdle).not.toHaveBeenCalled();
	});

	it("does not call notifySSEIdle when no statusPoller is configured", () => {
		const deps = createMockSSEWiringDeps();
		// No statusPoller in deps
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: false,
			reason: "session status: unhandled status type",
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: {
				sessionID: "sess-123",
				status: { type: "idle" },
			},
		};
		// Should not throw even without statusPoller
		expect(() => handleSSEEvent(deps, event)).not.toThrow();
	});
});

// ─── wireSSEConsumer ─────────────────────────────────────────────────────────

describe("wireSSEConsumer", () => {
	it("registers event listeners on consumer", () => {
		const deps = createMockSSEWiringDeps();
		const consumer = {
			on: vi.fn(),
		} as unknown as Parameters<typeof wireSSEConsumer>[1];

		wireSSEConsumer(deps, consumer);

		const registeredEvents = vi.mocked(consumer.on).mock.calls.map((c) => c[0]);
		expect(registeredEvents).toContain("connected");
		expect(registeredEvents).toContain("disconnected");
		expect(registeredEvents).toContain("reconnecting");
		expect(registeredEvents).toContain("error");
		expect(registeredEvents).toContain("event");
	});

	it("event listener delegates to handleSSEEvent", () => {
		const deps = createMockSSEWiringDeps();
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumer>[1];

		wireSSEConsumer(deps, consumer);

		const translated: RelayMessage = { type: "delta", text: "hi" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "active-session" },
		};
		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		listeners.get("event")!(event);

		expect(deps.translator.translate).toHaveBeenCalledWith(event, {
			sessionId: "active-session",
		});
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
	});

	it("logs SSE lifecycle events", () => {
		const infoSpy = vi.fn();
		const warnSpy = vi.fn();
		const log = { ...createSilentLogger(), info: infoSpy, warn: warnSpy };
		const deps = createMockSSEWiringDeps({ log });
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumer>[1];

		wireSSEConsumer(deps, consumer);

		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		listeners.get("connected")!();
		expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Connected"));

		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		listeners.get("disconnected")!(undefined);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Disconnected"),
		);

		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		listeners.get("reconnecting")!({ attempt: 3, delay: 5000 });
		expect(infoSpy).toHaveBeenCalledWith(
			expect.stringContaining("Reconnecting"),
		);
	});

	it("rehydrates pending permissions from API on SSE connect", async () => {
		const listPendingPermissions = vi.fn().mockResolvedValue([
			{
				id: "perm-recover-1",
				permission: "Bash",
				sessionID: "sess-x",
				patterns: ["git *"],
				metadata: { command: "git status" },
				always: ["git *"],
			},
		]);
		const deps = createMockSSEWiringDeps({ listPendingPermissions });
		// Mock recoverPending to return the recovered PendingPermission entries
		vi.mocked(deps.permissionBridge.recoverPending).mockReturnValue([
			{
				requestId: pid("perm-recover-1"),
				sessionId: "sess-x",
				toolName: "Bash",
				toolInput: { patterns: ["git *"], metadata: { command: "git status" } },
				always: ["git *"],
				timestamp: Date.now(),
			},
		]);
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumer>[1];

		wireSSEConsumer(deps, consumer);
		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		listeners.get("connected")!();

		// Wait for async rehydration
		await vi.waitFor(() => {
			expect(listPendingPermissions).toHaveBeenCalled();
		});

		// Should recover into bridge
		expect(deps.permissionBridge.recoverPending).toHaveBeenCalledWith([
			expect.objectContaining({
				id: "perm-recover-1",
				permission: "Bash",
				sessionId: "sess-x",
			}),
		]);

		// Should broadcast recovered permissions to all clients
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				requestId: "perm-recover-1",
				sessionId: "sess-x",
				toolName: "Bash",
			}),
		);
	});

	it("handles empty permission list from API on SSE connect", async () => {
		const listPendingPermissions = vi.fn().mockResolvedValue([]);
		const deps = createMockSSEWiringDeps({ listPendingPermissions });
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumer>[1];

		wireSSEConsumer(deps, consumer);
		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		listeners.get("connected")!();

		await vi.waitFor(() => {
			expect(listPendingPermissions).toHaveBeenCalled();
		});

		// Should not recover or broadcast anything
		expect(deps.permissionBridge.recoverPending).not.toHaveBeenCalled();
	});

	it("broadcasts connection_status 'connected' on connected event", () => {
		const deps = createMockSSEWiringDeps();
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumer>[1];

		wireSSEConsumer(deps, consumer);
		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		listeners.get("connected")!();

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "connection_status",
			status: "connected",
		});
	});

	it("broadcasts connection_status 'disconnected' on disconnected event", () => {
		const deps = createMockSSEWiringDeps();
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumer>[1];

		wireSSEConsumer(deps, consumer);
		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		listeners.get("disconnected")!(new Error("connection lost"));

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "connection_status",
			status: "disconnected",
		});
	});

	it("broadcasts connection_status 'reconnecting' on reconnecting event", () => {
		const deps = createMockSSEWiringDeps();
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const consumer = {
			on: vi.fn((name: string, fn: (...args: unknown[]) => void) => {
				listeners.set(name, fn);
			}),
		} as unknown as Parameters<typeof wireSSEConsumer>[1];

		wireSSEConsumer(deps, consumer);
		// biome-ignore lint/style/noNonNullAssertion: safe — Map.get after set
		listeners.get("reconnecting")!({ attempt: 1, delay: 1000 });

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "connection_status",
			status: "reconnecting",
		});
	});
});

// ─── tool_result truncation in SSE pipeline ─────────────────────────────────

describe("handleSSEEvent – tool_result truncation", () => {
	it("truncates tool_result over threshold before sending and caching", () => {
		const deps = createMockSSEWiringDeps();
		const largeContent = "x".repeat(TRUNCATION_THRESHOLD + 1000);
		const translated: RelayMessage = {
			type: "tool_result",
			id: "tool-1",
			content: largeContent,
			is_error: false,
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		// sendToSession should receive truncated content
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const sendArg = vi.mocked(deps.wsHandler.sendToSession).mock.calls[0]![1];
		expect(sendArg.type).toBe("tool_result");
		if (sendArg.type === "tool_result") {
			expect(sendArg.content.length).toBeLessThan(largeContent.length);
			expect(sendArg.isTruncated).toBe(true);
			expect(sendArg.fullContentLength).toBe(largeContent.length);
		}

		// Cache should also receive the truncated version
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const cacheArg = vi.mocked(deps.messageCache.recordEvent).mock.calls[0]![1];
		if (cacheArg.type === "tool_result") {
			expect(cacheArg.isTruncated).toBe(true);
		}
	});

	it("stores full content in toolContentStore when truncated", () => {
		const deps = createMockSSEWiringDeps();
		const largeContent = "x".repeat(TRUNCATION_THRESHOLD + 500);
		const translated: RelayMessage = {
			type: "tool_result",
			id: "tool-2",
			content: largeContent,
			is_error: false,
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.toolContentStore.get("tool-2")).toBe(largeContent);
	});

	it("passes through tool_result under threshold unchanged", () => {
		const deps = createMockSSEWiringDeps();
		const smallContent = "short result";
		const translated: RelayMessage = {
			type: "tool_result",
			id: "tool-3",
			content: smallContent,
			is_error: false,
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.updated",
			properties: { sessionID: "active-session" },
		};
		handleSSEEvent(deps, event);

		// sendToSession should receive original message unchanged
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"active-session",
			translated,
		);
		// Nothing stored in content store
		expect(deps.toolContentStore.get("tool-3")).toBeUndefined();
	});
});

// ─── Cross-session notification_event broadcast ──────────────────────────────
// When the pipeline drops a notification-worthy event (done, error) because no
// clients are viewing that session, the server should broadcast a
// notification_event so clients on other sessions can fire sound/browser alerts.

// ─── Notification routing through resolveNotifications (F2 wiring) ───────────
// Verifies that handleSSEEvent gates push and cross-session broadcast through
// resolveNotifications() — not inline logic. These tests exercise the REAL
// wiring path, not the policy function in isolation.

describe("notification routing: push gating via resolveNotifications", () => {
	it("does NOT call push for non-notification-worthy events (delta)", () => {
		const mockPush = {
			sendToAll: vi.fn().mockResolvedValue(undefined),
		} as unknown as NonNullable<SSEWiringDeps["pushManager"]>;
		const deps = createMockSSEWiringDeps({ pushManager: mockPush });
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [{ type: "delta", text: "hello" } as RelayMessage],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "s1" },
		};
		handleSSEEvent(deps, event);

		expect(mockPush.sendToAll).not.toHaveBeenCalled();
	});

	it("calls push for done event from root session (no parent)", () => {
		const mockPush = {
			sendToAll: vi.fn().mockResolvedValue(undefined),
		} as unknown as NonNullable<SSEWiringDeps["pushManager"]>;
		const deps = createMockSSEWiringDeps({
			pushManager: mockPush,
			getSessionParentMap: () => new Map(),
		});
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [{ type: "done", code: 0 } as RelayMessage],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "root-session" },
		};
		handleSSEEvent(deps, event);

		expect(mockPush.sendToAll).toHaveBeenCalled();
	});

	it("does NOT call push for done event from subagent session", () => {
		const mockPush = {
			sendToAll: vi.fn().mockResolvedValue(undefined),
		} as unknown as NonNullable<SSEWiringDeps["pushManager"]>;
		const deps = createMockSSEWiringDeps({
			pushManager: mockPush,
			getSessionParentMap: () => new Map([["child-session", "parent-session"]]),
		});
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [{ type: "done", code: 0 } as RelayMessage],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "child-session" },
		};
		handleSSEEvent(deps, event);

		expect(mockPush.sendToAll).not.toHaveBeenCalled();
	});

	it("does NOT broadcast cross-session notification for subagent done", () => {
		const deps = createMockSSEWiringDeps({
			getSessionParentMap: () => new Map([["child-session", "parent-session"]]),
		});
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [{ type: "done", code: 0 } as RelayMessage],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "child-session" },
		};
		handleSSEEvent(deps, event);

		const broadcastCalls = vi.mocked(deps.wsHandler.broadcast).mock.calls;
		const notifCalls = broadcastCalls.filter(
			(call) => (call[0] as RelayMessage).type === "notification_event",
		);
		expect(notifCalls).toHaveLength(0);
	});

	it("DOES call push for subagent error (errors always notify)", () => {
		const mockPush = {
			sendToAll: vi.fn().mockResolvedValue(undefined),
		} as unknown as NonNullable<SSEWiringDeps["pushManager"]>;
		const deps = createMockSSEWiringDeps({
			pushManager: mockPush,
			getSessionParentMap: () => new Map([["child-session", "parent-session"]]),
		});
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [
				{
					type: "error",
					code: "FATAL",
					message: "crashed",
				} as RelayMessage,
			],
		});

		const event: OpenCodeEvent = {
			type: "session.error",
			properties: { sessionID: "child-session" },
		};
		handleSSEEvent(deps, event);

		expect(mockPush.sendToAll).toHaveBeenCalled();
	});
});

describe("notification_event broadcast for dropped notification-worthy events", () => {
	it("broadcasts notification_event when done is dropped (no viewers)", () => {
		const deps = createMockSSEWiringDeps();
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		const translated: RelayMessage = { type: "done", code: 0 };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "other-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "notification_event",
			eventType: "done",
			sessionId: "other-session",
		});
	});

	it("broadcasts notification_event with message when error is dropped", () => {
		const deps = createMockSSEWiringDeps();
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		const translated: RelayMessage = {
			type: "error",
			code: "FATAL",
			message: "Something broke",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "other-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "notification_event",
			eventType: "error",
			message: "Something broke",
			sessionId: "other-session",
		});
	});

	it("does NOT broadcast notification_event when done is sent (has viewers)", () => {
		const deps = createMockSSEWiringDeps();
		// Has viewers — event is sent normally
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue(["c1"]);
		const translated: RelayMessage = { type: "done", code: 0 };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "session.status",
			properties: { sessionID: "my-session" },
		};
		handleSSEEvent(deps, event);

		// Should NOT broadcast notification_event — the event was sent to the session
		const broadcastCalls = vi.mocked(deps.wsHandler.broadcast).mock.calls;
		const notifCalls = broadcastCalls.filter(
			(call) => (call[0] as RelayMessage).type === "notification_event",
		);
		expect(notifCalls).toHaveLength(0);
	});

	it("does NOT broadcast notification_event for non-notification types (delta)", () => {
		const deps = createMockSSEWiringDeps();
		vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue([]);
		const translated: RelayMessage = { type: "delta", text: "hello" };
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "message.part.delta",
			properties: { sessionID: "other-session" },
		};
		handleSSEEvent(deps, event);

		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});
});
