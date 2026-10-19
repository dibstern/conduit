/**
 * The session bar's global actions, shared by its title and overflow menus.
 *
 * They live here rather than being written twice because each one is a
 * contract with code somewhere else in the app: an event name, or a
 * multi-step sequence. A duplicated event name typo is silent, and a
 * duplicated sequence drifts.
 */

import { getBrowserClientId } from "../../stores/client-identity.js";
import { featureFlags } from "../../stores/feature-flags.svelte.js";
import {
	getCurrentRoute,
	getCurrentSessionId,
	getCurrentSlug,
} from "../../stores/router.svelte.js";
import { getActiveSession } from "../../stores/session.svelte.js";
import {
	beginCreateTab,
	failCreateTab,
	terminalState,
	togglePanel as toggleTerminalPanel,
} from "../../stores/terminal.svelte.js";
import { composerAccountId } from "../../stores/usage.svelte.js";
import { failureLine } from "../../transport/rpc-errors.js";
import { rpc } from "../../transport/ws-rpc-client.js";

export type SettingsSection =
	| "general"
	| "models"
	| "claude"
	| "archived"
	| "usage"
	| "server";

export type SettingsOpenDetail = {
	section: SettingsSection;
	anchor?: "instances";
};

declare global {
	interface WindowEventMap {
		"settings:open": CustomEvent<SettingsOpenDetail | null>;
	}
}

/** A generic open keeps the phone's section list; a section opens directly. */
export function openSettings(): void;
export function openSettings(
	section: SettingsSection,
	anchor?: "instances",
): void;
export function openSettings(
	section?: SettingsSection,
	anchor?: "instances",
): void {
	window.dispatchEvent(
		new CustomEvent<SettingsOpenDetail | null>("settings:open", {
			detail: section ? { section, ...(anchor ? { anchor } : {}) } : null,
		}),
	);
}

export function shareViaQr(): void {
	window.dispatchEvent(new CustomEvent("qr:show"));
}

export function toggleDebugPanel(): void {
	window.dispatchEvent(new CustomEvent("debug:toggle"));
}

export type ChromeMenuAction = {
	id: "share" | "settings" | "debug";
	label: string;
	icon: "share" | "settings" | "bug";
	run: () => void;
};

export function chromeMenuActions(): readonly ChromeMenuAction[] {
	return [
		{ id: "share", label: "Share", icon: "share", run: shareViaQr },
		{
			id: "settings",
			label: "Settings",
			icon: "settings",
			run: () => openSettings(),
		},
		...(featureFlags.debug
			? [
					{
						id: "debug" as const,
						label: "Debug panel",
						icon: "bug" as const,
						run: toggleDebugPanel,
					},
				]
			: []),
	];
}

/**
 * Show or hide the terminal panel. Opening it with no tabs yet also asks the
 * daemon for one, so the panel is never revealed empty. On a phone an open
 * terminal is the whole view (see ChatLayout), because a split terminal and
 * transcript leaves neither usable.
 */
/** A terminal opened from a session or draft uses its composer's account; elsewhere the server picks the default. */
export function terminalAccountId(): string | undefined {
	const route = getCurrentRoute();
	return route.page === "chat" && (getCurrentSessionId() || route.draft)
		? composerAccountId(getActiveSession())
		: undefined;
}

export function toggleTerminal(): void {
	const wasOpen = terminalState.panelOpen;
	toggleTerminalPanel();

	if (wasOpen) return;

	if (terminalState.tabs.size === 0) {
		const slug = getCurrentSlug();
		const sessionId = getCurrentSessionId();
		const accountId = terminalAccountId();
		if (slug && beginCreateTab()) {
			void rpc("CreatePty", {
				...(sessionId ? { sessionId } : { projectSlug: slug }),
				originId: getBrowserClientId(),
				...(accountId === undefined ? {} : { accountId }),
			}).catch((error) => {
				failCreateTab(failureLine(error, "Failed to create terminal"));
			});
		}
	}
}
