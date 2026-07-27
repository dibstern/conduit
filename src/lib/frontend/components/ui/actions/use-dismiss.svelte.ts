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
		if (
			options.enabled !== false &&
			options.escape !== false &&
			event.key === "Escape" &&
			!event.isComposing
		) {
			options.onDismiss();
		}
	}

	document.addEventListener("click", handleClick, true);
	document.addEventListener("keydown", handleKeydown);

	return {
		update(nextOptions: DismissOptions) {
			options = nextOptions;
		},
		destroy() {
			document.removeEventListener("click", handleClick, true);
			document.removeEventListener("keydown", handleKeydown);
		},
	};
}
