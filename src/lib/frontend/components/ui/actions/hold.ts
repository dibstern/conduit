/** A hold opens options without also activating the following tap. */
export function hold(
	node: HTMLElement,
	params: {
		onHold?: (() => void) | undefined;
		ms?: number | undefined;
	},
) {
	let { onHold, ms = 450 } = params;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pointerId: number | undefined;
	let startX = 0;
	let startY = 0;
	let pointerType = "";
	let swallowClick = false;
	const document = node.ownerDocument;
	const styles = [
		"-webkit-touch-callout",
		"-webkit-user-select",
		"user-select",
	].map((property) => ({
		property,
		value: node.style.getPropertyValue(property),
		priority: node.style.getPropertyPriority(property),
	}));
	for (const { property } of styles) node.style.setProperty(property, "none");

	function cancel() {
		clearTimeout(timer);
		timer = undefined;
		pointerId = undefined;
	}

	function pointerdown(event: PointerEvent) {
		if (event.button !== 0 || !event.isPrimary || pointerId !== undefined)
			return;
		swallowClick = false;
		pointerType = event.pointerType;
		if (!onHold) return;
		pointerId = event.pointerId;
		startX = event.clientX;
		startY = event.clientY;
		timer = setTimeout(() => {
			timer = undefined;
			swallowClick = true;
			onHold?.();
		}, ms);
	}

	function pointermove(event: PointerEvent) {
		if (
			event.pointerId === pointerId &&
			Math.hypot(event.clientX - startX, event.clientY - startY) > 8
		) {
			cancel();
		}
	}

	function pointerend(event: PointerEvent) {
		if (event.pointerId === pointerId) cancel();
	}

	function click(event: MouseEvent) {
		if (!swallowClick) return;
		swallowClick = false;
		event.preventDefault();
		event.stopImmediatePropagation();
	}

	function contextmenu(event: MouseEvent) {
		const type =
			event instanceof PointerEvent && event.pointerType
				? event.pointerType
				: pointerType;
		if (type === "touch") {
			event.preventDefault();
		}
	}

	function keydown(event: KeyboardEvent) {
		// A fresh keyboard activation must not inherit a pointer's unused click.
		swallowClick = false;
		if (
			!onHold ||
			!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
		)
			return;
		event.preventDefault();
		if (event.repeat) return;
		cancel();
		onHold();
	}

	node.addEventListener("pointerdown", pointerdown);
	document.addEventListener("pointermove", pointermove, true);
	document.addEventListener("pointerup", pointerend, true);
	document.addEventListener("pointercancel", pointerend, true);
	// Capture runs before Svelte's delegated click handlers.
	node.addEventListener("click", click, true);
	node.addEventListener("contextmenu", contextmenu);
	node.addEventListener("keydown", keydown);

	return {
		update(next: typeof params) {
			cancel();
			({ onHold, ms = 450 } = next);
		},
		destroy() {
			cancel();
			node.removeEventListener("pointerdown", pointerdown);
			document.removeEventListener("pointermove", pointermove, true);
			document.removeEventListener("pointerup", pointerend, true);
			document.removeEventListener("pointercancel", pointerend, true);
			node.removeEventListener("click", click, true);
			node.removeEventListener("contextmenu", contextmenu);
			node.removeEventListener("keydown", keydown);
			for (const { property, value, priority } of styles) {
				if (value) node.style.setProperty(property, value, priority);
				else node.style.removeProperty(property);
			}
		},
	};
}
