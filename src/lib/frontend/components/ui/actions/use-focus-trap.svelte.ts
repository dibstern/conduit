export interface FocusTrapOptions {
	/** Active or not. Toggle instead of remount. Default true. */
	enabled?: boolean;
	/** Focus on activate. Default: first focusable descendant. */
	initialFocus?: HTMLElement | (() => HTMLElement | null) | null;
	/** Restore focus here on teardown/disable. Default: activation target. */
	returnFocus?: HTMLElement | (() => HTMLElement | null) | null;
	/** Mark background siblings inert and aria-hidden. Default true. */
	inertBackground?: boolean;
}

const FOCUSABLE_SELECTOR =
	'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface BackgroundState {
	element: HTMLElement;
	inert: boolean;
	inertAttribute: string | null;
	ariaHidden: string | null;
}

function resolveTarget(
	target: HTMLElement | (() => HTMLElement | null) | null | undefined,
): HTMLElement | null {
	return typeof target === "function" ? target() : (target ?? null);
}

/** Stack of active trap roots; only the topmost reclaims escaped focus, so
 *  nested traps (e.g. a confirm dialog over a modal) don't fight or recurse. */
const activeTraps: HTMLElement[] = [];

export function focusTrap(
	node: HTMLElement,
	initialOptions: FocusTrapOptions = {},
): {
	update(options?: FocusTrapOptions): void;
	destroy(): void;
} {
	let options = initialOptions;
	let active = false;
	let activationTarget: HTMLElement | null = null;
	let addedTabindex = false;
	let background: BackgroundState[] = [];

	function focusableElements(): HTMLElement[] {
		return Array.from(
			node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
		).filter(
			(element) =>
				element.offsetParent !== null || element.getClientRects().length > 0,
		);
	}

	function focusFirst() {
		const target = focusableElements()[0] ?? node;
		if (target === node && !node.hasAttribute("tabindex")) {
			node.setAttribute("tabindex", "-1");
			addedTabindex = true;
		}
		target.focus();
	}

	function makeBackgroundInert() {
		let current = node;
		while (current.parentElement) {
			const parent = current.parentElement;
			for (const sibling of parent.children) {
				if (sibling === current || !(sibling instanceof HTMLElement)) continue;
				background.push({
					element: sibling,
					inert: sibling.inert === true,
					inertAttribute: sibling.getAttribute("inert"),
					ariaHidden: sibling.getAttribute("aria-hidden"),
				});
				sibling.inert = true;
				sibling.setAttribute("inert", "");
				sibling.setAttribute("aria-hidden", "true");
			}
			if (parent === document.body) break;
			current = parent;
		}
	}

	function restoreBackground() {
		for (const state of background.reverse()) {
			state.element.inert = state.inert;
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
		background = [];
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== "Tab") return;
		const focusable = focusableElements();
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) {
			event.preventDefault();
			focusFirst();
		} else if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	function handleFocusIn(event: FocusEvent) {
		if (activeTraps[activeTraps.length - 1] !== node) return;
		if (event.target instanceof Node && !node.contains(event.target)) {
			focusFirst();
		}
	}

	function activate() {
		if (active) return;
		active = true;
		activeTraps.push(node);
		activationTarget =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		if (options.inertBackground !== false) makeBackgroundInert();
		node.addEventListener("keydown", handleKeydown);
		document.addEventListener("focusin", handleFocusIn, true);
		const initialFocus = resolveTarget(options.initialFocus);
		if (initialFocus) initialFocus.focus();
		else focusFirst();
	}

	function deactivate() {
		if (!active) return;
		active = false;
		const stackIndex = activeTraps.lastIndexOf(node);
		if (stackIndex >= 0) activeTraps.splice(stackIndex, 1);
		node.removeEventListener("keydown", handleKeydown);
		document.removeEventListener("focusin", handleFocusIn, true);
		restoreBackground();
		if (addedTabindex) {
			node.removeAttribute("tabindex");
			addedTabindex = false;
		}
		const returnTarget =
			options.returnFocus === undefined
				? activationTarget
				: resolveTarget(options.returnFocus);
		if (returnTarget?.isConnected) returnTarget.focus();
		activationTarget = null;
	}

	if (options.enabled !== false) activate();

	return {
		update(nextOptions: FocusTrapOptions = {}) {
			const inertBackgroundChanged =
				(options.inertBackground !== false) !==
				(nextOptions.inertBackground !== false);
			options = nextOptions;
			if (options.enabled === false) deactivate();
			else if (!active) activate();
			else if (inertBackgroundChanged) {
				restoreBackground();
				if (options.inertBackground !== false) makeBackgroundInert();
			}
		},
		destroy() {
			deactivate();
		},
	};
}
