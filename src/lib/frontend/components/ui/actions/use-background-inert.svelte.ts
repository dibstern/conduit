/**
 * Hides background content from assistive technology while a modal boundary is
 * active. Live portaled overlays register an exemption so menus, popovers, and
 * dialogs remain interactive even when they mount in a sibling body branch.
 */
interface BackgroundState {
	element: Element;
	inert: boolean | undefined;
	inertAttribute: string | null;
	ariaHidden: string | null;
}

const activeBoundaryNodes = new Set<HTMLElement>();
const activeOverlayNodes = new Set<HTMLElement>();
const backgroundStates = new Map<Element, BackgroundState>();
let backgroundObserver: MutationObserver | undefined;

function restoreBackground(state: BackgroundState) {
	if (state.element instanceof HTMLElement && state.inert !== undefined) {
		state.element.inert = state.inert;
	}
	if (state.inertAttribute === null) {
		state.element.removeAttribute("inert");
	} else {
		state.element.setAttribute("inert", state.inertAttribute);
	}
	if (state.ariaHidden === null) {
		state.element.removeAttribute("aria-hidden");
	} else {
		state.element.setAttribute("aria-hidden", state.ariaHidden);
	}
}

function containsLiveOverlay(element: Element): boolean {
	for (const overlay of activeOverlayNodes) {
		if (element === overlay || element.contains(overlay)) return true;
	}
	return false;
}

function syncBackground() {
	const background = new Set<Element>();

	for (const boundary of activeBoundaryNodes) {
		let current: Element = boundary;
		while (current.parentElement) {
			const parent = current.parentElement;
			for (const sibling of parent.children) {
				if (sibling !== current && !containsLiveOverlay(sibling)) {
					background.add(sibling);
				}
			}
			if (parent === document.body) break;
			current = parent;
		}
	}

	for (const element of background) {
		if (backgroundStates.has(element)) continue;
		backgroundStates.set(element, {
			element,
			inert: element instanceof HTMLElement ? element.inert : undefined,
			inertAttribute: element.getAttribute("inert"),
			ariaHidden: element.getAttribute("aria-hidden"),
		});
		if (element instanceof HTMLElement) element.inert = true;
		element.setAttribute("inert", "");
		element.setAttribute("aria-hidden", "true");
	}

	// Restore anything that dropped out of the freshly computed background.
	// This covers live-overlay registration and shrinking nested-boundary sets.
	for (const [element, state] of backgroundStates) {
		if (background.has(element)) continue;
		restoreBackground(state);
		backgroundStates.delete(element);
	}
}

function restoreAllBackground() {
	for (const state of Array.from(backgroundStates.values()).reverse()) {
		restoreBackground(state);
	}
	backgroundStates.clear();
}

/** Registers live portaled overlay content that background inerting must skip. */
export function exemptFromBackgroundInert(node: HTMLElement): {
	destroy(): void;
} {
	activeOverlayNodes.add(node);
	syncBackground();

	return {
		destroy() {
			activeOverlayNodes.delete(node);
			if (activeBoundaryNodes.size > 0) syncBackground();
		},
	};
}

export function backgroundInert(
	node: HTMLElement,
	initialEnabled = true,
): {
	update(enabled?: boolean): void;
	destroy(): void;
} {
	let active = false;

	function activate() {
		if (active) return;
		active = true;
		activeBoundaryNodes.add(node);
		if (!backgroundObserver) {
			backgroundObserver = new MutationObserver(syncBackground);
			backgroundObserver.observe(document.body, {
				childList: true,
				subtree: true,
			});
		}
		syncBackground();
	}

	function deactivate() {
		if (!active) return;
		active = false;
		activeBoundaryNodes.delete(node);
		if (activeBoundaryNodes.size === 0) {
			backgroundObserver?.disconnect();
			backgroundObserver = undefined;
			restoreAllBackground();
		} else {
			syncBackground();
		}
	}

	if (initialEnabled) activate();

	return {
		update(enabled = true) {
			if (enabled) activate();
			else deactivate();
		},
		destroy() {
			deactivate();
		},
	};
}
