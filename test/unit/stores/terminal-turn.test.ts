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

it("a duplicate delta for A cannot swallow B's terminal without an assistant message", () => {
	applySessionUpsert({ id: "s", title: "test", status: "idle" });
	const { activity } = chat.getOrCreateSessionSlot("s");
	const delta = {
		type: "delta",
		sessionId: "s",
		messageId: "A",
		text: "answer",
	} as const;
	handleMessage(delta);
	handleMessage({ sessionId: "s", type: "done", code: 0 });
	handleMessage({ sessionId: "s", type: "status", status: "processing" });
	handleMessage(delta);
	handleMessage({ sessionId: "s", type: "done", code: 0 });
	expect(activity.phase).toBe("idle");
	expect(activity.turnEpoch).toBe(2);
});

it("an anonymous delta after A ends begins a turn without status events", () => {
	applySessionUpsert({ id: "s", title: "test", status: "idle" });
	const { activity } = chat.getOrCreateSessionSlot("s");
	handleMessage({
		sessionId: "s",
		type: "delta",
		messageId: "A",
		text: "first",
	});
	handleMessage({ sessionId: "s", type: "done", code: 0 });
	handleMessage({ sessionId: "s", type: "delta", text: "second" });
	expect(activity.phase).toBe("streaming");
	handleMessage({ sessionId: "s", type: "done", code: 0 });
	expect(activity.phase).toBe("idle");
	expect(activity.turnEpoch).toBe(2);
});

it("durably ending A then receiving B advances the epoch exactly once", () => {
	applySessionUpsert({ id: "s", title: "test", status: "idle" });
	const { activity, messages } = chat.getOrCreateSessionSlot("s");
	handleMessage({
		sessionId: "s",
		type: "delta",
		messageId: "A",
		text: "first",
	});
	expect(chat.applyTerminalTurn(activity, messages, { turnId: "user-A" })).toBe(
		true,
	);
	handleMessage({
		sessionId: "s",
		type: "delta",
		messageId: "B",
		text: "second",
	});
	expect(activity.turnEpoch).toBe(1);
});

it("two terminal events with no new turn end it exactly once", () => {
	const activity = chat.createEmptySessionActivity();
	const messages = chat.createEmptySessionMessages();
	chat.handleDelta(activity, messages, {
		type: "delta",
		sessionId: "s",
		messageId: "A",
		text: "answer",
	});
	expect(chat.applyTerminalTurn(activity, messages)).toBe(true);
	const finalized = messages.messages;
	expect(chat.applyTerminalTurn(activity, messages)).toBe(false);
	expect(activity.turnEpoch).toBe(1);
	expect(activity.phase).toBe("idle");
	expect(messages.messages).toBe(finalized);
});

it("terminalTurnIds retains only the eight most recent durable turns", () => {
	const activity = chat.createEmptySessionActivity();
	const messages = chat.createEmptySessionMessages();
	for (let i = 0; i < 32; i++) {
		chat.phaseToProcessing(activity);
		const previousIds = activity.terminalTurnIds;
		expect(
			chat.applyTerminalTurn(activity, messages, { turnId: `user-${i}` }),
		).toBe(true);
		expect(activity.terminalTurnIds).not.toBe(previousIds);
		expect(activity.terminalTurnIds.size).toBeLessThanOrEqual(8);
	}
	expect([...activity.terminalTurnIds]).toEqual([
		"user-24",
		"user-25",
		"user-26",
		"user-27",
		"user-28",
		"user-29",
		"user-30",
		"user-31",
	]);
	expect(
		chat.applyTerminalTurn(activity, messages, { turnId: "user-31" }),
	).toBe(false);
	expect(activity.turnEpoch).toBe(32);
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
