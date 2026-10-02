import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InputArea from "../../../src/lib/frontend/components/input/InputArea.svelte";
import {
	getOrCreateSessionActivity,
	handleInputSyncReceived,
	inputSyncState,
	persistInputDraft,
	phaseToIdle,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { attachedProjectState } from "../../../src/lib/frontend/stores/router.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { syncInputDraftRpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (original) => ({
		...(await original<
			typeof import("../../../src/lib/frontend/transport/ws-rpc-client.js")
		>()),
		syncInputDraftRpc: vi.fn(async () => {}),
	}),
);

vi.mock(
	"../../../src/lib/frontend/components/input/input-utils.js",
	async (original) => ({
		...(await original<
			typeof import("../../../src/lib/frontend/components/input/input-utils.js")
		>()),
		resizeImageIfNeeded: async (dataUrl: string) => ({
			dataUrl,
			resized: false,
		}),
	}),
);

const sessionId = "build-reload-draft-test";
const reloadDraftKey = "conduit-reload-drafts";

async function enterText(textarea: HTMLTextAreaElement, text: string) {
	textarea.value = text;
	await fireEvent.input(textarea);
}

async function receiveDraft(text: string) {
	vi.setSystemTime(Date.now() + 1);
	handleInputSyncReceived({ text, from: "other-tab" });
	await tick();
}

async function attachImage() {
	const file = new File(["image bytes"], "screenshot.png", {
		type: "image/png",
	});
	const picker = vi
		.spyOn(HTMLInputElement.prototype, "click")
		.mockImplementation(function (this: HTMLInputElement) {
			Object.defineProperty(this, "files", { value: [file] });
			this.dispatchEvent(new Event("change"));
		});
	try {
		await fireEvent.click(screen.getByRole("button", { name: "Attach" }));
		await fireEvent.click(screen.getByRole("menuitem", { name: "Add Photos" }));
		await vi.waitFor(() => {
			expect(
				document.querySelector('img[alt="screenshot.png"]'),
			).not.toBeNull();
		});
	} finally {
		picker.mockRestore();
	}
}

describe("InputArea build reload recovery", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
		vi.mocked(syncInputDraftRpc).mockReset().mockResolvedValue(undefined);
		sessionStorage.clear();
		sessionState.currentId = sessionId;
		attachedProjectState.slug = "test";
		phaseToIdle(getOrCreateSessionActivity(sessionId));
		Object.assign(inputSyncState, {
			text: "",
			lastFrom: "",
			lastUpdated: 0,
			reloadPending: false,
		});
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 0;
		});
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		sessionState.currentId = null;
		attachedProjectState.slug = null;
		sessionStorage.clear();
	});

	it("defers reload preparation without losing a pending image or draft", async () => {
		const { getByRole } = render(InputArea);
		const textarea = getByRole("textbox", {
			name: "Message",
		}) as HTMLTextAreaElement;
		await enterText(textarea, "draft with an image");
		await attachImage();

		await expect(persistInputDraft()).resolves.toBe(false);
		expect(textarea.value).toBe("draft with an image");
		expect(getByRole("img", { name: "screenshot.png" })).toBeTruthy();

		await fireEvent.click(
			getByRole("button", { name: "Remove image screenshot.png" }),
		);
		await expect(persistInputDraft()).resolves.toBe(true);
		expect(
			JSON.parse(sessionStorage.getItem(reloadDraftKey) ?? "null"),
		).toContainEqual([sessionId, "draft with an image"]);
	});

	it("defers if an image is attached while the draft RPC is pending", async () => {
		let finishSave: (() => void) | undefined;
		vi.mocked(syncInputDraftRpc).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishSave = resolve;
				}),
		);
		render(InputArea);
		await tick();
		const preparation = persistInputDraft();
		const deferred = expect(preparation).resolves.toBe(false);
		await attachImage();
		finishSave?.();
		await deferred;
		expect(document.querySelector('img[alt="screenshot.png"]')).not.toBeNull();
	});

	it("allows reload when no composer is mounted", async () => {
		const { unmount } = render(InputArea);
		await tick();
		await unmount();
		await expect(persistInputDraft()).resolves.toBe(true);
	});

	it.each([
		"cached local draft",
		"",
	])("applies the current server draft on a normal revisit with cached text %j", async (cached) => {
		const { getByRole } = render(InputArea);
		const textarea = getByRole("textbox", {
			name: "Message",
		}) as HTMLTextAreaElement;
		await enterText(textarea, cached);
		sessionState.currentId = "other-session";
		await tick();
		sessionState.currentId = sessionId;
		await tick();

		await receiveDraft("newer draft from another tab");
		expect(textarea.value).toBe("newer draft from another tab");
	});

	it("protects a reload-restored draft only on its first restoration", async () => {
		sessionStorage.setItem(
			reloadDraftKey,
			JSON.stringify([[sessionId, "saved before reload"]]),
		);
		const { getByRole } = render(InputArea);
		const textarea = getByRole("textbox", {
			name: "Message",
		}) as HTMLTextAreaElement;
		await receiveDraft("older server draft");
		expect(textarea.value).toBe("saved before reload");
		expect(sessionStorage.getItem(reloadDraftKey)).toBeNull();

		sessionState.currentId = "other-session";
		await tick();
		sessionState.currentId = sessionId;
		await tick();
		await receiveDraft("newer draft from another tab");
		expect(textarea.value).toBe("newer draft from another tab");
	});

	it("still protects a real local edit from an older incoming sync", async () => {
		const { getByRole } = render(InputArea);
		const textarea = getByRole("textbox", {
			name: "Message",
		}) as HTMLTextAreaElement;
		await enterText(textarea, "just typed");
		await receiveDraft("older server draft");
		expect(textarea.value).toBe("just typed");
		vi.setSystemTime(Date.now() + 1_001);
		await receiveDraft("later remote edit");
		expect(textarea.value).toBe("later remote edit");
	});
});
