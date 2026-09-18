import { afterEach, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));
vi.mock("../../../src/lib/frontend/stores/ws-notifications.js", () => ({
	triggerNotifications: vi.fn(),
}));

import * as chat from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	applySessionUpsert,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";
import { triggerNotifications } from "../../../src/lib/frontend/stores/ws-notifications.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

afterEach(() => {
	vi.clearAllMocks();
	chat.sessionActivity.clear();
	chat.sessionMessages.clear();
});

it("two identified live turns advance the epoch twice in total", () => {
	applySessionUpsert({ id: "s", title: "test", status: "idle" });
	const { activity } = chat.getOrCreateSessionSlot("s");
	for (const messageId of ["assistant-x", "assistant-y"]) {
		handleMessage({ type: "delta", sessionId: "s", messageId, text: "answer" });
		handleMessage({ type: "done", sessionId: "s", code: 0 });
	}
	expect(activity.turnEpoch).toBe(2);
});

it.each([
	["status", "done", "error"],
	["status", "error", "done"],
	["done", "status", "error"],
	["done", "error", "status"],
	["error", "done", "status"],
	["error", "status", "done"],
] as const)("one terminal transition through dispatch: %s, %s, %s", (...order) => {
	applySessionUpsert({ id: "s", title: "test", status: "idle" });
	const { activity, messages } = chat.getOrCreateSessionSlot("s");
	handleMessage({
		type: "delta",
		sessionId: "s",
		messageId: "assistant-x",
		text: "answer",
	});
	handleMessage({ type: "thinking_start", sessionId: "s" });
	handleMessage({
		type: "tool_start",
		sessionId: "s",
		id: "tool-x",
		name: "Read",
	});
	const before = activity.turnEpoch;
	const events: Record<(typeof order)[number], RelayMessage> = {
		status: { type: "status", sessionId: "s", status: "idle" },
		done: { type: "done", sessionId: "s", code: 0 },
		error: {
			type: "error",
			sessionId: "s",
			code: "TURN_FAILED",
			message: "failed",
		},
	};
	handleMessage(events[order[0]]);
	expect(activity.turnEpoch).toBe(before + 1);
	expect(messages.messages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "assistant", finalized: true }),
			expect.objectContaining({ type: "thinking", done: true }),
			expect.objectContaining({ type: "tool", status: "completed" }),
		]),
	);
	const finalized = messages.messages;
	handleMessage(events[order[1]]);
	handleMessage(events[order[2]]);
	expect(activity.turnEpoch).toBe(before + 1);
	expect(messages.messages).toBe(finalized);
});

it("same terminal turn finalizes once and the reducer never alerts", () => {
	const activity = chat.createEmptySessionActivity();
	const messages = chat.createEmptySessionMessages();
	chat.handleDelta(activity, messages, {
		type: "delta",
		sessionId: "s",
		text: "answer",
		messageId: "assistant-x",
	});
	expect(chat.applyTerminalTurn(activity, messages, { turnId: "user-x" })).toBe(
		true,
	);
	expect(activity.turnEpoch).toBe(1);
	expect(messages.messages).toEqual([
		expect.objectContaining({ type: "assistant", finalized: true }),
	]);
	const finalized = messages.messages;
	expect(chat.applyTerminalTurn(activity, messages, { turnId: "user-x" })).toBe(
		false,
	);
	expect(activity.turnEpoch).toBe(1);
	expect(messages.messages).toBe(finalized);
	expect(triggerNotifications).not.toHaveBeenCalled();
});

it("two different turns each end once, including turns without assistant text", () => {
	const activity = chat.createEmptySessionActivity();
	const messages = chat.createEmptySessionMessages();
	for (const epoch of [1, 2]) {
		chat.handleStatus(activity, messages, {
			type: "status",
			sessionId: "s",
			status: "processing",
		});
		chat.handleDone(activity, messages, {
			type: "done",
			sessionId: "s",
			code: 0,
		});
		chat.handleDone(activity, messages, {
			type: "done",
			sessionId: "s",
			code: 0,
		});
		expect(activity.turnEpoch).toBe(epoch);
	}
	const durable = chat.createEmptySessionActivity();
	for (const turnId of ["user-x", "user-y", "user-x", "user-y"]) {
		chat.applyTerminalTurn(durable, messages, { turnId });
	}
	expect(durable.turnEpoch).toBe(2);
	expect(triggerNotifications).not.toHaveBeenCalled();
});

it("reconnect then terminal replay does not end the turn again or alert", () => {
	applySessionUpsert({ id: "s", title: "test", status: "idle" });
	sessionState.currentId = "s";
	const { activity, messages } = chat.getOrCreateSessionSlot("s");
	handleMessage({
		type: "delta",
		sessionId: "s",
		messageId: "assistant-x",
		text: "answer",
	});
	// The socket-close callback ends the visible turn before reconnect.
	chat.phaseCurrentSessionToIdle();
	expect(activity.turnEpoch).toBe(1);
	const finalized = messages.messages;
	handleMessage({ type: "status", sessionId: "s", status: "idle" });
	// Replayed state uses the reducer, never the live notification dispatch.
	expect(chat.applyTerminalTurn(activity, messages)).toBe(false);
	expect(activity.turnEpoch).toBe(1);
	expect(messages.messages).toBe(finalized);
	expect(triggerNotifications).not.toHaveBeenCalled();

	handleMessage({
		type: "delta",
		sessionId: "s",
		messageId: "assistant-y",
		text: "next answer",
	});
	handleMessage({ type: "done", sessionId: "s", code: 0 });
	expect(triggerNotifications).toHaveBeenCalledOnce();
	const epoch = activity.turnEpoch;
	const completed = messages.messages;
	chat.phaseCurrentSessionToIdle();
	handleMessage({ type: "status", sessionId: "s", status: "idle" });
	expect(chat.applyTerminalTurn(activity, messages)).toBe(false);
	expect(activity.turnEpoch).toBe(epoch);
	expect(messages.messages).toBe(completed);
	expect(triggerNotifications).toHaveBeenCalledOnce();
});
