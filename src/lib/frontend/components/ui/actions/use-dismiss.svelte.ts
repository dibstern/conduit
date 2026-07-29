/**
 * Legacy dismissal action retained for the six feature consumers
 * ModelVariant, ContextWindowSelector, ModelSelector, ProjectSwitcher,
 * ThemePicker, and PermissionModeSelector until de3.3.4 migrates them to Bits.
 */
export interface DismissOptions {
	/** Fired on a dismiss gesture (outside-click or Escape). */
	onDismiss: () => void;
	/** Escape-to-dismiss. Default true. */
	escape?: boolean;
	/** Outside-click dismiss. Default true. */
	outsideClick?: boolean;
	/** Extra nodes counted as "inside" (portaled menu, trigger button). */
	ignore?: Array<HTMLElement | (() => HTMLElement | null) | null>;
	/** When false the action is inert. Default true. */
	enabled?: boolean;
}

/** Stack of dismissers in mount order; only the topmost enabled entry handles
 * Escape so stacked surfaces dismiss one per keypress. */
const activeDismissers: Array<{
	node: HTMLElement;
	isEnabled: () => boolean;
}> = [];

export function dismiss(
	node: HTMLElement,
	options: DismissOptions,
): {
	update(options: DismissOptions): void;
	destroy(): void;
} {
	function handleClick(event: MouseEvent) {
		const target = event.target;
		if (
			options.enabled === false ||
			options.outsideClick === false ||
			!(target instanceof Node) ||
			node.contains(target)
		) {
			return;
		}

		const ignored = options.ignore?.some((candidate) => {
			const element = typeof candidate === "function" ? candidate() : candidate;
			return element?.contains(target);
		});
		if (!ignored) options.onDismiss();
	}

	function handleKeydown(event: KeyboardEvent) {
		let topmostEnabled: (typeof activeDismissers)[number] | undefined;
		for (let index = activeDismissers.length - 1; index >= 0; index -= 1) {
			const entry = activeDismissers[index];
			if (entry?.isEnabled()) {
				topmostEnabled = entry;
				break;
			}
		}
		if (topmostEnabled?.node !== node) return;
		if (
			options.enabled !== false &&
			options.escape !== false &&
			event.key === "Escape" &&
			!event.isComposing
		) {
			options.onDismiss();
		}
	}

	const stackEntry = {
		node,
		isEnabled: () => options.enabled !== false,
	};
	activeDismissers.push(stackEntry);
	document.addEventListener("click", handleClick, true);
	document.addEventListener("keydown", handleKeydown);

	return {
		update(nextOptions: DismissOptions) {
			options = nextOptions;
		},
		destroy() {
			const stackIndex = activeDismissers.lastIndexOf(stackEntry);
			if (stackIndex !== -1) activeDismissers.splice(stackIndex, 1);
			document.removeEventListener("click", handleClick, true);
			document.removeEventListener("keydown", handleKeydown);
		},
	};
}
