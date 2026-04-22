// ─── WS Message Dispatch Tests ───────────────────────────────────────────────
// Gap 1: handleToolContentResponse — tool_content message updates chat state
// Gap 2: handleConnectionStatus — connection_status → banner lifecycle
//
// Tests the handleMessage() dispatch for two message types that previously
// had zero test coverage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks (run before imports) ─────────────────────────────────────

const { showBannerMock, removeBannerMock, showToastMock } = vi.hoisted(() => {
	const showBannerMock = vi.fn();
	const removeBannerMock = vi.fn();
	const showToastMock = vi.fn();

	// Minimal WebSocket mock — connect() needs a constructor
	class MockWebSocket {
		static readonly OPEN = 1;
		static readonly CLOSED = 3;
		readyState = MockWebSocket.OPEN;
		private listeners: Record<string, Array<(ev?: unknown) => void>> = {};

		send(_data: string): void {}

		addEventListener(event: string, fn: (ev?: unknown) => void): void {
			if (!this.listeners[event]) this.listeners[event] = [];
			// biome-ignore lint/style/noNonNullAssertion: safe — initialized in test setup
			this.listeners[event]!.push(fn);
		}

		close(): void {
			this.readyState = MockWebSocket.CLOSED;
		}
	}

	Object.defineProperty(globalThis, "WebSocket", {
		value: MockWebSocket,
		writable: true,
		configurable: true,
	});

	if (typeof globalThis.window === "undefined") {
		Object.defineProperty(globalThis, "window", {
			value: {
				location: { protocol: "http:", host: "localhost:3000", pathname: "/" },
				history: { pushState: () => {}, replaceState: () => {} },
				addEventListener: () => {},
			},
			writable: true,
			configurable: true,
		});
	}

	return { showBannerMock, removeBannerMock, showToastMock };
});

// Mock DOMPurify (required by chat.svelte.ts → markdown.ts)
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

// Mock ui.svelte.js to capture showBanner/removeBanner calls
vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: showToastMock,
	showBanner: showBannerMock,
	removeBanner: removeBannerMock,
	setClientCount: vi.fn(),
}));

import {
	chatState,
	clearMessages,
	handleToolStart,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	clearInstanceState,
	instanceState,
} from "../../../src/lib/frontend/stores/instance.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";
import type { ToolMessage } from "../../../src/lib/frontend/types.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

// ─── Setup / Teardown ───────────────────────────────────────────────────────

// ─── Per-session tiers for handler calls ────────────────────────────────────
let ta: SessionActivity;
let tm: SessionMessages;

beforeEach(() => {
	clearMessages();
	// Set currentId and register session BEFORE creating test slots,
	// so testActivity()/testMessages() register under the correct key ("s1").
	sessionState.sessions.set("s1", { id: "s1", title: "" });
	sessionState.currentId = "s1";
	ta = testActivity();
	tm = testMessages();
	clearInstanceState();
	showBannerMock.mockClear();
	removeBannerMock.mockClear();
	showToastMock.mockClear();
});

afterEach(() => {
	clearMessages();
	ta = testActivity();
	tm = testMessages();
	clearInstanceState();
});

// ─── Gap 1: handleToolContentResponse (AC5) ─────────────────────────────────

describe("handleToolContentResponse via handleMessage (AC5)", () => {
	/** Helper: set up a tool message with truncated result */
	function seedTruncatedTool(
		toolId: string,
		toolName: string,
		opts?: { messageId?: string },
	): void {
		handleToolStart(ta, tm, {
			type: "tool_start",
			sessionId: "s1",
			id: toolId,
			name: toolName,
		});

		// Manually update to "completed" with truncated result
		const messages = [...chatState.messages];
		const idx = messages.findIndex(
			(m) => m.type === "tool" && (m as ToolMessage).id === toolId,
		);
		if (idx >= 0) {
			messages[idx] = {
				...(messages[idx] as ToolMessage),
				status: "completed",
				result: "truncated output…",
				isTruncated: true,
				fullContentLength: 50_000,
				...(opts?.messageId != null && { messageId: opts.messageId }),
			};
			chatState.messages = messages;
			tm.messages = messages;
		}
	}

	it("replaces truncated tool result with full content", () => {
		seedTruncatedTool("tool-1", "bash");

		handleMessage({
			type: "tool_content",
			sessionId: "s1",
			toolId: "tool-1",
			content: "full output here — all 50,000 chars",
		});

		const toolMsg = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-1",
		) as ToolMessage;

		expect(toolMsg).toBeDefined();
		expect(toolMsg.result).toBe("full output here — all 50,000 chars");
		expect(toolMsg.isTruncated).toBe(false);
		expect(toolMsg.fullContentLength).toBeUndefined();
	});

	it("is a no-op for unknown toolId", () => {
		seedTruncatedTool("tool-1", "bash");
		const messagesBefore = chatState.messages.map((m) => ({ ...m }));

		handleMessage({
			type: "tool_content",
			sessionId: "s1",
			toolId: "nonexistent-tool",
			content: "should be ignored",
		});

		// Tool-1 should be unchanged
		const toolMsg = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-1",
		) as ToolMessage;
		expect(toolMsg.result).toBe("truncated output…");
		expect(toolMsg.isTruncated).toBe(true);
		expect(toolMsg.fullContentLength).toBe(50_000);
		expect(chatState.messages).toHaveLength(messagesBefore.length);
	});

	it("preserves other tool message fields when updating", () => {
		seedTruncatedTool("tool-2", "file_read", { messageId: "msg-123" });

		handleMessage({
			type: "tool_content",
			sessionId: "s1",
			toolId: "tool-2",
			content: "full file contents",
		});

		const updated = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-2",
		) as ToolMessage;

		expect(updated.name).toBe("file_read");
		expect(updated.status).toBe("completed");
		expect(updated.messageId).toBe("msg-123");
		expect(updated.result).toBe("full file contents");
		expect(updated.isTruncated).toBe(false);
		expect(updated.fullContentLength).toBeUndefined();
	});

	it("does not affect other messages in the array", () => {
		// Seed two tool messages
		seedTruncatedTool("tool-a", "bash");
		seedTruncatedTool("tool-b", "grep");

		// Only update tool-a
		handleMessage({
			type: "tool_content",
			sessionId: "s1",
			toolId: "tool-a",
			content: "full-a",
		});

		const toolA = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-a",
		) as ToolMessage;
		const toolB = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-b",
		) as ToolMessage;

		expect(toolA.result).toBe("full-a");
		expect(toolA.isTruncated).toBe(false);
		// tool-b should still be truncated
		expect(toolB.result).toBe("truncated output…");
		expect(toolB.isTruncated).toBe(true);
	});
});

// ─── Gap 2: connection_status → banner lifecycle (AC1/AC2) ──────────────────

describe("handleConnectionStatus via handleMessage (AC1/AC2)", () => {
	it("shows warning banner on disconnected status", () => {
		handleMessage({
			type: "connection_status",
			status: "disconnected",
		});

		expect(showBannerMock).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "opencode-connection-status",
				variant: "warning",
				text: "OpenCode server disconnected",
				dismissible: false,
			}),
		);
	});

	it("shows reconnecting banner text", () => {
		handleMessage({
			type: "connection_status",
			status: "reconnecting",
		});

		expect(showBannerMock).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "opencode-connection-status",
				text: "Reconnecting to OpenCode…",
			}),
		);
	});

	it("removes banner on connected status without showing a new one", () => {
		handleMessage({
			type: "connection_status",
			status: "connected",
		});

		expect(removeBannerMock).toHaveBeenCalledWith("opencode-connection-status");
		expect(showBannerMock).not.toHaveBeenCalled();
	});

	it("updates banner text when transitioning from disconnected to reconnecting", () => {
		handleMessage({
			type: "connection_status",
			status: "disconnected",
		});
		expect(showBannerMock).toHaveBeenCalledWith(
			expect.objectContaining({ text: "OpenCode server disconnected" }),
		);

		showBannerMock.mockClear();
		removeBannerMock.mockClear();

		handleMessage({
			type: "connection_status",
			status: "reconnecting",
		});

		// Should remove old banner first, then show with updated text
		expect(removeBannerMock).toHaveBeenCalledWith("opencode-connection-status");
		expect(showBannerMock).toHaveBeenCalledWith(
			expect.objectContaining({ text: "Reconnecting to OpenCode…" }),
		);
	});

	it("handles full lifecycle: connected → disconnected → reconnecting → connected", () => {
		// 1. connected — removes (nothing to remove, but idempotent)
		handleMessage({ type: "connection_status", status: "connected" });
		expect(removeBannerMock).toHaveBeenCalledTimes(1);
		expect(showBannerMock).not.toHaveBeenCalled();

		removeBannerMock.mockClear();
		showBannerMock.mockClear();

		// 2. disconnected — remove + show warning
		handleMessage({ type: "connection_status", status: "disconnected" });
		expect(removeBannerMock).toHaveBeenCalledWith("opencode-connection-status");
		expect(showBannerMock).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "OpenCode server disconnected",
				variant: "warning",
			}),
		);

		removeBannerMock.mockClear();
		showBannerMock.mockClear();

		// 3. reconnecting — remove + show reconnecting
		handleMessage({
			type: "connection_status",
			status: "reconnecting",
		});
		expect(removeBannerMock).toHaveBeenCalledWith("opencode-connection-status");
		expect(showBannerMock).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "Reconnecting to OpenCode…",
			}),
		);

		removeBannerMock.mockClear();
		showBannerMock.mockClear();

		// 4. connected — removes banner, no new show
		handleMessage({ type: "connection_status", status: "connected" });
		expect(removeBannerMock).toHaveBeenCalledWith("opencode-connection-status");
		expect(showBannerMock).not.toHaveBeenCalled();
	});
});

// ─── Instance messages ──────────────────────────────────────────────────────

describe("instance messages", () => {
	it("instance_list is a valid RelayMessage type", () => {
		const msg: import("../../../src/lib/shared-types.js").RelayMessage = {
			type: "instance_list",
			instances: [],
		};
		expect(msg.type).toBe("instance_list");
	});

	it("instance_list carries instances array", () => {
		const msg: import("../../../src/lib/shared-types.js").RelayMessage = {
			type: "instance_list",
			instances: [
				{
					id: "personal",
					name: "Personal",
					port: 4096,
					managed: true,
					status: "healthy",
					restartCount: 0,
					createdAt: Date.now(),
				},
			],
		};
		expect(msg.type).toBe("instance_list");
		if (msg.type === "instance_list") {
			expect(msg.instances).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(msg.instances[0]!.id).toBe("personal");
		}
	});

	it("instance_status is a valid RelayMessage type", () => {
		const msg: import("../../../src/lib/shared-types.js").RelayMessage = {
			type: "instance_status",
			instanceId: "personal",
			status: "healthy",
		};
		expect(msg.type).toBe("instance_status");
		if (msg.type === "instance_status") {
			expect(msg.instanceId).toBe("personal");
			expect(msg.status).toBe("healthy");
		}
	});

	it("instance_status supports all status values", () => {
		const statuses: import("../../../src/lib/shared-types.js").InstanceStatus[] =
			["starting", "healthy", "unhealthy", "stopped"];
		for (const status of statuses) {
			const msg: import("../../../src/lib/shared-types.js").RelayMessage = {
				type: "instance_status",
				instanceId: "test",
				status,
			};
			expect(msg.type).toBe("instance_status");
		}
	});

	// ─── Behavioral dispatch tests ────────────────────────────────────────────

	it("receiving instance_list message populates instanceState via handleMessage", () => {
		handleMessage({
			type: "instance_list",
			instances: [
				{
					id: "personal",
					name: "Personal",
					port: 4096,
					managed: true,
					status: "healthy",
					restartCount: 0,
					createdAt: Date.now(),
				},
				{
					id: "work",
					name: "Work",
					port: 4097,
					managed: true,
					status: "stopped",
					restartCount: 0,
					createdAt: Date.now(),
				},
			],
		});

		expect(instanceState.instances).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(instanceState.instances[0]!.id).toBe("personal");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(instanceState.instances[1]!.id).toBe("work");
	});

	it("receiving instance_status message updates instance status via handleMessage", () => {
		// Seed the store with an initial list
		handleMessage({
			type: "instance_list",
			instances: [
				{
					id: "personal",
					name: "Personal",
					port: 4096,
					managed: true,
					status: "healthy",
					restartCount: 0,
					createdAt: Date.now(),
				},
			],
		});

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(instanceState.instances[0]!.status).toBe("healthy");

		// Now dispatch a status update
		handleMessage({
			type: "instance_status",
			instanceId: "personal",
			status: "unhealthy",
		});

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(instanceState.instances[0]!.status).toBe("unhealthy");
	});
});

// ─── Instance WS message contracts ──────────────────────────────────────────

describe("instance WS message contracts", () => {
	it("instance_list message matches store handler expectation", () => {
		const msg = {
			type: "instance_list" as const,
			instances: [
				{
					id: "test",
					name: "Test",
					port: 3000,
					managed: true,
					status: "healthy" as const,
					restartCount: 0,
					createdAt: Date.now(),
				},
			],
		};
		handleMessage(msg);
		expect(instanceState.instances).toHaveLength(1);
		expect(instanceState.instances[0]).toMatchObject({
			id: "test",
			name: "Test",
			status: "healthy",
		});
	});

	it("instance_status message updates the correct instance", () => {
		// Pre-populate
		handleMessage({
			type: "instance_list",
			instances: [
				{
					id: "a",
					name: "A",
					port: 1,
					managed: true,
					status: "healthy" as const,
					restartCount: 0,
					createdAt: 1,
				},
				{
					id: "b",
					name: "B",
					port: 2,
					managed: true,
					status: "stopped" as const,
					restartCount: 0,
					createdAt: 2,
				},
			],
		});

		handleMessage({
			type: "instance_status",
			instanceId: "b",
			status: "starting",
		});

		expect(instanceState.instances.find((i) => i.id === "b")?.status).toBe(
			"starting",
		);
		// 'a' unchanged
		expect(instanceState.instances.find((i) => i.id === "a")?.status).toBe(
			"healthy",
		);
	});

	it("instance_status for unknown instance is a no-op", () => {
		handleMessage({
			type: "instance_list",
			instances: [
				{
					id: "a",
					name: "A",
					port: 1,
					managed: true,
					status: "healthy" as const,
					restartCount: 0,
					createdAt: 1,
				},
			],
		});

		handleMessage({
			type: "instance_status",
			instanceId: "nonexistent",
			status: "stopped",
		});

		expect(instanceState.instances).toHaveLength(1);
		expect(instanceState.instances[0]?.status).toBe("healthy");
	});
});
