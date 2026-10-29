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

type Press = {
	pointerId: number;
	x: number;
	y: number;
	at: number;
	control: HTMLElement;
};

const isStill = (event: PointerEvent, from: { x: number; y: number }) =>
	Math.hypot(event.clientX - from.x, event.clientY - from.y) < 10;

/** The press a primary touch starts on a control inside `node`, if any. */
function touchPress(node: HTMLElement, event: PointerEvent): Press | undefined {
	// Not pen: bits-ui menus open on a pen's pointerdown, so a click on lift
	// would close them again. iPhones, where the dead zone is, take no pen.
	if (!event.isPrimary || event.pointerType !== "touch") return undefined;
	const control =
		event.target instanceof Element
			? event.target.closest<HTMLElement>("button, a[href], [role='button']")
			: null;
	if (!control || !node.contains(control)) return undefined;
	return {
		pointerId: event.pointerId,
		x: event.clientX,
		y: event.clientY,
		at: event.timeStamp,
		control,
	};
}

/** Whether `event` comes from the pointer that made `press`. */
const continues = (
	press: Press | undefined,
	event: PointerEvent,
): press is Press => press?.pointerId === event.pointerId;

/** A short, still lift whose control did not handle it itself. */
const isTap = (press: Press, event: PointerEvent) =>
	!event.defaultPrevented &&
	event.timeStamp - press.at < 700 &&
	isStill(event, press);

export function clickOnLift(node: HTMLElement): () => void {
	const document = node.ownerDocument;
	let press: Press | undefined;

	function pointerdown(event: PointerEvent) {
		press = touchPress(node, event);
	}

	function pointermove(event: PointerEvent) {
		if (continues(press, event) && !isStill(event, press)) press = undefined;
	}

	// Listens on the document after Svelte's delegated handlers, so a control's
	// own pointerup has already run and could prevent the default.
	function pointerup(event: PointerEvent) {
		const pressed = press;
		if (!continues(pressed, event)) return;
		press = undefined;
		if (!isTap(pressed, event)) return;
		pressed.control.click();
		dropClickUntil = event.timeStamp + 600;
	}

	node.addEventListener("pointerdown", pointerdown);
	document.addEventListener("pointermove", pointermove, true);
	document.addEventListener("pointerup", pointerup);
	guardClicks(document);
	return () => {
		node.removeEventListener("pointerdown", pointerdown);
		document.removeEventListener("pointermove", pointermove, true);
		document.removeEventListener("pointerup", pointerup);
	};
}
