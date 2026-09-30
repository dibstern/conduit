import { tick } from "svelte";
import {
	sessionViewState,
	setFilesOpen,
} from "../../stores/session-view.svelte.js";
import { closePanel, terminalState } from "../../stores/terminal.svelte.js";
import { closeFileViewer } from "../../stores/ui.svelte.js";
import { toggleTerminal } from "./chrome-actions.js";

export type SessionView = {
	id: string;
	label: string;
	icon: string;
	badge?: () => number | undefined;
	shortcut: number;
	disabled?: boolean;
	isOn: () => boolean;
	select: () => void;
};

/** Phones show one view at a time. Desktop keeps chat visible and toggles
 *  side views independently, so `isOn` and `select` branch on `compact`. */
export const sessionViews: readonly SessionView[] = [
	{
		id: "chat",
		label: "Chat",
		icon: "message-square",
		shortcut: 1,
		isOn: () =>
			!sessionViewState.compact ||
			(!terminalState.panelOpen && !sessionViewState.filesOpen),
		select: () => {
			if (sessionViewState.compact) {
				closePanel();
				setFilesOpen(false);
				return;
			}
			// A Files pane forced wide by a narrow window stays expanded anyway.
			sessionViewState.filesPaneExpanded = false;
			// Chat is inert while the pane is expanded, so focus after it renders.
			void tick().then(() => document.getElementById("input")?.focus());
		},
	},
	{
		id: "terminal",
		label: "Terminal",
		icon: "square-terminal",
		shortcut: 2,
		badge: () => terminalState.unreadPtyIds.size || undefined,
		isOn: () => terminalState.panelOpen,
		select: () => {
			if (sessionViewState.compact) {
				setFilesOpen(false);
				if (terminalState.panelOpen) return;
			}
			toggleTerminal();
		},
	},
	{
		id: "diff",
		label: "Diff",
		icon: "code",
		shortcut: 3,
		disabled: true,
		isOn: () => false,
		select: () => {},
	},
	{
		id: "files",
		label: "Files",
		icon: "folder-tree",
		shortcut: 4,
		isOn: () =>
			sessionViewState.compact
				? !terminalState.panelOpen && sessionViewState.filesOpen
				: sessionViewState.filesOpen,
		select: () => {
			sessionViewState.filesEverOpened = true;
			if (sessionViewState.compact) {
				closePanel();
				setFilesOpen(true);
				return;
			}
			if (sessionViewState.filesOpen) closeFileViewer();
			setFilesOpen(!sessionViewState.filesOpen);
		},
	},
];

export function viewShortcutHint(view: SessionView): string {
	return `⌥${view.shortcut}`;
}

export function matchSessionViewShortcut(
	event: Pick<
		KeyboardEvent,
		"code" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat"
	>,
): SessionView | undefined {
	if (
		!event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.shiftKey ||
		event.repeat
	)
		return undefined;
	return sessionViews.find((view) => event.code === `Digit${view.shortcut}`);
}

export function activeSessionView(): string {
	if (terminalState.panelOpen) return "terminal";
	if (sessionViewState.filesOpen) return "files";
	return "chat";
}
