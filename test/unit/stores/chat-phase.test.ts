// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));

import {
	applyTerminalTurn,
	clearMessages,
	getOrCreateSessionSlot,
	isLoading,
	isProcessing,
	isReplaying,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	openSessionForSetup,
	setSessionWorkingForSetup,
} from "../../../src/lib/frontend/stories/session-setup.js";
import { applySessionUpsert } from "./session-fixtures.js";

beforeEach(() => {
	openSessionForSetup("phase-test", "project-a");
	setSessionWorkingForSetup("phase-test", false);
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

	it("the active session's row activity, not its status, makes it processing", () => {
		const { messages } = getOrCreateSessionSlot("phase-test");
		messages.loadLifecycle = "ready";
		applySessionUpsert({
			id: "phase-test",
			title: "phase-test",
			status: "busy",
		});
		expect(isProcessing()).toBe(false);
		setSessionWorkingForSetup("other", true);
		expect(isProcessing()).toBe(false);
		setSessionWorkingForSetup("phase-test", true);
		expect(isProcessing()).toBe(true);
	});

	it("the row going idle ends the visible turn", () => {
		const { activity, messages } = getOrCreateSessionSlot("phase-test");
		messages.loadLifecycle = "ready";
		setSessionWorkingForSetup("phase-test", true);
		expect(activity.endedGeneration).not.toBe(activity.turnGeneration);
		setSessionWorkingForSetup("phase-test", false);
		expect(isProcessing()).toBe(false);
		expect(activity.endedGeneration).toBe(activity.turnGeneration);
	});

	it("terminal state is idempotent after a status transition", () => {
		const { activity, messages } = getOrCreateSessionSlot("phase-test");
		messages.loadLifecycle = "ready";
		setSessionWorkingForSetup("phase-test", true);
		applyTerminalTurn(activity, messages);
		applyTerminalTurn(activity, messages);
		expect(activity.endedGeneration).toBe(activity.turnGeneration);
	});
});
