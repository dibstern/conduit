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

it("keeps a background session's row in its own slot", () => {
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
		pending: [],
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
	background.messages.messages = deriveTranscriptMessages(next, []);
	expect(background.messages.messages[0]).toMatchObject({
		type: "user",
		text: "queued",
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
			pending: [],
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
	messages.messages = deriveTranscriptMessages(entry, []);
	phaseCurrentSessionToIdle();
	phaseCurrentSessionToIdle();
	expect(activity.phase).toBe("idle");
	expect(activity.endedGeneration).toBe(activity.turnGeneration);
	expect(messages.messages[0]).toMatchObject({
		type: "assistant",
		finalized: true,
	});
});
