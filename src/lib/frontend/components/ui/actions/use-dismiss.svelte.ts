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
	let pointerDownTarget: EventTarget | null = null;

	function isOutside(target: EventTarget | null) {
		if (!(target instanceof Node) || node.contains(target)) return false;

		return !options.ignore?.some((candidate) => {
			const element = typeof candidate === "function" ? candidate() : candidate;
			return element?.contains(target);
		});
	}

	function handlePointerdown(event: PointerEvent) {
		pointerDownTarget = event.target;
	}

	/**
	 * The test is "did this interaction BEGIN inside?", not "did it begin
	 * outside?" — the difference is the case where no pointerdown was recorded
	 * at all, and getting it backwards silently breaks the keyboard.
	 *
	 * A click has no preceding pointerdown when it comes from keyboard
	 * activation (Enter/Space on a focused control) or from a programmatic
	 * `.click()`. Requiring a recorded outside pointerdown would make those
	 * clicks stop dismissing, so tabbing out of an open dropdown and pressing
	 * Enter would leave it hanging open over the action just taken. Only an
	 * interaction we positively saw start inside is suppressed; anything else
	 * dismisses as before.
	 */
	function beganInside() {
		return (
			pointerDownTarget instanceof Node && node.contains(pointerDownTarget)
		);
	}

	function handleClick(event: MouseEvent) {
		const startedInside = beganInside();
		pointerDownTarget = null;
		if (
			options.enabled === false ||
			options.outsideClick === false ||
			startedInside ||
			!isOutside(event.target)
		) {
			return;
		}

		options.onDismiss();
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
	document.addEventListener("pointerdown", handlePointerdown, true);
	document.addEventListener("click", handleClick, true);
	document.addEventListener("keydown", handleKeydown);

	return {
		update(nextOptions: DismissOptions) {
			options = nextOptions;
		},
		destroy() {
			const stackIndex = activeDismissers.lastIndexOf(stackEntry);
			if (stackIndex !== -1) activeDismissers.splice(stackIndex, 1);
			document.removeEventListener("pointerdown", handlePointerdown, true);
			document.removeEventListener("click", handleClick, true);
			document.removeEventListener("keydown", handleKeydown);
		},
	};
}
