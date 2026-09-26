/**
 * The top bar's global actions, shared by the desktop Header and the phone
 * SessionBar's overflow menu.
 *
 * They live here rather than being written twice because each one is a
 * contract with code somewhere else in the app: an event name, or a
 * multi-step sequence. A duplicated event name typo is silent, and a
 * duplicated sequence drifts. One copy, two bars.
 */

import { getBrowserClientId } from "../../stores/client-identity.js";
import { getCurrentSlug } from "../../stores/router.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import {
	beginCreateTab,
	failCreateTab,
	terminalState,
	togglePanel as toggleTerminalPanel,
} from "../../stores/terminal.svelte.js";
import { createPtyRpc } from "../../transport/ws-rpc-client.js";

/** Open the settings panel, optionally straight to a named tab. */
export function openSettings(tab?: string): void {
	window.dispatchEvent(
		new CustomEvent("settings:open", tab ? { detail: { tab } } : undefined),
	);
}

export function shareViaQr(): void {
	window.dispatchEvent(new CustomEvent("qr:show"));
}

export function toggleDebugPanel(): void {
	window.dispatchEvent(new CustomEvent("debug:toggle"));
}

/**
 * Show or hide the terminal panel. Opening it with no tabs yet also asks the
 * daemon for one, so the panel is never revealed empty; on a phone it opens
 * maximized because a split terminal and transcript leaves neither usable.
 */
export function toggleTerminal(): void {
	const wasOpen = terminalState.panelOpen;
	toggleTerminalPanel();

	if (wasOpen) return;

	if (terminalState.tabs.size === 0) {
		const slug = getCurrentSlug();
		if (slug && beginCreateTab()) {
			void createPtyRpc({
				projectSlug: slug,
				originId: getBrowserClientId(),
			}).catch(() => {
				failCreateTab("Failed to create terminal");
			});
		}
	}

	if (sessionViewState.compact) {
		window.dispatchEvent(new CustomEvent("terminal:mobile-maximize"));
	}
}
