import { cleanup, render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MessageList from "../../../src/lib/frontend/components/chat/MessageList.svelte";
import { getOrCreateSessionSlot } from "../../../src/lib/frontend/stores/chat.svelte.js";
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
});
