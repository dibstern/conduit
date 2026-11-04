// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	getOrCreateSessionSlot,
	getSessionPhase,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	applyTranscriptEnvelope,
	deriveTranscriptMessages,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import {
	openSessionForSetup,
	setSessionWorkingForSetup,
} from "../../../src/lib/frontend/stories/session-setup.js";
import { detailUpserts } from "../../helpers/detail-rows.js";

afterEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	openSessionForSetup(null);
});

it("keeps a background session's row in its own slot", () => {
	const foreground = getOrCreateSessionSlot("A");
	const background = getOrCreateSessionSlot("B");
	openSessionForSetup("A", "project-a");
	setSessionWorkingForSetup("B", true);
	expect(getSessionPhase("B")).toBe("processing");
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
	expect(getSessionPhase("A")).toBe("idle");
});

it("the row going idle finalizes the visible turn once", () => {
	const { activity, messages } = getOrCreateSessionSlot("A");
	openSessionForSetup("A", "project-a");
	setSessionWorkingForSetup("A", true);
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
	setSessionWorkingForSetup("A", false);
	const finalized = messages.messages;
	setSessionWorkingForSetup("A", false);
	expect(getSessionPhase("A")).toBe("idle");
	expect(messages.messages).toBe(finalized);
	expect(activity.endedGeneration).toBe(activity.turnGeneration);
	expect(messages.messages[0]).toMatchObject({
		type: "assistant",
		finalized: true,
	});
});
