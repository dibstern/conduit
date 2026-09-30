import { describe, expect, it } from "vitest";
import {
	createMockRelayProtocolContext,
	normalizeMockRelayMessage,
	normalizeMockRelayMessages,
} from "../../e2e/helpers/ws-mock.js";

describe("E2E WebSocket mock protocol normalizer", () => {
	it("adds sessionId to session-scoped init and live messages", () => {
		const context = createMockRelayProtocolContext("sess-a");

		const normalized = normalizeMockRelayMessages(
			[
				{ type: "status", status: "idle" },
				{ type: "user_message", text: "hello" },
				{ type: "delta", text: "world" },
				{ type: "done", code: 0 },
			],
			context,
		);

		expect(normalized).toEqual([
			{ type: "status", status: "idle", sessionId: "sess-a" },
			{ type: "user_message", text: "hello", sessionId: "sess-a" },
			{ type: "delta", text: "world", sessionId: "sess-a" },
			{ type: "done", code: 0, sessionId: "sess-a" },
		]);
	});

	it("uses an explicit sessionId for session-scoped events", () => {
		const context = createMockRelayProtocolContext();
		expect(
			normalizeMockRelayMessage(
				{ type: "user_message", text: "question", sessionId: "sess-history" },
				context,
			),
		).toEqual({
			type: "user_message",
			text: "question",
			sessionId: "sess-history",
		});
	});

	it("preserves explicit sessionId for cross-session events", () => {
		const context = createMockRelayProtocolContext("sess-current");

		expect(
			normalizeMockRelayMessage(
				{
					type: "permission_request",
					sessionId: "sess-other",
					id: "perm-1",
					toolName: "Read",
					description: "Read package.json",
				},
				context,
			),
		).toMatchObject({
			type: "permission_request",
			sessionId: "sess-other",
		});
	});
});
