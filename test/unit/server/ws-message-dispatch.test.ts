import { seedSessions } from "../stores/session-fixtures.js";
// Gap 1: handleToolContentResponse — tool_content message updates chat state
// Gap 2: connection_status → stored OpenCode connection status
//
// Tests the handleMessage() dispatch for two message types that previously
// had zero test coverage.

import {
	afterEach,
	assert,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// Hoisted mocks (run before imports)

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
			const listeners = this.listeners[event];
			assert.exists(listeners, "expected event listeners");
			listeners.push(fn);
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
	uiState: { opencodeConnectionStatus: null },
	showToast: showToastMock,
	showBanner: showBannerMock,
	removeBanner: removeBannerMock,
	setClientCount: vi.fn(),
}));

import {
	chatState,
	clearMessages,
	inputSyncState,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { getBrowserClientId } from "../../../src/lib/frontend/stores/client-identity.js";
import {
	clearInstanceState,
	instanceState,
} from "../../../src/lib/frontend/stores/instance.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws.svelte.js";
import { applyToolContentResponse } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import type { ToolMessage } from "../../../src/lib/frontend/types.js";
import { testActivity, testMessages } from "../../helpers/test-session-slot.js";

let _ta: SessionActivity;
let tm: SessionMessages;

beforeEach(() => {
	clearMessages();
	// Set currentId and register session BEFORE creating test slots,
	// so testActivity()/testMessages() register under the correct key ("s1").
	seedSessions([
		...sessionState.sessions.values(),
		{ id: "s1", title: "", status: "idle" },
	]);
	sessionState.currentId = "s1";
	_ta = testActivity();
	tm = testMessages();
	clearInstanceState();
	inputSyncState.text = "";
	inputSyncState.lastFrom = "";
	inputSyncState.lastUpdated = 0;
	showBannerMock.mockClear();
	removeBannerMock.mockClear();
	showToastMock.mockClear();
	uiState.opencodeConnectionStatus = null;
});

afterEach(() => {
	clearMessages();
	_ta = testActivity();
	tm = testMessages();
	clearInstanceState();
	inputSyncState.text = "";
	inputSyncState.lastFrom = "";
	inputSyncState.lastUpdated = 0;
});

// Gap 1: handleToolContentResponse (AC5)

describe("handleToolContentResponse via handleMessage (AC5)", () => {
	/** Helper: set up a tool message with truncated result */
	function seedTruncatedTool(
		toolId: string,
		toolName: string,
		opts?: { messageId?: string },
	): void {
		tm.messages = [
			...tm.messages,
			{
				type: "tool",
				uuid: `s1/${toolId}`,
				id: toolId,
				name: toolName,
				status: "completed",
				result: "truncated output…",
				isTruncated: true,
				fullContentLength: 50_000,
				...(opts?.messageId != null && { messageId: opts.messageId }),
			},
		];
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

	it("applies RPC tool content to the current session", () => {
		seedTruncatedTool("tool-rpc", "bash");
		sessionState.currentId = "s1";

		applyToolContentResponse({
			projectSlug: "demo",
			toolId: "tool-rpc",
			content: "full rpc output",
		});

		const toolMsg = chatState.messages.find(
			(m) => m.type === "tool" && (m as ToolMessage).id === "tool-rpc",
		) as ToolMessage;

		expect(toolMsg.result).toBe("full rpc output");
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

describe("input_sync dispatch", () => {
	it("ignores draft echoes from this browser tab", () => {
		inputSyncState.text = "before";
		inputSyncState.lastUpdated = 10;

		handleMessage({
			type: "input_sync",
			text: "self echo",
			from: getBrowserClientId(),
		});

		expect(inputSyncState.text).toBe("before");
		expect(inputSyncState.lastUpdated).toBe(10);
	});

	it("applies drafts from another browser tab", () => {
		handleMessage({
			type: "input_sync",
			text: "other tab draft",
			from: "browser-tab-b",
		});

		expect(inputSyncState.text).toBe("other tab draft");
		expect(inputSyncState.lastFrom).toBe("browser-tab-b");
		expect(inputSyncState.lastUpdated).toBeGreaterThan(0);
	});
});

// Gap 2: connection_status → stored status (AC1/AC2)

describe("connection_status via handleMessage (AC1/AC2)", () => {
	it("stores disconnected status without showing an ungated banner", () => {
		handleMessage({
			type: "connection_status",
			status: "disconnected",
		});

		expect(uiState.opencodeConnectionStatus).toBe("disconnected");
		expect(showBannerMock).not.toHaveBeenCalled();
	});

	it("stores reconnecting status without showing an ungated banner", () => {
		handleMessage({
			type: "connection_status",
			status: "reconnecting",
		});

		expect(uiState.opencodeConnectionStatus).toBe("reconnecting");
		expect(showBannerMock).not.toHaveBeenCalled();
	});

	it("stores connected status without directly changing banners", () => {
		handleMessage({
			type: "connection_status",
			status: "connected",
		});

		expect(uiState.opencodeConnectionStatus).toBe("connected");
		expect(removeBannerMock).not.toHaveBeenCalled();
		expect(showBannerMock).not.toHaveBeenCalled();
	});

	it("replaces disconnected status with reconnecting", () => {
		handleMessage({
			type: "connection_status",
			status: "disconnected",
		});
		expect(uiState.opencodeConnectionStatus).toBe("disconnected");

		handleMessage({
			type: "connection_status",
			status: "reconnecting",
		});

		expect(uiState.opencodeConnectionStatus).toBe("reconnecting");
	});

	it("handles full lifecycle: connected → disconnected → reconnecting → connected", () => {
		handleMessage({ type: "connection_status", status: "connected" });
		expect(uiState.opencodeConnectionStatus).toBe("connected");

		handleMessage({ type: "connection_status", status: "disconnected" });
		expect(uiState.opencodeConnectionStatus).toBe("disconnected");

		handleMessage({
			type: "connection_status",
			status: "reconnecting",
		});
		expect(uiState.opencodeConnectionStatus).toBe("reconnecting");

		handleMessage({ type: "connection_status", status: "connected" });
		expect(uiState.opencodeConnectionStatus).toBe("connected");
		expect(removeBannerMock).not.toHaveBeenCalled();
		expect(showBannerMock).not.toHaveBeenCalled();
	});
});

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
			const instance = msg.instances[0];
			assert.exists(instance, "expected instance");
			expect(instance.id).toBe("personal");
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
		const personal = instanceState.instances[0];
		const work = instanceState.instances[1];
		assert.exists(personal, "expected personal instance");
		assert.exists(work, "expected work instance");
		expect(personal.id).toBe("personal");
		expect(work.id).toBe("work");
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

		const personal = instanceState.instances[0];
		assert.exists(personal, "expected personal instance");
		expect(personal.status).toBe("healthy");

		// Now dispatch a status update
		handleMessage({
			type: "instance_status",
			instanceId: "personal",
			status: "unhealthy",
		});

		const updatedPersonal = instanceState.instances[0];
		assert.exists(updatedPersonal, "expected personal instance");
		expect(updatedPersonal.status).toBe("unhealthy");
	});
});

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
