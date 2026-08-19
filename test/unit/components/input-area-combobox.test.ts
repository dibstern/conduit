import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InputArea from "../../../src/lib/frontend/components/input/InputArea.svelte";
import {
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
	phaseToIdle,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { discoveryState } from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { fileTreeState } from "../../../src/lib/frontend/stores/file-tree.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

const testSessionId = "input-area-combobox-test";

async function enterText(textarea: HTMLTextAreaElement, text: string) {
	textarea.value = text;
	textarea.setSelectionRange(text.length, text.length);
	await fireEvent.input(textarea);
}

function keydown(textarea: HTMLTextAreaElement, key: string) {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
	});
	fireEvent(textarea, event);
	return event;
}

describe("InputArea detached listboxes", () => {
	beforeEach(() => {
		sessionState.currentId = testSessionId;
		phaseToIdle();
		getOrCreateSessionActivity(testSessionId).phase = "idle";
		getOrCreateSessionMessages(testSessionId).contextPercent = 0;
		discoveryState.commands = [
			{ name: "review", description: "Review a pull request" },
			{ name: "compact", description: "Compact conversation history" },
			{ name: "config", description: "View configuration" },
		];
		fileTreeState.entries = ["README.md", "src/index.ts"];
		fileTreeState.loading = false;
		fileTreeState.loaded = true;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 0;
		});
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		cleanup();
		sessionState.currentId = null;
		discoveryState.commands = [];
		fileTreeState.entries = [];
		fileTreeState.loading = false;
		fileTreeState.loaded = false;
		vi.unstubAllGlobals();
	});

	it("keeps FileMenu ownership on the textarea and commits Tab", async () => {
		const { getByRole, getAllByRole, queryByRole } = render(InputArea);
		const textarea = getByRole("combobox", {
			name: "Message",
		}) as HTMLTextAreaElement;
		textarea.focus();
		await enterText(textarea, "@");

		const listbox = getByRole("listbox", { name: "File suggestions" });
		expect(textarea.getAttribute("aria-expanded")).toBe("true");
		expect(
			document.getElementById(textarea.getAttribute("aria-controls") ?? ""),
		).toBe(listbox);
		let options = getAllByRole("option");
		expect(
			document.getElementById(
				textarea.getAttribute("aria-activedescendant") ?? "",
			),
		).toBe(options[0]);
		expect(document.activeElement).toBe(textarea);

		keydown(textarea, "ArrowDown");
		await waitFor(() => {
			options = getAllByRole("option");
			expect(options[1]?.getAttribute("aria-selected")).toBe("true");
			expect(
				document.getElementById(
					textarea.getAttribute("aria-activedescendant") ?? "",
				),
			).toBe(options[1]);
		});

		const tab = keydown(textarea, "Tab");
		expect(tab.defaultPrevented).toBe(true);
		await waitFor(() => {
			expect(textarea.value).toBe("@src/index.ts ");
			expect(queryByRole("listbox", { name: "File suggestions" })).toBeNull();
			expect(textarea.getAttribute("aria-expanded")).toBe("false");
			expect(document.activeElement).toBe(textarea);
		});
	});

	it("keeps CommandMenu ownership on the textarea and commits Tab", async () => {
		const { getByRole, getAllByRole, queryByRole } = render(InputArea);
		const textarea = getByRole("combobox", {
			name: "Message",
		}) as HTMLTextAreaElement;
		textarea.focus();
		await enterText(textarea, "/");

		const listbox = getByRole("listbox", { name: "Slash commands" });
		expect(textarea.getAttribute("aria-expanded")).toBe("true");
		expect(
			document.getElementById(textarea.getAttribute("aria-controls") ?? ""),
		).toBe(listbox);
		expect(document.querySelectorAll("#command-menu")).toHaveLength(1);
		expect(document.querySelectorAll("#command-menu-wrap")).toHaveLength(1);
		let options = getAllByRole("option");
		expect(
			document.getElementById(
				textarea.getAttribute("aria-activedescendant") ?? "",
			),
		).toBe(options[0]);
		expect(document.activeElement).toBe(textarea);

		keydown(textarea, "ArrowDown");
		await waitFor(() => {
			options = getAllByRole("option");
			expect(options[1]?.getAttribute("aria-selected")).toBe("true");
			expect(
				document.getElementById(
					textarea.getAttribute("aria-activedescendant") ?? "",
				),
			).toBe(options[1]);
		});

		const tab = keydown(textarea, "Tab");
		expect(tab.defaultPrevented).toBe(true);
		await waitFor(() => {
			expect(textarea.value).toBe("/config ");
			expect(queryByRole("listbox", { name: "Slash commands" })).toBeNull();
			expect(textarea.getAttribute("aria-expanded")).toBe("false");
			expect(document.activeElement).toBe(textarea);
		});
	});

	it("keeps the loading FileMenu expanded without an active descendant", async () => {
		fileTreeState.entries = [];
		fileTreeState.loading = true;
		const { getByRole, queryByRole } = render(InputArea);
		const textarea = getByRole("combobox", {
			name: "Message",
		}) as HTMLTextAreaElement;
		textarea.focus();
		await enterText(textarea, "@");

		const listbox = getByRole("listbox", { name: "File suggestions" });
		expect(textarea.getAttribute("aria-expanded")).toBe("true");
		expect(
			document.getElementById(textarea.getAttribute("aria-controls") ?? ""),
		).toBe(listbox);
		expect(textarea.hasAttribute("aria-activedescendant")).toBe(false);
		expect(listbox.getAttribute("aria-busy")).toBe("true");
		expect(queryByRole("option")).toBeNull();
	});
});
