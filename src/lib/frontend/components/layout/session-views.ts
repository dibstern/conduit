import { sessionViewState } from "../../stores/session-view.svelte.js";
import { closePanel, terminalState } from "../../stores/terminal.svelte.js";
import { closeFileViewer } from "../../stores/ui.svelte.js";
import { toggleTerminal } from "./chrome-actions.js";

export type SessionView = {
	id: string;
	label: string;
	icon: string;
	badge?: () => number | undefined;
	shortcut?: string;
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
		isOn: () =>
			!sessionViewState.compact ||
			(!terminalState.panelOpen && !sessionViewState.filesOpen),
		select: () => {
			// Desktop Chat selection is reserved for 17xt.16's shortcuts.
			if (!sessionViewState.compact) return;
			closePanel();
			sessionViewState.filesOpen = false;
		},
	},
	{
		id: "terminal",
		label: "Terminal",
		icon: "square-terminal",
		badge: () => terminalState.unreadPtyIds.size || undefined,
		isOn: () => terminalState.panelOpen,
		select: () => {
			if (sessionViewState.compact) {
				sessionViewState.filesOpen = false;
				if (terminalState.panelOpen) return;
			}
			toggleTerminal();
		},
	},
	{
		id: "diff",
		label: "Diff",
		icon: "code",
		disabled: true,
		isOn: () => false,
		select: () => {},
	},
	{
		id: "files",
		label: "Files",
		icon: "folder-tree",
		isOn: () =>
			sessionViewState.compact
				? !terminalState.panelOpen && sessionViewState.filesOpen
				: sessionViewState.filesOpen,
		select: () => {
			sessionViewState.filesEverOpened = true;
			if (sessionViewState.compact) {
				closePanel();
				sessionViewState.filesOpen = true;
				return;
			}
			if (sessionViewState.filesOpen) closeFileViewer();
			sessionViewState.filesOpen = !sessionViewState.filesOpen;
		},
	},
];

export function activeSessionView(): string {
	if (terminalState.panelOpen) return "terminal";
	if (sessionViewState.filesOpen) return "files";
	return "chat";
}
