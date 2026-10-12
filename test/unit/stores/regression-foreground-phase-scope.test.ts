import { afterEach, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	followSessionBusy,
	getOrCreateSessionSlot,
	phaseToProcessing,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	applyTranscriptEnvelope,
	deriveTranscriptMessages,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { detailUpserts } from "../../helpers/detail-rows.js";

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
		waiting: new Map(),
		partOrder: new Map(),
	};
	const running = detailUpserts(
		{
			id: "r",
			role: "user",
			parts: [{ id: "rp", type: "text", text: "running" }],
			turnTiming: { startedAt: 1, waits: [] },
		},
		1,
	).reduce(applyTranscriptEnvelope, entry);
	const next = detailUpserts(
		{
			id: "u",
			role: "user",
			parts: [{ id: "p", type: "text", text: "queued" }],
		},
		2,
	).reduce(applyTranscriptEnvelope, running);
	background.messages.messages = deriveTranscriptMessages(next, []);
	expect(background.messages.messages[1]).toMatchObject({
		type: "user",
		text: "queued",
	});
	expect(foreground.messages.messages).toHaveLength(0);
	expect(foreground.activity.phase).toBe("idle");
});

it("the row going idle finalizes the visible turn once", () => {
	const { activity, messages } = getOrCreateSessionSlot("A");
	sessionState.currentId = "A";
	phaseToProcessing(activity);
	const entry = detailUpserts(
		{
			id: "a",
			role: "assistant",
			parts: [{ id: "p", type: "text", text: "answer" }],
		},
		1,
	).reduce(applyTranscriptEnvelope, {
		project: "test",
		rows: [],
		hwm: null,
		hasMore: false,
		status: { _tag: "live" as const },
		pending: [],
		waiting: new Map(),
		partOrder: new Map(),
	});
	messages.messages = deriveTranscriptMessages(entry, []);
	followSessionBusy("A", false);
	followSessionBusy("A", false);
	expect(activity.phase).toBe("idle");
	expect(activity.endedGeneration).toBe(activity.turnGeneration);
	expect(messages.messages[0]).toMatchObject({
		type: "assistant",
		finalized: true,
	});
});
