import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	chatState,
	clearMessages,
	followSessionBusy,
	getOrCreateSessionSlot,
	handleDone,
	isLoading,
	isProcessing,
	isReplaying,
	isStreaming,
	phaseToProcessing,
	phaseToStreaming,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

beforeEach(() => {
	sessionState.currentId = "phase-test";
	clearMessages();
});

describe("chat phase and transcript lifecycle", () => {
	it("shows loading until transcript rows are installed", () => {
		const { messages } = getOrCreateSessionSlot("phase-test");
		messages.loadLifecycle = "loading";
		expect(isLoading()).toBe(true);
		expect(isReplaying()).toBe(true);
		messages.loadLifecycle = "ready";
		expect(isLoading()).toBe(false);
		expect(isReplaying()).toBe(false);
	});

	it("keeps processing and streaming phase scoped to the active session", () => {
		const { activity, messages } = getOrCreateSessionSlot("phase-test");
		messages.loadLifecycle = "ready";
		phaseToProcessing(activity);
		expect(isProcessing()).toBe(true);
		phaseToStreaming(activity);
		expect(isStreaming()).toBe(true);
		expect(chatState.phase).toBe("streaming");
	});

	it("the row going idle ends the visible turn", () => {
		const { activity, messages } = getOrCreateSessionSlot("phase-test");
		messages.loadLifecycle = "ready";
		phaseToProcessing(activity);
		followSessionBusy("phase-test", false);
		expect(activity.phase).toBe("idle");
		expect(activity.turnEpoch).toBe(1);
	});

	it("done is idempotent after a status transition", () => {
		const { activity, messages } = getOrCreateSessionSlot("phase-test");
		messages.loadLifecycle = "ready";
		phaseToProcessing(activity);
		handleDone(activity, messages, {
			type: "done",
			sessionId: "phase-test",
			code: 0,
		});
		handleDone(activity, messages, {
			type: "done",
			sessionId: "phase-test",
			code: 0,
		});
		expect(activity.turnEpoch).toBe(1);
	});
});
