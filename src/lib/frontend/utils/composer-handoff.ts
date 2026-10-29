// The folded Duo's keyboard handoff (conduit-test-tw49i.5, mockup 7f): opening the
// keyboard moves the composer's controls from the rail into the full composer,
// and closing it moves them back. CSS places them; this glides them there with
// FLIP, measuring each control before and after the flip and animating the
// difference away. Only the controls move: a transform on the composer frame
// would become the containing block for its fixed-position controls.

const CONTROLS = {
	attach: "#attach-btn",
	model: '[data-testid="model-picker-trigger"]',
	effort: '[data-testid="variant-badge"]',
	permissions: '[data-testid="permission-mode-badge"]',
	directory: '[data-testid="composer-checkout"]',
	stop: "#stop",
	send: "#send",
} as const;

export type ControlName = keyof typeof CONTROLS;
export type Rect = { x: number; y: number; width: number; height: number };
export type HandoffControl = { name: ControlName; first: Rect; last: Rect };
export type HandoffStep<C extends HandoffControl> = {
	control: C;
	keyframes: Keyframe[];
	timing: KeyframeAnimationOptions;
};

const ID = "duo-handoff";
/** Effort and Directory live in the Model sheet on the rail, so they grow out of Model. */
const BUDS: readonly ControlName[] = ["effort", "directory"];
/** The send controls go last, wherever they start. */
const TRAILING: readonly ControlName[] = ["stop", "send"];
const BUD_SCALE = "scale(0.6)";

const travel = ({ first, last }: HandoffControl) =>
	Math.hypot(first.x - last.x, first.y - last.y);
const offset = ({ first, last }: HandoffControl) =>
	`translate(${first.x - last.x}px, ${first.y - last.y}px)`;
/** Width keys for the model chip, which is a logo on the rail and a full chip above the keyboard. */
const widths = ({ first, last }: HandoffControl): [Keyframe, Keyframe] =>
	first.width === last.width
		? [{}, {}]
		: [{ width: `${first.width}px` }, { width: `${last.width}px` }];

function glide(control: HandoffControl, opening: boolean): Keyframe[] {
	const from = offset(control);
	if (!BUDS.includes(control.name)) {
		const [start, end] = widths(control);
		return [
			{ transform: from, ...start },
			{ transform: "none", ...end },
		];
	}
	if (opening)
		return [
			{ offset: 0, transform: `${from} ${BUD_SCALE}`, opacity: 0 },
			{ offset: 0.35, opacity: 1 },
			{ offset: 1, transform: "none", opacity: 1 },
		];
	const visible = { visibility: "visible" };
	return [
		{ offset: 0, transform: from, opacity: 1, ...visible },
		{ offset: 0.65, opacity: 1, ...visible },
		{ offset: 1, transform: BUD_SCALE, opacity: 0, ...visible },
	];
}

/** Fade out where it was, jump while invisible, fade in where it goes. */
function fadeThrough(control: HandoffControl, opening: boolean): Keyframe[] {
	const bud = BUDS.includes(control.name);
	const from = offset(control);
	const [start, end] = widths(control);
	const visible = bud && !opening ? { visibility: "visible" } : {};
	return [
		{ offset: 0, transform: from, opacity: bud && opening ? 0 : 1, ...start },
		{ offset: 0.5, transform: from, opacity: 0, ...start },
		{ offset: 0.5, transform: "none", opacity: 0, ...end },
		{ offset: 1, transform: "none", opacity: bud && !opening ? 0 : 1, ...end },
	].map((frame) => ({ ...frame, ...visible }));
}

/**
 * One 350ms clock, 25ms apart: the controls with least to travel go first,
 * Effort and Directory right behind Model, then Stop and Send. Closing plays the
 * same order backwards. Reduced motion crossfades everything at once in 150ms.
 */
export function planHandoff<C extends HandoffControl>(
	controls: C[],
	{ opening, reduced }: { opening: boolean; reduced: boolean },
): HandoffStep<C>[] {
	const shown = controls.filter(
		({ first, last }) => first.width > 0 && last.width > 0,
	);
	const movers = shown
		.filter(({ name }) => !BUDS.includes(name) && !TRAILING.includes(name))
		.sort((a, b) => travel(a) - travel(b));
	const afterModel = movers.findIndex(({ name }) => name === "model") + 1;
	const order = [
		...movers.slice(0, afterModel),
		...shown.filter(({ name }) => BUDS.includes(name)),
		...movers.slice(afterModel),
		...TRAILING.flatMap((name) => shown.filter((c) => c.name === name)),
	];
	if (!opening) order.reverse();
	return order.map((control, index) => ({
		control,
		keyframes: (reduced ? fadeThrough : glide)(control, opening),
		timing: reduced
			? { duration: 150, easing: "ease", fill: "backwards", id: ID }
			: {
					delay: index * 25,
					duration: 350,
					easing: "cubic-bezier(0.32, 0.72, 0, 1)",
					fill: "backwards",
					id: ID,
				},
	}));
}

function measure(root: Element) {
	return Object.entries(CONTROLS).flatMap(([name, selector]) => {
		const element = root.querySelector<HTMLElement>(selector);
		return element
			? [
					{
						name: name as ControlName,
						element,
						first: element.getBoundingClientRect(),
					},
				]
			: [];
	});
}

function cancelHandoff(root: Element): void {
	for (const animation of root
		.getAnimations({ subtree: true })
		.filter(({ id }) => id === ID))
		animation.cancel();
}

/**
 * Measure the controls now, before the flip, and return what plays the glide
 * once the flip has rendered. An interrupted handoff starts from where its
 * controls are mid-flight: they are measured before its animations are cancelled.
 */
export function prepareHandoff(root: Element, opening: boolean): () => void {
	const measured = measure(root);
	cancelHandoff(root);
	return () => {
		const controls = measured.map((control) => ({
			...control,
			last: control.element.getBoundingClientRect(),
		}));
		const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
		for (const { control, keyframes, timing } of planHandoff(controls, {
			opening,
			reduced,
		}))
			control.element.animate(keyframes, timing);
	};
}
