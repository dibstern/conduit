import { afterEach, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	getOrCreateSessionSlot,
	phaseCurrentSessionToIdle,
	phaseToProcessing,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	applyTranscriptEnvelope,
	deriveTranscriptMessages,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";

afterEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	sessionState.currentId = null;
});

it("keeps a background session's queued row in its own slot", () => {
	const foreground = getOrCreateSessionSlot("A");
	const background = getOrCreateSessionSlot("B");
	sessionState.currentId = "A";
	phaseToProcessing(background.activity);
	const entry = {
		project: "test",
		rows: [],
		hwm: null,
		hasMore: false,
		status: { _tag: "live" as const },
		carriedUsers: new Map(),
	};
	const next = applyTranscriptEnvelope(entry, {
		_tag: "upsert",
		sequence: 1,
		item: {
			_tag: "transcriptMessage",
			message: {
				id: "u",
				role: "user",
				parts: [{ id: "p", type: "text", text: "queued" }],
			},
		},
	});
	const derived = deriveTranscriptMessages(next, [], {
		live: true,
		active: true,
		turnEpoch: background.activity.turnEpoch,
		newUserIds: new Set(["u"]),
	});
	background.messages.messages = derived.messages;
	expect(background.messages.messages[0]).toMatchObject({
		type: "user",
		sentDuringEpoch: 0,
	});
	expect(foreground.messages.messages).toHaveLength(0);
	expect(foreground.activity.phase).toBe("idle");
});

it("socket close finalizes the visible turn once", () => {
	const { activity, messages } = getOrCreateSessionSlot("A");
	sessionState.currentId = "A";
	phaseToProcessing(activity);
	const entry = applyTranscriptEnvelope(
		{
			project: "test",
			rows: [],
			hwm: null,
			hasMore: false,
			status: { _tag: "live" as const },
			carriedUsers: new Map(),
		},
		{
			_tag: "upsert",
			sequence: 1,
			item: {
				_tag: "transcriptMessage",
				message: {
					id: "a",
					role: "assistant",
					parts: [{ id: "p", type: "text", text: "answer" }],
				},
			},
		},
	);
	messages.messages = deriveTranscriptMessages(entry, [], {
		live: true,
		active: true,
		turnEpoch: 0,
	}).messages;
	phaseCurrentSessionToIdle();
	phaseCurrentSessionToIdle();
	expect(activity.phase).toBe("idle");
	expect(activity.turnEpoch).toBe(1);
	expect(messages.messages[0]).toMatchObject({
		type: "assistant",
		finalized: true,
	});
});
