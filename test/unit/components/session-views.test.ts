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

const chat = sessionViews.find((view) => view.id === "chat");
const diff = sessionViews.find((view) => view.id === "diff");
const files = sessionViews.find((view) => view.id === "files");

beforeEach(() => {
	sessionViewState.compact = false;
	sessionViewState.rightPaneView = "closed";
	closePanel();
	sessionViewState.filePreview = null;
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
			// A hidden view (Servers with none running) keeps its digit but answers nothing.
			expect(matchSessionViewShortcut(event)).toBe(
				view.hidden?.() ? undefined : view,
			);
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
		sessionViewState.rightPaneView = "files";
		openPanel();
		sessionViewState.filePreview = { path: "src/index.ts", root: null };
		sessionViewState.compact = true;
		expect(activeSessionView()).toBe("terminal");
		expect(files?.isOn()).toBe(false);

		files?.select();
		expect(activeSessionView()).toBe("files");
		expect(terminalState.panelOpen).toBe(false);
		expect(sessionViewState.filePreview?.path).toBe("src/index.ts");
	});
});

it("switches Files and Diff through one pane value", () => {
	files?.select();
	diff?.select();
	expect(sessionViewState.rightPaneView).toBe("diff");
	expect(diff?.disabled).not.toBe(true);
	expect(files?.isOn()).toBe(false);
	expect(diff?.isOn()).toBe(true);
	diff?.select();
	expect(sessionViewState.rightPaneView).toBe("closed");
});
