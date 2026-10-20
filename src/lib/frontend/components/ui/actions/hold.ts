/** A hold opens options without also activating the following tap. */
export function hold(
	node: HTMLElement,
	params: {
		onHold?: ((event?: PointerEvent) => void) | undefined;
		onPress?: ((event: PointerEvent) => void) | undefined;
		onMove?: ((event: PointerEvent) => void) | undefined;
		onRelease?: ((event: PointerEvent) => void) | undefined;
		onCancel?: (() => void) | undefined;
		/** Follow a held pointer, capturing it and blocking scroll until release. */
		followPointer?: boolean | undefined;
		keyboard?: boolean | undefined;
		ms?: number | undefined;
	},
) {
	let options = params;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pointerId: number | undefined;
	let startX = 0;
	let startY = 0;
	let pointerType = "";
	let swallowClick = false;
	let held = false;
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

	function clear() {
		clearTimeout(timer);
		timer = undefined;
		const captured = pointerId;
		pointerId = undefined;
		held = false;
		if (captured !== undefined && node.hasPointerCapture?.(captured))
			node.releasePointerCapture(captured);
	}

	function cancel() {
		if (pointerId === undefined) return;
		clear();
		options.onCancel?.();
	}

	function pointerdown(event: PointerEvent) {
		if (event.button !== 0 || !event.isPrimary || pointerId !== undefined)
			return;
		swallowClick = false;
		pointerType = event.pointerType;
		if (!options.onHold) return;
		pointerId = event.pointerId;
		startX = event.clientX;
		startY = event.clientY;
		options.onPress?.(event);
		timer = setTimeout(() => {
			timer = undefined;
			held = true;
			swallowClick = true;
			if (options.followPointer) {
				// Document listeners still track the pointer if capture is unavailable.
				try {
					node.setPointerCapture?.(event.pointerId);
				} catch {
					/* pointer ended */
				}
			}
			options.onHold?.(event);
		}, options.ms ?? 450);
	}

	function pointermove(event: PointerEvent) {
		if (event.pointerId !== pointerId) return;
		if (held) {
			options.onMove?.(event);
		} else if (Math.hypot(event.clientX - startX, event.clientY - startY) > 8) {
			cancel();
		}
	}

	function pointerend(event: PointerEvent) {
		if (event.pointerId !== pointerId) return;
		const wasHeld = held;
		if (wasHeld && options.followPointer) {
			event.preventDefault();
			event.stopPropagation();
		}
		clear();
		if (wasHeld) {
			// The callback may click the picked library item. Only swallow the
			// browser's subsequent compatibility click, not that selection.
			swallowClick = false;
			options.onRelease?.(event);
			swallowClick = true;
		} else options.onCancel?.();
	}

	function pointercancel(event: PointerEvent) {
		if (event.pointerId !== pointerId) return;
		swallowClick = true;
		cancel();
	}

	// Bubbles from a child that held the touch's implicit capture before ours.
	function lostpointercapture(event: PointerEvent) {
		if (event.target === node) pointercancel(event);
	}

	function scroll() {
		if (pointerId === undefined) return;
		swallowClick = true;
		cancel();
	}

	function touchmove(event: TouchEvent) {
		if (!held || !options.followPointer) return;
		event.preventDefault();
		event.stopPropagation();
	}

	function touchstart(event: TouchEvent) {
		if (event.touches.length > 1) scroll();
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
			!options.onHold ||
			options.keyboard === false ||
			!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
		)
			return;
		event.preventDefault();
		if (event.repeat) return;
		cancel();
		options.onHold();
	}

	function resetClick() {
		swallowClick = false;
	}

	node.addEventListener("pointerdown", pointerdown);
	document.addEventListener("pointerdown", resetClick, true);
	document.addEventListener("keydown", resetClick, true);
	document.addEventListener("pointermove", pointermove, true);
	document.addEventListener("pointerup", pointerend, true);
	document.addEventListener("pointercancel", pointercancel, true);
	node.addEventListener("lostpointercapture", lostpointercapture);
	document.addEventListener("scroll", scroll, true);
	document.defaultView?.addEventListener("blur", scroll);
	document.addEventListener("touchstart", touchstart, {
		capture: true,
		passive: true,
	});
	// Touches keep targeting the element they started on, so a trigger-scoped
	// listener sees the whole slide without making page scroll wait on it. It only
	// prevents scroll after the hold has fired, and stops the sheet's drag below.
	if (options.followPointer)
		node.addEventListener("touchmove", touchmove, { passive: false });
	// Capture runs before Svelte's delegated click handlers.
	document.addEventListener("click", click, true);
	node.addEventListener("contextmenu", contextmenu);
	node.addEventListener("keydown", keydown);

	return {
		update(next: typeof params) {
			cancel();
			node.removeEventListener("touchmove", touchmove);
			options = next;
			if (options.followPointer)
				node.addEventListener("touchmove", touchmove, { passive: false });
		},
		destroy() {
			cancel();
			node.removeEventListener("pointerdown", pointerdown);
			document.removeEventListener("pointerdown", resetClick, true);
			document.removeEventListener("keydown", resetClick, true);
			document.removeEventListener("pointermove", pointermove, true);
			document.removeEventListener("pointerup", pointerend, true);
			document.removeEventListener("pointercancel", pointercancel, true);
			node.removeEventListener("lostpointercapture", lostpointercapture);
			document.removeEventListener("scroll", scroll, true);
			document.defaultView?.removeEventListener("blur", scroll);
			document.removeEventListener("touchstart", touchstart, true);
			node.removeEventListener("touchmove", touchmove);
			document.removeEventListener("click", click, true);
			node.removeEventListener("contextmenu", contextmenu);
			node.removeEventListener("keydown", keydown);
			for (const { property, value, priority } of styles) {
				if (value) node.style.setProperty(property, value, priority);
				else node.style.removeProperty(property);
			}
		},
	};
}
