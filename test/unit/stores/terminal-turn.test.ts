import { afterEach, expect, it, vi } from "vitest";
import { seedSessions } from "./session-fixtures.js";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
vi.mock("../../../src/lib/frontend/stores/ws-notifications.js", () => ({
	triggerNotifications: vi.fn(),
}));

import * as chat from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	applyTranscriptEnvelope,
	deriveTranscriptMessages,
	type TranscriptEntry,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { triggerNotifications } from "../../../src/lib/frontend/stores/ws-notifications.js";
import { detailUpserts } from "../../helpers/detail-rows.js";

afterEach(() => {
	vi.clearAllMocks();
	chat.sessionActivity.clear();
	chat.sessionMessages.clear();
	sessionState.currentId = null;
});

function projectedTurn() {
	seedSessions([{ id: "s", title: "test", status: "idle" }]);
	sessionState.currentId = "s";
	const slot = chat.getOrCreateSessionSlot("s");
	chat.phaseToProcessing(slot.activity);
	const empty: TranscriptEntry = {
		project: "test",
		rows: [],
		hwm: null,
		hasMore: false,
		status: { _tag: "live" },
		pending: [],
		waiting: new Map(),
		partOrder: new Map(),
	};
	const entry = detailUpserts(
		{
			id: "assistant-x",
			role: "assistant",
			parts: [
				{ id: "thinking", type: "thinking", text: "reasoning" },
				{
					id: "tool",
					type: "tool",
					tool: "Read",
					callID: "call",
					state: { status: "running" },
				},
				{ id: "text", type: "text", text: "answer" },
			],
		},
		1,
	).reduce(applyTranscriptEnvelope, empty);
	slot.messages.messages = deriveTranscriptMessages(entry, []);
	return slot;
}

// Behaviour retained from the deleted registry's finalizeAll tests.
it.each([
	"pending",
	"running",
	"completed",
	"error",
] as const)("finalizes ordinary %s tools and preserves terminal tools", (status) => {
	const activity = chat.createEmptySessionActivity();
	const messages = chat.createEmptySessionMessages();
	const tool = {
		type: "tool",
		uuid: "tool",
		id: "call",
		name: "Read",
		status,
		result: "kept",
	} as const;
	messages.messages = [tool];
	chat.applyTerminalTurn(activity, messages);
	expect(messages.messages[0]).toEqual({
		...tool,
		status: status === "pending" || status === "running" ? "completed" : status,
	});
	if (status === "completed" || status === "error")
		expect(messages.messages[0]).toBe(tool);
	expect(tool.status).toBe(status);
});

it.each([
	["idle row", "terminal row", "terminal replay"],
	["idle row", "terminal replay", "terminal row"],
	["terminal row", "idle row", "terminal replay"],
	["terminal row", "terminal replay", "idle row"],
	["terminal replay", "terminal row", "idle row"],
	["terminal replay", "idle row", "terminal row"],
] as const)("one terminal transition: %s, %s, %s", (...order) => {
	const { activity, messages } = projectedTurn();
	const events: Record<(typeof order)[number], () => void> = {
		"idle row": () => chat.followSessionBusy("s", false),
		"terminal row": () => chat.applyTerminalTurn(activity, messages),
		"terminal replay": () => chat.applyTerminalTurn(activity, messages),
	};
	events[order[0]]();
	const ended = activity.endedGeneration;
	expect(ended).toBe(activity.turnGeneration);
	expect(messages.messages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "assistant", finalized: true }),
			expect.objectContaining({ type: "thinking", done: true }),
			expect.objectContaining({ type: "tool", status: "completed" }),
		]),
	);
	const finalized = messages.messages;
	events[order[1]]();
	events[order[2]]();
	expect(activity.endedGeneration).toBe(ended);
	expect(messages.messages).toBe(finalized);
});

it("durable terminal replay does not repeat the transition or alert", () => {
	const { activity, messages } = projectedTurn();
	chat.followSessionBusy("s", false);
	const finalized = messages.messages;
	const ended = activity.endedGeneration;
	chat.followSessionBusy("s", false);
	expect(chat.applyTerminalTurn(activity, messages)).toBe(false);
	expect(activity.endedGeneration).toBe(ended);
	expect(messages.messages).toBe(finalized);
	expect(triggerNotifications).not.toHaveBeenCalled();
});

it("remembers only eight durable turn IDs", () => {
	const activity = chat.createEmptySessionActivity();
	const messages = chat.createEmptySessionMessages();
	for (let i = 0; i < 32; i++) {
		chat.phaseToProcessing(activity);
		expect(
			chat.applyTerminalTurn(activity, messages, { turnId: `turn-${i}` }),
		).toBe(true);
	}
	expect(activity.terminalTurnIds.size).toBe(8);
	expect(
		chat.applyTerminalTurn(activity, messages, { turnId: "turn-31" }),
	).toBe(false);
});
