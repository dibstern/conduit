/**
 * Supplements Bits Dialog by hiding background content from assistive technology.
 * Bits owns focus trapping and dismissal, but does not apply aria-hidden or inert
 * outside the dialog.
 */
interface BackgroundState {
	element: Element;
	inert: boolean | undefined;
	inertAttribute: string | null;
	ariaHidden: string | null;
}

export function backgroundInert(
	node: HTMLElement,
	initialEnabled = true,
): {
	update(enabled?: boolean): void;
	destroy(): void;
} {
	let active = false;
	let background: BackgroundState[] = [];

	function activate() {
		if (active) return;
		active = true;

		let current: Element = node;
		while (current.parentElement) {
			const parent = current.parentElement;
			for (const sibling of parent.children) {
				if (sibling === current) continue;
				background.push({
					element: sibling,
					inert: sibling instanceof HTMLElement ? sibling.inert : undefined,
					inertAttribute: sibling.getAttribute("inert"),
					ariaHidden: sibling.getAttribute("aria-hidden"),
				});
				if (sibling instanceof HTMLElement) sibling.inert = true;
				sibling.setAttribute("inert", "");
				sibling.setAttribute("aria-hidden", "true");
			}
			if (parent === document.body) break;
			current = parent;
		}
	}

	function deactivate() {
		if (!active) return;
		active = false;

		for (const state of background.reverse()) {
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
		background = [];
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
