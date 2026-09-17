import { cleanup, render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MessageList from "../../../src/lib/frontend/components/chat/MessageList.svelte";
import {
	chatState,
	getOrCreateSessionSlot,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { sessionViewState } from "../../../src/lib/frontend/stores/session-view.svelte.js";

vi.mock(
	"../../../src/lib/frontend/components/chat/HistoryLoader.svelte",
	() => import("../../helpers/Empty.svelte"),
);

describe("MessageList session-view publication", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		sessionState.currentId = "session-view-first";
		getOrCreateSessionSlot("session-view-first").messages.loadLifecycle =
			"ready";
	});

	afterEach(() => {
		cleanup();
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	function mountTranscript() {
		const view = render(MessageList);
		flushSync();
		vi.runOnlyPendingTimers();
		const transcript =
			view.container.querySelector<HTMLDivElement>("#messages");
		if (!transcript) throw new Error("Missing transcript");
		Object.defineProperties(transcript, {
			scrollHeight: { value: 2000, configurable: true },
			clientHeight: { value: 500, configurable: true },
		});
		return { ...view, transcript };
	}

	function scrollTo(transcript: HTMLDivElement, top: number) {
		transcript.scrollTop = top;
		transcript.dispatchEvent(new Event("scroll"));
		flushSync();
	}

	it("publishes detach, re-follow and programmatic follow without false detach", () => {
		const { transcript, getByRole } = mountTranscript();
		expect(sessionViewState.atBottom).toBe(true);

		scrollTo(transcript, 200);
		expect(sessionViewState.atBottom).toBe(false);

		scrollTo(transcript, 1500);
		expect(sessionViewState.atBottom).toBe(true);
		vi.runOnlyPendingTimers();

		scrollTo(transcript, 200);
		expect(sessionViewState.atBottom).toBe(false);
		getByRole("button", { name: /Latest/ }).click();
		flushSync();
		expect(sessionViewState.atBottom).toBe(true);

		// Content growth can leave the programmatic scroll away from the bottom.
		// Its pending event must still be ignored by the controller.
		scrollTo(transcript, 200);
		expect(sessionViewState.atBottom).toBe(true);
		vi.runOnlyPendingTimers();
		scrollTo(transcript, 200);
		expect(sessionViewState.atBottom).toBe(false);
	});

	it("counts loading and settling as at-bottom even after detaching", () => {
		const { transcript } = mountTranscript();
		scrollTo(transcript, 200);
		expect(sessionViewState.atBottom).toBe(false);

		for (const lifecycle of ["empty", "loading", "committed"] as const) {
			getOrCreateSessionSlot("session-view-first").messages.loadLifecycle =
				lifecycle;
			flushSync();
			expect(sessionViewState.atBottom).toBe(true);
		}
	});

	it.each([
		"loading",
		"ready",
	] as const)("resets a detached transcript when switching to a %s session", (lifecycle) => {
		const { transcript } = mountTranscript();
		scrollTo(transcript, 200);
		expect(sessionViewState.atBottom).toBe(false);

		getOrCreateSessionSlot("session-view-next").messages.loadLifecycle =
			lifecycle;
		sessionState.currentId = "session-view-next";
		flushSync();
		expect(sessionViewState.atBottom).toBe(true);
	});

	it.each([
		"assistant",
		"tool",
	])("renders resumed %s activity as working after a result", (kind) => {
		const slot = getOrCreateSessionSlot("session-view-first");
		chatState.phase = "processing";
		slot.activity.phase = "processing";
		slot.messages.messages = [
			{ type: "user", uuid: "prompt", text: "Check the files" },
			{
				type: "tool",
				uuid: "first-tool",
				id: "first-tool",
				name: "Read",
				input: { tool: "Read", filePath: "/a.ts" },
				status: "completed",
			},
			{ type: "result", uuid: "first-result", cost: 0.01 },
		];
		const { container } = mountTranscript();
		expect(container.querySelectorAll(".turn-activity")).toHaveLength(1);
		expect(container.textContent).toContain("Worked");
		expect(container.textContent).not.toContain("Working");

		slot.messages.messages = [
			...slot.messages.messages,
			kind === "assistant"
				? {
						type: "assistant",
						uuid: "continued",
						rawText: "One more check",
						html: "<p>One more check</p>",
						finalized: false,
					}
				: {
						type: "tool",
						uuid: "next-tool",
						id: "next-tool",
						name: "Read",
						input: { tool: "Read", filePath: "/b.ts" },
						status: "running",
					},
		];
		flushSync();
		expect(container.querySelectorAll(".turn-activity")).toHaveLength(2);
		expect(container.querySelectorAll(".glow-tool-running")).toHaveLength(1);
		expect(container.textContent).toContain("Working");
		expect(container.textContent).toContain(
			kind === "assistant" ? "Replying" : "Reading",
		);

		slot.messages.messages = [
			...slot.messages.messages,
			{ type: "result", uuid: "last-result", cost: 0.02 },
		];
		flushSync();
		expect(container.querySelector(".glow-tool-running")).toBeNull();
		expect(container.textContent).not.toContain("Working");
		if (kind === "assistant")
			expect(container.querySelector(".result-bar")).not.toBeNull();
		slot.messages.messages = [];
		chatState.phase = "idle";
		slot.activity.phase = "idle";
	});
});
