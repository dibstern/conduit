import { type Component, tick } from "svelte";
import {
	sessionViewState,
	setRightPaneView,
} from "../../stores/session-view.svelte.js";
import { closePanel, terminalState } from "../../stores/terminal.svelte.js";
import { toggleTerminal } from "./chrome-actions.js";

export type SessionView = {
	id: "chat" | "terminal" | "diff" | "files";
	label: string;
	icon: string;
	badge?: () => number | undefined;
	shortcut: number;
	disabled?: boolean;
	loadPane?: () => Promise<{
		default: Component<{
			pane?: boolean;
			onClose?: () => void;
			visible?: boolean;
		}>;
	}>;
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
			(!terminalState.panelOpen && sessionViewState.rightPaneView === "closed"),
		select: () => {
			if (sessionViewState.compact) {
				closePanel();
				setRightPaneView("closed");
				return;
			}
			// A Files pane forced wide by a narrow window stays expanded anyway.
			sessionViewState.rightPaneExpanded = false;
			// Chat is inert while the pane is expanded, so focus after it renders.
			void tick().then(() => document.getElementById("input")?.focus());
		},
	},
	{
		id: "terminal",
		label: "Terminal",
		icon: "terminal",
		shortcut: 2,
		badge: () => terminalState.unreadPtyIds.size || undefined,
		isOn: () => terminalState.panelOpen,
		select: () => {
			if (sessionViewState.compact) {
				setRightPaneView("closed");
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
		loadPane: () => import("../diff/SessionDiff.svelte"),
		isOn: () =>
			sessionViewState.rightPaneView === "diff" &&
			(!sessionViewState.compact || !terminalState.panelOpen),
		select: () => selectPane("diff"),
	},
	{
		id: "files",
		label: "Files",
		icon: "folder-tree",
		shortcut: 4,
		loadPane: () => import("../file/SidebarFilePanel.svelte"),
		isOn: () =>
			sessionViewState.rightPaneView === "files" &&
			(!sessionViewState.compact || !terminalState.panelOpen),
		select: () => selectPane("files"),
	},
];

function selectPane(view: "files" | "diff"): void {
	if (sessionViewState.compact) closePanel();
	setRightPaneView(
		!sessionViewState.compact && sessionViewState.rightPaneView === view
			? "closed"
			: view,
	);
}

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
	if (sessionViewState.rightPaneView !== "closed")
		return sessionViewState.rightPaneView;
	return "chat";
}
