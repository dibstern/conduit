/**
 * In the installed iOS app a tap above about screen y64 never becomes a click,
 * though pointerdown and pointerup still arrive (conduit-test-uwxj8). So a
 * control inside `node` clicks itself when a primary touch lifts within
 * 10px and 700ms of pressing it. The browser's own mousedown and click, if they
 * follow, are dropped: the click would activate the control again, or whatever
 * the first activation put under the finger, and the mousedown would pull focus
 * back off the trigger a closing sheet just restored it to. Mouse, keyboard and click-only taps are
 * untouched, as is a control that handled the lift itself and prevented its
 * default (bits-ui menu triggers open on touch pointerup).
 */
// The click to drop often arrives after the lift unmounted its header, so this
// outlives every attachment. One set of listeners serves the whole document.
let dropClickUntil = 0;
const guarded = new WeakSet<Document>();

function guardClicks(document: Document) {
	if (guarded.has(document)) return;
	guarded.add(document);
	function drop(event: MouseEvent) {
		if (!event.isTrusted || event.timeStamp > dropClickUntil) return;
		if (event.type === "click") dropClickUntil = 0;
		event.preventDefault();
		event.stopImmediatePropagation();
	}
	// A new press or key starts a deliberate interaction whose click must land.
	function keepNextClick() {
		dropClickUntil = 0;
	}
	// Capture runs before Svelte's delegated handlers.
	document.addEventListener("mousedown", drop, true);
	document.addEventListener("click", drop, true);
	document.addEventListener("pointerdown", keepNextClick, true);
	document.addEventListener("keydown", keepNextClick, true);
}

export function clickOnLift(node: HTMLElement): () => void {
	const document = node.ownerDocument;
	let press:
		| {
				pointerId: number;
				x: number;
				y: number;
				at: number;
				control: HTMLElement;
		  }
		| undefined;

	const still = (event: PointerEvent, from: { x: number; y: number }) =>
		Math.hypot(event.clientX - from.x, event.clientY - from.y) < 10;

	function pointerdown(event: PointerEvent) {
		const control =
			event.target instanceof Element
				? event.target.closest<HTMLElement>("button, a[href], [role='button']")
				: null;
		press =
			control &&
			node.contains(control) &&
			event.isPrimary &&
			// Not pen: bits-ui menus open on a pen's pointerdown, so a click on lift
			// would close them again. iPhones, where the dead zone is, take no pen.
			event.pointerType === "touch"
				? {
						pointerId: event.pointerId,
						x: event.clientX,
						y: event.clientY,
						at: event.timeStamp,
						control,
					}
				: undefined;
	}

	function pointermove(event: PointerEvent) {
		if (event.pointerId === press?.pointerId && !still(event, press))
			press = undefined;
	}

	function pointercancel(event: PointerEvent) {
		if (event.pointerId === press?.pointerId) press = undefined;
	}

	// Listens on the document after Svelte's delegated handlers, so a control's
	// own pointerup has already run and could prevent the default.
	function pointerup(event: PointerEvent) {
		const pressed = press;
		if (event.pointerId !== pressed?.pointerId) return;
		press = undefined;
		if (
			event.defaultPrevented ||
			event.timeStamp - pressed.at >= 700 ||
			!still(event, pressed)
		)
			return;
		pressed.control.click();
		dropClickUntil = event.timeStamp + 600;
	}

	node.addEventListener("pointerdown", pointerdown);
	document.addEventListener("pointermove", pointermove, true);
	document.addEventListener("pointercancel", pointercancel, true);
	document.addEventListener("pointerup", pointerup);
	guardClicks(document);
	return () => {
		node.removeEventListener("pointerdown", pointerdown);
		document.removeEventListener("pointermove", pointermove, true);
		document.removeEventListener("pointercancel", pointercancel, true);
		document.removeEventListener("pointerup", pointerup);
	};
}
