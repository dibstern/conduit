import { sessionViewState } from "../../stores/session-view.svelte.js";
import { closePanel, terminalState } from "../../stores/terminal.svelte.js";
import { toggleTerminal } from "./chrome-actions.js";

export type SessionView = {
	id: string;
	label: string;
	icon: string;
	badge?: () => number | undefined;
	shortcut?: string;
	disabled?: boolean;
	isActive: () => boolean;
	activate: () => void;
};

export const sessionViews: readonly SessionView[] = [
	{
		id: "chat",
		label: "Chat",
		icon: "message-square",
		isActive: () => !terminalState.panelOpen && !sessionViewState.filesOpen,
		activate: () => {
			closePanel();
			sessionViewState.filesOpen = false;
		},
	},
	{
		id: "terminal",
		label: "Terminal",
		icon: "square-terminal",
		badge: () => terminalState.unreadPtyIds.size || undefined,
		isActive: () => terminalState.panelOpen,
		activate: () => {
			sessionViewState.filesOpen = false;
			if (!terminalState.panelOpen) toggleTerminal();
		},
	},
	{
		id: "diff",
		label: "Diff",
		icon: "code",
		disabled: true,
		isActive: () => false,
		activate: () => {},
	},
	{
		id: "files",
		label: "Files",
		icon: "folder-tree",
		isActive: () => !terminalState.panelOpen && sessionViewState.filesOpen,
		activate: () => {
			closePanel();
			sessionViewState.filesEverOpened = true;
			sessionViewState.filesOpen = true;
		},
	},
];

export function activeSessionView(): string {
	return sessionViews.find((view) => view.isActive())?.id ?? "chat";
}
