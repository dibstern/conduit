// ─── Regression: User Message Echo Suppression ───────────────────────────────
// Tests the full round-trip: prompt handler records pending user message,
// then SSE wiring suppresses the echo from OpenCode's message.created event.
//
// Reproduces: "user messages render once correctly, then appear again as
// both a user message and assistant text" — the user_message SSE echo
// was not being suppressed because prompt.ts never called
// pendingUserMessages.record().

import { describe, expect, it, vi } from "vitest";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import { PendingUserMessages } from "../../../src/lib/relay/pending-user-messages.js";
import { handleSSEEvent } from "../../../src/lib/relay/sse-wiring.js";
import type { OpenCodeEvent, RelayMessage } from "../../../src/lib/types.js";
import {
	createMockHandlerDeps,
	createMockSSEWiringDeps,
} from "../../helpers/mock-factories.js";

describe("User message echo suppression (integration)", () => {
	it("prompt handler records pending → SSE wiring suppresses echo", async () => {
		// Use a SHARED PendingUserMessages instance across both subsystems
		const pending = new PendingUserMessages();

		// ── Step 1: User sends a message via the relay prompt handler ────
		const handlerDeps = createMockHandlerDeps({
			pendingUserMessages: pending,
		});
		vi.mocked(handlerDeps.wsHandler.getClientSession).mockReturnValue(
			"ses_abc",
		);
		await handleMessage(handlerDeps, "client-1", {
			text: "Merge into main",
		});

		// Verify the message was recorded for suppression
		expect(pending.size).toBe(1);

		// ── Step 2: OpenCode fires message.created SSE event (echo) ──────
		const sseDeps = createMockSSEWiringDeps({
			pendingUserMessages: pending,
		});
		const translated: RelayMessage = {
			type: "user_message",
			text: "Merge into main",
		};
		vi.mocked(sseDeps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const sseEvent: OpenCodeEvent = {
			type: "message.created",
			properties: { sessionID: "ses_abc" },
		};
		handleSSEEvent(sseDeps, sseEvent);

		// The echo should be SUPPRESSED — not sent to browser or cached
		expect(sseDeps.wsHandler.sendToSession).not.toHaveBeenCalled();
		expect(sseDeps.messageCache.recordEvent).not.toHaveBeenCalled();

		// The pending entry should be consumed
		expect(pending.size).toBe(0);
	});

	it("TUI-originated user messages pass through when no pending recorded", () => {
		const pending = new PendingUserMessages();

		// No prompt handler call — message came from TUI/CLI directly
		const sseDeps = createMockSSEWiringDeps({
			pendingUserMessages: pending,
		});
		const translated: RelayMessage = {
			type: "user_message",
			text: "Hello from TUI",
		};
		vi.mocked(sseDeps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const sseEvent: OpenCodeEvent = {
			type: "message.created",
			properties: { sessionID: "ses_xyz" },
		};
		handleSSEEvent(sseDeps, sseEvent);

		// TUI messages should pass through — sent AND cached
		expect(sseDeps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses_xyz",
			translated,
		);
		expect(sseDeps.messageCache.recordEvent).toHaveBeenCalledWith(
			"ses_xyz",
			translated,
		);
	});

	it("suppression is session-scoped — different session echo passes through", async () => {
		const pending = new PendingUserMessages();

		// Record pending for session A
		const handlerDeps = createMockHandlerDeps({
			pendingUserMessages: pending,
		});
		vi.mocked(handlerDeps.wsHandler.getClientSession).mockReturnValue("ses_A");
		await handleMessage(handlerDeps, "client-1", { text: "Hello" });

		// SSE echo arrives for session B (different session, same text)
		const sseDeps = createMockSSEWiringDeps({
			pendingUserMessages: pending,
		});
		const translated: RelayMessage = {
			type: "user_message",
			text: "Hello",
		};
		vi.mocked(sseDeps.translator.translate).mockReturnValue({
			ok: true,
			messages: [translated],
		});

		const sseEvent: OpenCodeEvent = {
			type: "message.created",
			properties: { sessionID: "ses_B" },
		};
		handleSSEEvent(sseDeps, sseEvent);

		// Session B echo should NOT be suppressed (different session)
		expect(sseDeps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses_B",
			translated,
		);

		// Session A pending should still be there
		expect(pending.consume("ses_A", "Hello")).toBe(true);
	});
});
