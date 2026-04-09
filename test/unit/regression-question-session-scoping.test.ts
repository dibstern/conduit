// ─── Regression: Questions leaking across sessions ───────────────────────────
// Bug: Questions from one session appear in all sessions because:
//   1. handleViewSession sends ALL pending questions from the API, not just
//      those for the viewed session
//   2. Live SSE ask_user events are broadcast() to all clients instead of
//      being routed to the question's session via sendToSession()
//   3. client-init sends ALL pending questions on connect regardless of which
//      session the client is viewing
//
// These tests reproduce the bug and verify the fix at all three sites.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleClientConnected } from "../../src/lib/bridges/client-init.js";
import { handleViewSession } from "../../src/lib/handlers/session.js";
import type { HandlerDeps } from "../../src/lib/handlers/types.js";
import { createSilentLogger } from "../../src/lib/logger.js";
import { handleSSEEvent } from "../../src/lib/relay/sse-wiring.js";
import type { PermissionId } from "../../src/lib/shared-types.js";
import type { OpenCodeEvent, RelayMessage } from "../../src/lib/types.js";
import {
	createMockClientInitDeps,
	createMockHandlerDeps,
	createMockSSEWiringDeps,
} from "../helpers/mock-factories.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a pending question API response object */
function makePendingQuestion(id: string, sessionID: string) {
	return {
		id,
		questions: [
			{
				question: `Question from ${sessionID}?`,
				header: "Choose",
				options: [{ label: "Yes", description: "" }],
				multiple: false,
				custom: true,
			},
		],
		tool: { callID: `toolu_${id}` },
		sessionID,
	};
}

// ─── 1. handleViewSession: filter by viewed session ──────────────────────────

describe("Regression: handleViewSession only sends questions for viewed session", () => {
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
				getSession: vi.fn().mockResolvedValue({
					id: "ses_A",
					modelID: "claude-4",
					providerID: "anthropic",
				}),
				listPendingQuestions: vi
					.fn()
					.mockResolvedValue([
						makePendingQuestion("que_A1", "ses_A"),
						makePendingQuestion("que_B1", "ses_B"),
						makePendingQuestion("que_A2", "ses_A"),
					]),
			} as unknown as HandlerDeps["client"],
			sessionMgr: {
				getDefaultSessionId: vi.fn().mockResolvedValue("ses_A"),
				sendDualSessionLists: vi.fn().mockResolvedValue(undefined),
				loadPreRenderedHistory: vi.fn().mockResolvedValue({
					messages: [],
					hasMore: false,
					total: 0,
				}),
			} as unknown as HandlerDeps["sessionMgr"],
			overrides: { clear: vi.fn() } as unknown as HandlerDeps["overrides"],
			statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
			log: createSilentLogger(),
		});
	});

	it("sends only questions belonging to ses_A when viewing ses_A", async () => {
		await handleViewSession(deps, "client-1", { sessionId: "ses_A" });

		const askUserMsgs = sendToCalls.filter(
			(c) => c.clientId === "client-1" && c.msg["type"] === "ask_user",
		);

		// Should send the 2 questions for ses_A, NOT the 1 for ses_B
		expect(askUserMsgs).toHaveLength(2);
		const toolIds = askUserMsgs.map((m) => m.msg["toolId"]);
		expect(toolIds).toContain("que_A1");
		expect(toolIds).toContain("que_A2");
		expect(toolIds).not.toContain("que_B1");
	});

	it("sends zero questions when viewing a session with none pending", async () => {
		await handleViewSession(deps, "client-1", { sessionId: "ses_C" });

		const askUserMsgs = sendToCalls.filter(
			(c) => c.clientId === "client-1" && c.msg["type"] === "ask_user",
		);
		expect(askUserMsgs).toHaveLength(0);
	});
});

// ─── 2. Live SSE: ask_user routed to session, not broadcast ──────────────────

describe("Regression: SSE ask_user events routed to session, not broadcast", () => {
	it("routes ask_user to the question's session via sendToSession", () => {
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
			properties: { id: "q-1", questions: [], sessionID: "ses_target" },
		};
		handleSSEEvent(deps, event);

		// Must use sendToSession, NOT broadcast
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses_target",
			translated,
		);
		// broadcast must NOT have been called with the ask_user message
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalledWith(translated);
	});

	it("routes ask_user_resolved to the session, not broadcast", () => {
		const deps = createMockSSEWiringDeps();
		const translated: RelayMessage = {
			type: "ask_user_resolved",
			toolId: "que_q1",
		};
		vi.mocked(deps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const event: OpenCodeEvent = {
			type: "question.answered",
			properties: { id: "q-1", sessionID: "ses_target" },
		};
		handleSSEEvent(deps, event);

		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses_target",
			translated,
		);
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalledWith(translated);
	});

	it("still broadcasts permission_request to all clients (not session-scoped)", () => {
		const deps = createMockSSEWiringDeps();
		// Permission events now go through the bridge, not the translator
		vi.mocked(deps.permissionBridge.onPermissionRequest).mockReturnValue({
			requestId: "perm-1" as PermissionId,
			sessionId: "ses_target",
			toolName: "Write",
			toolInput: {},
			always: [],
			timestamp: Date.now(),
		});

		const event: OpenCodeEvent = {
			type: "permission.asked",
			properties: {
				id: "perm-1",
				permission: "Write",
				sessionID: "ses_target",
			},
		};
		handleSSEEvent(deps, event);

		// Permissions ARE still broadcast (they're not session-scoped)
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "permission_request",
				requestId: "perm-1",
				sessionId: "ses_target",
				toolName: "Write",
			}),
		);
	});
});

// ─── 3. client-init: filter questions by active session ──────────────────────

describe("Regression: client-init only sends questions for the client's active session", () => {
	it("filters out questions from other sessions on initial connect", async () => {
		const deps = createMockClientInitDeps();
		// Default activeId from mock is "session-1"
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([
			makePendingQuestion("que_mine", "session-1"),
			makePendingQuestion("que_other", "session-OTHER"),
			makePendingQuestion("que_mine2", "session-1"),
		]);

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const askCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "ask_user",
		);

		// Should send 2 questions for session-1, NOT the 1 for session-OTHER
		expect(askCalls).toHaveLength(2);
		const toolIds = askCalls.map((c) => (c[1] as { toolId: string }).toolId);
		expect(toolIds).toContain("que_mine");
		expect(toolIds).toContain("que_mine2");
		expect(toolIds).not.toContain("que_other");
	});

	it("sends questions with no sessionID (defensive — treats as matching)", async () => {
		const deps = createMockClientInitDeps();
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([
			{
				id: "que_no_session",
				questions: [
					{
						question: "Q?",
						header: "H",
						options: [],
						multiple: false,
						custom: true,
					},
				],
			},
			makePendingQuestion("que_other", "session-OTHER"),
		]);

		await handleClientConnected(deps, "client-1");

		const sendToCalls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const askCalls = sendToCalls.filter(
			(c) => (c[1] as { type: string }).type === "ask_user",
		);

		// Question without sessionID should be sent (defensive), other-session should not
		expect(askCalls).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((askCalls[0]![1] as { toolId: string }).toolId).toBe(
			"que_no_session",
		);
	});
});
