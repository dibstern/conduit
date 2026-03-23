/**
 * Svelte action that calls `callback` when a click lands outside the element.
 * Usage: <div use:clickOutside={() => (open = false)}>
 */
export function clickOutside(node: HTMLElement, callback: () => void) {
	function handleClick(e: MouseEvent) {
		if (!node.contains(e.target as Node)) {
			callback();
		}
	}

	document.addEventListener("click", handleClick, true);

	return {
		update(newCallback: () => void) {
			callback = newCallback;
		},
		destroy() {
			document.removeEventListener("click", handleClick, true);
		},
	};
}
