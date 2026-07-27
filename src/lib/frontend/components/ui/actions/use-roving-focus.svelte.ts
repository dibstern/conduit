export interface RovingFocusOptions {
	orientation?: "vertical" | "horizontal" | "both";
	/** Selector for items within node. */
	itemsSelector?: string;
	loop?: boolean;
	/** Highlight-only mode that leaves DOM focus on the host. */
	virtual?: boolean;
	/** Notified on active-index changes. */
	onHighlight?: (index: number, element: HTMLElement) => void;
	enabled?: boolean;
}

const DEFAULT_ITEMS_SELECTOR = '[role="option"],[role="menuitem"]';

export function rovingFocus(
	node: HTMLElement,
	initialOptions: RovingFocusOptions = {},
): {
	update(options?: RovingFocusOptions): void;
	destroy(): void;
} {
	let options = initialOptions;
	let activeIndex = 0;
	const originalTabindexes = new Map<HTMLElement, string | null>();

	function items(): HTMLElement[] {
		return Array.from(
			node.querySelectorAll<HTMLElement>(
				options.itemsSelector ?? DEFAULT_ITEMS_SELECTOR,
			),
		).filter(
			(element) =>
				!element.hasAttribute("disabled") &&
				element.getAttribute("aria-disabled") !== "true",
		);
	}

	function restoreTabindexes() {
		for (const [element, tabindex] of originalTabindexes) {
			if (tabindex === null) element.removeAttribute("tabindex");
			else element.setAttribute("tabindex", tabindex);
		}
		originalTabindexes.clear();
	}

	function syncTabindexes(currentItems = items()) {
		if (options.enabled === false || options.virtual === true) {
			restoreTabindexes();
			return;
		}

		const currentSet = new Set(currentItems);
		for (const [element, tabindex] of originalTabindexes) {
			if (currentSet.has(element)) continue;
			if (tabindex === null) element.removeAttribute("tabindex");
			else element.setAttribute("tabindex", tabindex);
			originalTabindexes.delete(element);
		}
		for (const [index, element] of currentItems.entries()) {
			if (!originalTabindexes.has(element)) {
				originalTabindexes.set(element, element.getAttribute("tabindex"));
			}
			element.setAttribute("tabindex", index === activeIndex ? "0" : "-1");
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (options.enabled === false) return;
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const orientation = options.orientation ?? "vertical";
		let targetIndex: number | null = null;
		let delta = 0;

		if (event.key === "Home") targetIndex = 0;
		else if (event.key === "End") targetIndex = Number.POSITIVE_INFINITY;
		else if (
			event.key === "ArrowDown" &&
			(orientation === "vertical" || orientation === "both")
		) {
			delta = 1;
		} else if (
			event.key === "ArrowUp" &&
			(orientation === "vertical" || orientation === "both")
		) {
			delta = -1;
		} else if (
			event.key === "ArrowRight" &&
			(orientation === "horizontal" || orientation === "both")
		) {
			delta = 1;
		} else if (
			event.key === "ArrowLeft" &&
			(orientation === "horizontal" || orientation === "both")
		) {
			delta = -1;
		} else {
			return;
		}

		const currentItems = items();
		if (currentItems.length === 0) return;
		event.preventDefault();
		if (!options.virtual && document.activeElement instanceof HTMLElement) {
			const focusedIndex = currentItems.indexOf(document.activeElement);
			if (focusedIndex >= 0) activeIndex = focusedIndex;
		}
		const currentIndex = Math.min(
			Math.max(activeIndex, 0),
			currentItems.length - 1,
		);

		const requestedIndex =
			targetIndex === Number.POSITIVE_INFINITY
				? currentItems.length - 1
				: (targetIndex ?? currentIndex + delta);
		const nextIndex =
			options.loop === false
				? Math.max(0, Math.min(requestedIndex, currentItems.length - 1))
				: (requestedIndex + currentItems.length) % currentItems.length;

		const indexChanged = nextIndex !== activeIndex;
		activeIndex = nextIndex;
		const activeItem = currentItems[activeIndex];
		if (!activeItem) return;
		if (options.virtual) {
			if (indexChanged) options.onHighlight?.(activeIndex, activeItem);
			return;
		}
		syncTabindexes(currentItems);
		// Always move DOM focus to the active item: pressing End/Home (or arrowing
		// after the list shrank) must land focus even when the index is unchanged.
		if (document.activeElement !== activeItem) activeItem.focus();
		if (indexChanged) options.onHighlight?.(activeIndex, activeItem);
	}

	node.addEventListener("keydown", handleKeydown);
	syncTabindexes();

	return {
		update(nextOptions: RovingFocusOptions = {}) {
			options = nextOptions;
			const currentItems = items();
			activeIndex = Math.min(activeIndex, Math.max(currentItems.length - 1, 0));
			syncTabindexes(currentItems);
		},
		destroy() {
			node.removeEventListener("keydown", handleKeydown);
			restoreTabindexes();
		},
	};
}
