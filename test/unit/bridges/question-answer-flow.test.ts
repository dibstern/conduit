// ─── Question Answer Flow: Bridge-less Unit Tests ─────────────────────────────
//
// Tests the bridge-less question→answer→agent-continues flow:
//   1. Client sends ask_user_response with { toolId, answers }
//   2. Handler calls formatAnswers() then deps.client.replyQuestion() directly
//   3. On failure, falls back to deps.client.listPendingQuestions()
//   4. Broadcasts ask_user_resolved on success
//
// Similarly for question_reject:
//   1. Client sends question_reject with { toolId }
//   2. Handler calls deps.client.rejectQuestion() directly
//   3. On failure, falls back to deps.client.listPendingQuestions()
//   4. Broadcasts ask_user_resolved on success

import { describe, expect, it, vi } from "vitest";
import {
	handleAskUserResponse,
	handleQuestionReject,
} from "../../../src/lib/handlers/permissions.js";
import type { HandlerDeps } from "../../../src/lib/handlers/types.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create mock handler deps with per-test overrides */
function createDeps(overrides?: {
	clientSession?: string | undefined;
}): HandlerDeps & { logSpy: { warn: ReturnType<typeof vi.fn> } } {
	const warnSpy = vi.fn();
	const deps = createMockHandlerDeps({
		log: { ...createSilentLogger(), warn: warnSpy },
	});

	vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(
		overrides?.clientSession ?? "ses_test_001",
	);
	vi.mocked(deps.wsHandler.getClientsForSession).mockReturnValue(["client-1"]);

	return Object.assign(deps, { logSpy: { warn: warnSpy } });
}

// ─── handleAskUserResponse ──────────────────────────────────────────────────

describe("handleAskUserResponse: bridge-less flow", () => {
	it("direct reply: replyQuestion succeeds → broadcasts ask_user_resolved", async () => {
		const deps = createDeps();
		vi.mocked(deps.client.replyQuestion).mockResolvedValue(undefined);

		await handleAskUserResponse(deps, "client-1", {
			toolId: "que_abc123",
			answers: { "0": "PostgreSQL" },
		});

		expect(deps.client.replyQuestion).toHaveBeenCalledWith({
			id: "que_abc123",
			answers: [["PostgreSQL"]],
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "ask_user_resolved",
			toolId: "que_abc123",
			sessionId: "ses_test_001",
		});
	});

	it("API fallback: replyQuestion throws → listPendingQuestions returns a question → replies to first one", async () => {
		const deps = createDeps();
		vi.mocked(deps.client.replyQuestion)
			.mockRejectedValueOnce(new Error("Not found"))
			.mockResolvedValueOnce(undefined);
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([
			{ id: "que_fallback_001" },
		] as Awaited<ReturnType<HandlerDeps["client"]["listPendingQuestions"]>>);

		await handleAskUserResponse(deps, "client-1", {
			toolId: "que_stale",
			answers: { "0": "PostgreSQL" },
		});

		// First attempt with the original toolId
		expect(deps.client.replyQuestion).toHaveBeenCalledWith({
			id: "que_stale",
			answers: [["PostgreSQL"]],
		});
		// Fallback: queries pending questions
		expect(deps.client.listPendingQuestions).toHaveBeenCalled();
		// Replies to the first pending question
		expect(deps.client.replyQuestion).toHaveBeenCalledWith({
			id: "que_fallback_001",
			answers: [["PostgreSQL"]],
		});
		// Broadcasts with the fallback question's ID
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "ask_user_resolved",
			toolId: "que_fallback_001",
			sessionId: "ses_test_001",
		});
	});

	it("answer dropped: both replyQuestion and listPendingQuestions fail → logs drop message and sends error", async () => {
		const deps = createDeps();
		vi.mocked(deps.client.replyQuestion).mockRejectedValue(
			new Error("Not found"),
		);
		vi.mocked(deps.client.listPendingQuestions).mockRejectedValue(
			new Error("API unavailable"),
		);

		await handleAskUserResponse(deps, "client-1", {
			toolId: "que_orphan",
			answers: { "0": "Yes" },
		});

		// replyQuestion was attempted
		expect(deps.client.replyQuestion).toHaveBeenCalledWith({
			id: "que_orphan",
			answers: [["Yes"]],
		});
		// listPendingQuestions was attempted as fallback
		expect(deps.client.listPendingQuestions).toHaveBeenCalled();
		// No broadcast — answer was dropped
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
		// Log shows the drop
		expect(deps.logSpy.warn).toHaveBeenCalledWith(
			expect.stringContaining("answer DROPPED"),
		);
		// Sends ask_user_error to the client
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "ask_user_error",
			toolId: "que_orphan",
			message: expect.stringContaining("terminal session"),
		});
	});

	it("answer dropped: replyQuestion fails and listPendingQuestions returns empty → sends ask_user_error", async () => {
		const deps = createDeps();
		vi.mocked(deps.client.replyQuestion).mockRejectedValue(
			new Error("Not found"),
		);
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([]);

		await handleAskUserResponse(deps, "client-1", {
			toolId: "que_gone",
			answers: { "0": "Yes" },
		});

		expect(deps.client.listPendingQuestions).toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
		expect(deps.logSpy.warn).toHaveBeenCalledWith(
			expect.stringContaining("answer DROPPED"),
		);
		// Sends ask_user_error with user-friendly message
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "ask_user_error",
			toolId: "que_gone",
			message: expect.stringContaining("terminal session"),
		});
	});

	it("multi-question format: answers Record → string[][]", async () => {
		const deps = createDeps();
		vi.mocked(deps.client.replyQuestion).mockResolvedValue(undefined);

		await handleAskUserResponse(deps, "client-1", {
			toolId: "que_multi",
			answers: { "0": "Opt A", "1": "Opt B" },
		});

		expect(deps.client.replyQuestion).toHaveBeenCalledWith({
			id: "que_multi",
			answers: [["Opt A"], ["Opt B"]],
		});
	});

	it("answer format with empty values: empty string → empty array", async () => {
		const deps = createDeps();
		vi.mocked(deps.client.replyQuestion).mockResolvedValue(undefined);

		await handleAskUserResponse(deps, "client-1", {
			toolId: "que_partial",
			answers: { "0": "", "1": "Opt B" },
		});

		expect(deps.client.replyQuestion).toHaveBeenCalledWith({
			id: "que_partial",
			answers: [[], ["Opt B"]],
		});
	});
});

// ─── handleQuestionReject ───────────────────────────────────────────────────

describe("handleQuestionReject: bridge-less flow", () => {
	it("reject direct: rejectQuestion succeeds → broadcasts ask_user_resolved", async () => {
		const deps = createDeps();
		vi.mocked(deps.client.rejectQuestion).mockResolvedValue(undefined);

		await handleQuestionReject(deps, "client-1", {
			toolId: "que_reject_001",
		});

		expect(deps.client.rejectQuestion).toHaveBeenCalledWith("que_reject_001");
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "ask_user_resolved",
			toolId: "que_reject_001",
			sessionId: "ses_test_001",
		});
	});

	it("reject fallback: rejectQuestion throws → listPendingQuestions fallback", async () => {
		const deps = createDeps();
		vi.mocked(deps.client.rejectQuestion)
			.mockRejectedValueOnce(new Error("Not found"))
			.mockResolvedValueOnce(undefined);
		vi.mocked(deps.client.listPendingQuestions).mockResolvedValue([
			{ id: "que_pending_001" },
		] as Awaited<ReturnType<HandlerDeps["client"]["listPendingQuestions"]>>);

		await handleQuestionReject(deps, "client-1", {
			toolId: "que_stale_reject",
		});

		// First attempt with the original toolId
		expect(deps.client.rejectQuestion).toHaveBeenCalledWith("que_stale_reject");
		// Fallback: queries pending questions
		expect(deps.client.listPendingQuestions).toHaveBeenCalled();
		// Rejects the first pending question
		expect(deps.client.rejectQuestion).toHaveBeenCalledWith("que_pending_001");
		// Broadcasts with the fallback question's ID
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
			type: "ask_user_resolved",
			toolId: "que_pending_001",
			sessionId: "ses_test_001",
		});
	});

	it("reject with empty toolId → early return, no API calls", async () => {
		const deps = createDeps();

		await handleQuestionReject(deps, "client-1", {
			toolId: "",
		});

		expect(deps.client.rejectQuestion).not.toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("reject fallback: both rejectQuestion and listPendingQuestions fail → sends ask_user_error", async () => {
		const deps = createDeps();
		vi.mocked(deps.client.rejectQuestion).mockRejectedValue(
			new Error("Not found"),
		);
		vi.mocked(deps.client.listPendingQuestions).mockRejectedValue(
			new Error("API unavailable"),
		);

		await handleQuestionReject(deps, "client-1", {
			toolId: "que_double_fail",
		});

		expect(deps.client.rejectQuestion).toHaveBeenCalledWith("que_double_fail");
		expect(deps.client.listPendingQuestions).toHaveBeenCalled();
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
		// Sends ask_user_error with user-friendly message
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "ask_user_error",
			toolId: "que_double_fail",
			message: expect.stringContaining("terminal session"),
		});
	});
});
