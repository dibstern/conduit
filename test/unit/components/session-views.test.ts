import { beforeEach, describe, expect, it } from "vitest";
import {
	activeSessionView,
	matchSessionViewShortcut,
	sessionViews,
	viewShortcutHint,
} from "../../../src/lib/frontend/components/layout/session-views.js";
import { sessionViewState } from "../../../src/lib/frontend/stores/session-view.svelte.js";
import {
	closePanel,
	openPanel,
	terminalState,
} from "../../../src/lib/frontend/stores/terminal.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";

const chat = sessionViews.find((view) => view.id === "chat");
const files = sessionViews.find((view) => view.id === "files");

beforeEach(() => {
	sessionViewState.compact = false;
	sessionViewState.filesOpen = false;
	closePanel();
	uiState.fileViewerOpen = false;
});

describe("session view registry", () => {
	it("matches option digits by code regardless of the character produced", () => {
		for (const [index, view] of sessionViews.entries()) {
			const event = {
				code: `Digit${index + 1}`,
				altKey: true,
				ctrlKey: false,
				metaKey: false,
				shiftKey: false,
				repeat: false,
			};
			expect(matchSessionViewShortcut(event)).toBe(view);
			expect(viewShortcutHint(view)).toBe(`⌥${index + 1}`);
			for (const modifier of [
				"ctrlKey",
				"metaKey",
				"shiftKey",
				"repeat",
			] as const)
				expect(
					matchSessionViewShortcut({ ...event, [modifier]: true }),
				).toBeUndefined();
		}
		expect(
			matchSessionViewShortcut({
				code: "Numpad1",
				altKey: true,
				ctrlKey: false,
				metaKey: false,
				shiftKey: false,
				repeat: false,
			}),
		).toBeUndefined();
	});
	it("keeps Chat on and toggles Files independently on desktop", () => {
		expect(chat?.isOn()).toBe(true);
		files?.select();
		expect(files?.isOn()).toBe(true);
		expect(chat?.isOn()).toBe(true);
		chat?.select();
		expect(files?.isOn()).toBe(true);
		files?.select();
		expect(files?.isOn()).toBe(false);
	});

	it("shows one active view on phones", () => {
		sessionViewState.compact = true;
		files?.select();
		expect(files?.isOn()).toBe(true);
		expect(chat?.isOn()).toBe(false);
		chat?.select();
		expect(chat?.isOn()).toBe(true);
	});

	it("lets Terminal win on phones without discarding the file preview", () => {
		sessionViewState.filesOpen = true;
		openPanel();
		uiState.fileViewerOpen = true;
		sessionViewState.compact = true;
		expect(activeSessionView()).toBe("terminal");
		expect(files?.isOn()).toBe(false);

		files?.select();
		expect(activeSessionView()).toBe("files");
		expect(terminalState.panelOpen).toBe(false);
		expect(uiState.fileViewerOpen).toBe(true);
	});
});
