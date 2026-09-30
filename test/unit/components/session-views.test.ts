import { beforeEach, describe, expect, it } from "vitest";
import {
	activeSessionView,
	sessionViews,
} from "../../../src/lib/frontend/components/layout/session-views.js";
import { sessionViewState } from "../../../src/lib/frontend/stores/session-view.svelte.js";
import { terminalState } from "../../../src/lib/frontend/stores/terminal.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";

const chat = sessionViews.find((view) => view.id === "chat");
const files = sessionViews.find((view) => view.id === "files");

beforeEach(() => {
	sessionViewState.compact = false;
	sessionViewState.filesOpen = false;
	terminalState.panelOpen = false;
	uiState.fileViewerOpen = false;
});

describe("session view registry", () => {
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
		terminalState.panelOpen = true;
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
