// ─── Regression: Questions shown as "Answered" when viewing session ──────────
// Bug: When navigating to a session with a pending question, the question
// appears greyed out with "Answered ✓" instead of showing the interactive
// QuestionCard. The user cannot answer it, and the agent never gets a response.
//
// Root causes:
// 1. handleViewSession doesn't send pending questions for the viewed session
// 2. mapToolStatus forces "running" question tools to "completed" in history
//
// These tests reproduce the bug using TDD, then verify the fix.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryMessage } from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import {
	handleSwitchSession,
	handleViewSession,
} from "../../../src/lib/handlers/session.js";
import type { HandlerDeps } from "../../../src/lib/handlers/types.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

// ─── Server-side: handleViewSession should send pending questions ───────────

describe("handleViewSession — pending question delivery", () => {
	let deps: HandlerDeps;
	let sendToCalls: Array<{ clientId: string; msg: Record<string, unknown> }>;

	beforeEach(() => {
		sendToCalls = [];
		deps = createMockHandlerDeps({
			wsHandler: {
				broadcast: vi.fn(),
				sendTo: (clientId: string, msg: unknown) =>
					sendToCalls.push({ clientId, msg: msg as Record<string, unknown> }),
				setClientSession: vi.fn(),
				getClientSession: vi.fn(),
				getClientsForSession: vi.fn().mockReturnValue([]),
				sendToSession: vi.fn(),
			},
			client: {
				session: {
					get: vi.fn().mockResolvedValue({
						id: "ses_active",
						modelID: "claude-4",
						providerID: "anthropic",
					}),
				},
				question: {
					list: vi.fn().mockResolvedValue([
						{
							id: "que_abc123",
							questions: [
								{
									question: "Which option?",
									header: "Choose",
									options: [
										{ label: "Option A", description: "First option" },
										{ label: "Option B", description: "Second option" },
									],
									multiple: false,
									custom: true,
								},
							],
							tool: { callID: "toolu_xyz" },
							sessionID: "ses_active",
						},
					]),
				},
				permission: { list: vi.fn().mockResolvedValue([]) },
			} as unknown as HandlerDeps["client"],
			sessionMgr: {
				getDefaultSessionId: vi.fn().mockResolvedValue("ses_active"),
				loadPreRenderedHistory: vi.fn().mockResolvedValue({
					messages: [],
					hasMore: false,
					total: 0,
				}),
				sendDualSessionLists: vi.fn().mockResolvedValue(undefined),
			} as unknown as HandlerDeps["sessionMgr"],
			overrides: { clear: vi.fn() } as unknown as HandlerDeps["overrides"],
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(false),
			},
			log: createSilentLogger(),
		});
	});

	it("sends pending questions for the viewed session after session_switched", async () => {
		await handleViewSession(deps, "client-1", { sessionId: "ses_active" });

		// Should have sent ask_user messages for pending questions
		const askUserMsgs = sendToCalls.filter(
			(c) => c.clientId === "client-1" && c.msg["type"] === "ask_user",
		);
		expect(askUserMsgs).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(askUserMsgs[0]!.msg["toolId"]).toBe("que_abc123");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(askUserMsgs[0]!.msg["questions"]).toHaveLength(1);
	});

	it("sends ask_user AFTER session_switched (so clearAll doesn't wipe it)", async () => {
		await handleViewSession(deps, "client-1", { sessionId: "ses_active" });

		// Find the indices of session_switched and ask_user messages
		const switchedIdx = sendToCalls.findIndex(
			(c) => c.msg["type"] === "session_switched",
		);
		const askUserIdx = sendToCalls.findIndex(
			(c) => c.msg["type"] === "ask_user",
		);

		expect(switchedIdx).toBeGreaterThanOrEqual(0);
		expect(askUserIdx).toBeGreaterThanOrEqual(0);
		// ask_user must come AFTER session_switched
		expect(askUserIdx).toBeGreaterThan(switchedIdx);
	});

	it("only sends pending questions for the viewed session, not other sessions", async () => {
		// listPendingQuestions returns questions for multiple sessions
		// (the API returns all pending questions, not filtered by session)
		vi.mocked(deps.client.question.list).mockResolvedValue([
			{
				id: "que_this_session",
				questions: [
					{
						question: "Q1?",
						header: "H",
						options: [{ label: "A", description: "" }],
						multiple: false,
						custom: true,
					},
				],
				tool: { callID: "toolu_1" },
				sessionID: "ses_active",
			},
			{
				id: "que_other_session",
				questions: [
					{
						question: "Q2?",
						header: "H",
						options: [{ label: "B", description: "" }],
						multiple: false,
						custom: true,
					},
				],
				tool: { callID: "toolu_2" },
				sessionID: "ses_other",
			},
		]);

		await handleViewSession(deps, "client-1", { sessionId: "ses_active" });

		// Should call listPendingQuestions
		expect(deps.client.question.list).toHaveBeenCalled();

		// Only the question for ses_active should be sent, NOT the one for ses_other
		const askUserMsgs = sendToCalls.filter(
			(c) => c.clientId === "client-1" && c.msg["type"] === "ask_user",
		);
		expect(askUserMsgs).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(askUserMsgs[0]!.msg["toolId"]).toBe("que_this_session");
	});

	it("does not send questions when there are none pending", async () => {
		vi.mocked(deps.client.question.list).mockResolvedValue([]);

		await handleViewSession(deps, "client-1", { sessionId: "ses_active" });

		const askUserMsgs = sendToCalls.filter((c) => c.msg["type"] === "ask_user");
		expect(askUserMsgs).toHaveLength(0);
	});

	it("handleSwitchSession also sends pending questions (alias for handleViewSession)", async () => {
		await handleSwitchSession(deps, "client-1", { sessionId: "ses_active" });

		const askUserMsgs = sendToCalls.filter(
			(c) => c.clientId === "client-1" && c.msg["type"] === "ask_user",
		);
		expect(askUserMsgs).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(askUserMsgs[0]!.msg["toolId"]).toBe("que_abc123");
	});
});

// ─── Server-side: handleViewSession should send pending permissions ─────────

describe("handleViewSession — pending permission delivery", () => {
	let deps: HandlerDeps;
	let sendToCalls: Array<{ clientId: string; msg: Record<string, unknown> }>;

	beforeEach(() => {
		sendToCalls = [];
		deps = createMockHandlerDeps({
			wsHandler: {
				broadcast: vi.fn(),
				sendTo: (clientId: string, msg: unknown) =>
					sendToCalls.push({ clientId, msg: msg as Record<string, unknown> }),
				setClientSession: vi.fn(),
				getClientSession: vi.fn(),
				getClientsForSession: vi.fn().mockReturnValue([]),
				sendToSession: vi.fn(),
			},
			client: {
				session: {
					get: vi.fn().mockResolvedValue({
						id: "ses_active",
						modelID: "claude-4",
						providerID: "anthropic",
					}),
				},
				question: { list: vi.fn().mockResolvedValue([]) },
				permission: {
					list: vi.fn().mockResolvedValue([
						{
							id: "per_abc123",
							sessionID: "ses_active",
							permission: "external_directory",
							patterns: ["/tmp/mockups/*"],
							metadata: { filepath: "/tmp/mockups/screenshot.png" },
							always: ["/tmp/mockups/*"],
						},
					]),
				},
			} as unknown as HandlerDeps["client"],
			sessionMgr: {
				getDefaultSessionId: vi.fn().mockResolvedValue("ses_active"),
				loadPreRenderedHistory: vi.fn().mockResolvedValue({
					messages: [],
					hasMore: false,
					total: 0,
				}),
				listSessions: vi.fn().mockResolvedValue([]),
				sendDualSessionLists: vi.fn().mockResolvedValue(undefined),
			} as unknown as HandlerDeps["sessionMgr"],
			overrides: { clear: vi.fn() } as unknown as HandlerDeps["overrides"],
			permissionBridge: {
				getPending: vi.fn().mockReturnValue([]),
				onPermissionResponse: vi.fn(),
				onPermissionRequest: vi.fn(),
				onPermissionReplied: vi.fn(),
				checkTimeouts: vi.fn().mockReturnValue([]),
				recoverPending: vi.fn(),
			} as unknown as HandlerDeps["permissionBridge"],
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(false),
			},
			log: createSilentLogger(),
		});
	});

	it("sends pending permissions for the viewed session after session_switched", async () => {
		await handleViewSession(deps, "client-1", { sessionId: "ses_active" });

		const permMsgs = sendToCalls.filter(
			(c) =>
				c.clientId === "client-1" && c.msg["type"] === "permission_request",
		);
		expect(permMsgs).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(permMsgs[0]!.msg["requestId"]).toBe("per_abc123");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(permMsgs[0]!.msg["toolName"]).toBe("external_directory");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(permMsgs[0]!.msg["sessionId"]).toBe("ses_active");
	});

	it("sends permission_request AFTER session_switched (so clearSessionLocal doesn't wipe it)", async () => {
		await handleViewSession(deps, "client-1", { sessionId: "ses_active" });

		const switchedIdx = sendToCalls.findIndex(
			(c) => c.msg["type"] === "session_switched",
		);
		const permIdx = sendToCalls.findIndex(
			(c) => c.msg["type"] === "permission_request",
		);

		expect(switchedIdx).toBeGreaterThanOrEqual(0);
		expect(permIdx).toBeGreaterThanOrEqual(0);
		expect(permIdx).toBeGreaterThan(switchedIdx);
	});

	it("only sends permissions for the viewed session, not other sessions", async () => {
		vi.mocked(deps.client.permission.list).mockResolvedValue([
			{
				id: "per_this",
				permission: "external_directory",
				sessionID: "ses_active",
			},
			{
				id: "per_other",
				permission: "external_directory",
				sessionID: "ses_other",
			},
		] as Array<{ id: string; permission: string; [key: string]: unknown }>);

		await handleViewSession(deps, "client-1", { sessionId: "ses_active" });

		const permMsgs = sendToCalls.filter(
			(c) => c.msg["type"] === "permission_request",
		);
		expect(permMsgs).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(permMsgs[0]!.msg["requestId"]).toBe("per_this");
	});

	it("deduplicates bridge permissions against API permissions", async () => {
		// Bridge already has the permission in memory
		vi.mocked(deps.permissionBridge.getPending).mockReturnValue([
			{
				requestId:
					"per_abc123" as import("../../../src/lib/shared-types.js").PermissionId,
				sessionId: "ses_active",
				toolName: "external_directory",
				toolInput: { patterns: ["/tmp/*"] },
				always: [],
				timestamp: Date.now(),
			},
		]);
		// API also returns it
		vi.mocked(deps.client.permission.list).mockResolvedValue([
			{
				id: "per_abc123",
				permission: "external_directory",
				sessionID: "ses_active",
			},
		] as Array<{ id: string; permission: string; [key: string]: unknown }>);

		await handleViewSession(deps, "client-1", { sessionId: "ses_active" });

		const permMsgs = sendToCalls.filter(
			(c) => c.msg["type"] === "permission_request",
		);
		// Should only send once despite being in both bridge and API
		expect(permMsgs).toHaveLength(1);
	});

	it("handleSwitchSession also sends pending permissions", async () => {
		await handleSwitchSession(deps, "client-1", { sessionId: "ses_active" });

		const permMsgs = sendToCalls.filter(
			(c) =>
				c.clientId === "client-1" && c.msg["type"] === "permission_request",
		);
		expect(permMsgs).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(permMsgs[0]!.msg["requestId"]).toBe("per_abc123");
	});
});

// ─── History conversion: question tools should preserve running status ──────

describe("historyToChatMessages — question tool status preservation", () => {
	/** Helper: create a HistoryMessage with a single tool part */
	function toolMsg(
		tool: string,
		state: Record<string, unknown>,
	): HistoryMessage[] {
		return [
			{
				id: "m1",
				role: "assistant",
				parts: [
					{
						id: "p1",
						type: "tool",
						tool,
						callID: "toolu_abc",
						state,
					},
				],
			},
		];
	}

	it("preserves 'running' status for question tools (not forced to 'completed')", () => {
		const messages = toolMsg("question", {
			status: "running",
			input: {
				questions: [
					{
						question: "Which option?",
						header: "Choose",
						options: [{ label: "A" }, { label: "B" }],
						multiple: false,
					},
				],
			},
		});

		const result = historyToChatMessages(messages);
		const toolMsgs = result.filter((m) => m.type === "tool");

		expect(toolMsgs).toHaveLength(1);
		// The question tool should NOT be forced to "completed" — it's still running
		expect(toolMsgs[0]).toMatchObject({
			type: "tool",
			name: "AskUserQuestion",
			status: "running",
		});
	});

	it("still maps completed question tools to 'completed'", () => {
		const messages = toolMsg("question", {
			status: "completed",
			output: '{"0": "Option A"}',
		});

		const result = historyToChatMessages(messages);
		const toolMsgs = result.filter((m) => m.type === "tool");

		expect(toolMsgs[0]).toMatchObject({ status: "completed" });
	});

	it("still maps errored question tools to 'error'", () => {
		const messages = toolMsg("question", {
			status: "error",
			error: "User skipped the question",
		});

		const result = historyToChatMessages(messages);
		const toolMsgs = result.filter((m) => m.type === "tool");

		expect(toolMsgs[0]).toMatchObject({ status: "error", isError: true });
	});

	it("non-question tools with 'running' status are still mapped to 'completed' (historical behaviour)", () => {
		const messages = toolMsg("Bash", { status: "running" });

		const result = historyToChatMessages(messages);
		const toolMsgs = result.filter((m) => m.type === "tool");

		// Non-question tools in history should still be mapped to "completed"
		expect(toolMsgs[0]).toMatchObject({ status: "completed" });
	});
});
