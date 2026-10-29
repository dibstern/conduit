// The folded Duo's keyboard handoff glides the composer's controls between the
// rail and the full composer. The page-level result is covered by
// features/duo-folded-keyboard.feature; these rows pin the plan, which is where
// it can go wrong without anything looking broken in a still frame:
//
// 1. The order is by DOM position, not by distance travelled.
// 2. Send (or Stop then Send) is not last.
// 3. Effort and Directory are ranked by their own distance instead of following Model.
// 4. Closing replays the opening order, or the opening easing, instead of
//    playing the opening backwards.
// 5. The stagger counts a control that is not on screen, leaving a gap.
// 6. The model chip snaps from logo to full width instead of growing.
// 7. A bud starts at its resting place instead of on Model, or ends visible.
// 8. A folding bud is hidden by its parked visibility before it has shrunk.
// 9. Reduced motion still moves a control while it can be seen.
// 10. A missing Model drops Effort and Directory from the plan.
// 11. The stagger runs past the keyboard's 350ms instead of ending with it.

import { describe, expect, it } from "vitest";
import {
	type HandoffControl,
	planHandoff,
	type Rect,
} from "../../../src/lib/frontend/utils/composer-handoff.js";

const slot = (x: number, y: number, width = 44): Rect => ({
	x,
	y,
	width,
	height: 44,
});
const hidden: Rect = { x: 0, y: 0, width: 0, height: 0 };

const rail = {
	attach: slot(396, 591),
	model: slot(396, 543),
	effort: slot(396, 543),
	directory: slot(396, 543),
	permissions: slot(396, 495),
	send: slot(396, 447),
	stop: slot(396, 447),
};
const full = {
	attach: slot(26, 254),
	model: slot(74, 254, 116),
	effort: slot(194, 254),
	permissions: slot(238, 254),
	directory: slot(282, 254),
	send: slot(326, 254),
	stop: slot(282, 254),
};
type Name = keyof typeof rail;
const DOM_ORDER: Name[] = [
	"attach",
	"model",
	"effort",
	"permissions",
	"directory",
	"stop",
	"send",
];

const controls = (
	from: Partial<Record<Name, Rect>>,
	to: Partial<Record<Name, Rect>>,
): HandoffControl[] =>
	DOM_ORDER.filter((name) => from[name] && to[name]).map((name) => ({
		name,
		first: from[name] ?? hidden,
		last: to[name] ?? hidden,
	}));
const withoutStop = <T extends Partial<Record<Name, Rect>>>({
	stop: _stop,
	...rest
}: T) => rest;

const opening = planHandoff(controls(withoutStop(rail), withoutStop(full)), {
	opening: true,
	reduced: false,
});
const closing = planHandoff(controls(withoutStop(full), withoutStop(rail)), {
	opening: false,
	reduced: false,
});
const step = (plan: ReturnType<typeof planHandoff>, name: Name) => {
	const found = plan.find((candidate) => candidate.control.name === name);
	if (!found) throw new Error(`${name} is not in the plan`);
	return found;
};

describe("planHandoff glide", () => {
	it("moves the nearest first, buds right after Model, Send last, 25ms apart on one clock", () => {
		expect(
			opening.map(({ control, timing }) => ({ name: control.name, ...timing })),
		).toEqual(
			["permissions", "model", "effort", "directory", "attach", "send"].map(
				(name, index) => ({
					name,
					delay: index * 25,
					duration: 225,
					easing: "cubic-bezier(0.32, 0.72, 0, 1)",
					fill: "backwards",
					id: "duo-handoff",
				}),
			),
		);
	});

	it("lands the whole stagger on the keyboard's 350ms clock, Send last", () => {
		for (const plan of [opening, closing])
			expect(
				Math.max(
					...plan.map(
						({ timing }) => Number(timing.delay) + Number(timing.duration),
					),
				),
			).toBe(350);
	});

	it("closes as the opening played backwards: order, clock and easing", () => {
		expect(
			closing.map(({ control, timing }) => ({
				name: control.name,
				start: timing.delay,
				duration: timing.duration,
				easing: timing.easing,
			})),
		).toEqual(
			opening
				.map(({ control, timing }) => ({
					name: control.name,
					start: 350 - Number(timing.delay) - Number(timing.duration),
					duration: timing.duration,
					easing: "cubic-bezier(1, 0, 0.68, 0.28)",
				}))
				.reverse(),
		);
	});

	it("puts Stop before Send at the end when both show", () => {
		const plan = planHandoff(
			controls(
				{ ...rail, send: slot(396, 399) },
				{ ...full, model: slot(74, 254), effort: slot(122, 254) },
			),
			{ opening: true, reduced: false },
		);
		expect(plan.slice(-2).map(({ control }) => control.name)).toEqual([
			"stop",
			"send",
		]);
	});

	it("leaves out a control missing on either side and closes up the stagger", () => {
		const plan = planHandoff(
			controls(
				{ ...withoutStop(rail), attach: hidden },
				{ ...withoutStop(full), directory: hidden },
			),
			{ opening: true, reduced: false },
		);
		expect(
			plan.map(({ control, timing }) => [control.name, timing.delay]),
		).toEqual([
			["permissions", 0],
			["model", 25],
			["effort", 50],
			["send", 75],
		]);
	});

	it("keeps the given order for controls that travel equally far", () => {
		const plan = planHandoff(
			controls(
				{ attach: slot(0, 0), permissions: slot(0, 100) },
				{ attach: slot(10, 0), permissions: slot(10, 100) },
			),
			{ opening: true, reduced: false },
		);
		expect(plan.map(({ control }) => control.name)).toEqual([
			"attach",
			"permissions",
		]);
	});

	it("ranks by the distance travelled, not by where the control sits", () => {
		const plan = planHandoff(
			controls(
				{ attach: slot(0, 0), permissions: slot(0, 300) },
				{ attach: slot(0, 100), permissions: slot(0, 250) },
			),
			{ opening: true, reduced: false },
		);
		expect(plan.map(({ control }) => control.name)).toEqual([
			"permissions",
			"attach",
		]);
	});

	it("slides a control from where it was, and grows the model chip only when its width changes", () => {
		expect(step(opening, "attach").keyframes).toEqual([
			{ transform: "translate(370px, 337px)" },
			{ transform: "none" },
		]);
		expect(step(opening, "model").keyframes).toEqual([
			{ transform: "translate(322px, 289px)", width: "44px" },
			{ transform: "none", width: "116px" },
		]);
	});

	it("buds Effort and Directory out of Model's slot, faded and small", () => {
		expect(step(opening, "effort").keyframes).toEqual([
			{
				offset: 0,
				transform: "translate(202px, 289px) scale(0.6)",
				opacity: 0,
			},
			{ offset: 0.35, opacity: 1 },
			{ offset: 1, transform: "none", opacity: 1 },
		]);
	});

	it("folds them back into Model, visible until they have shrunk away", () => {
		expect(step(closing, "directory").keyframes).toEqual([
			{
				offset: 0,
				transform: "translate(-114px, -289px)",
				opacity: 1,
				visibility: "visible",
			},
			{ offset: 0.65, opacity: 1, visibility: "visible" },
			{ offset: 1, transform: "scale(0.6)", opacity: 0, visibility: "visible" },
		]);
	});

	it("still buds from the front when there is no Model", () => {
		const plan = planHandoff(
			controls(
				{ effort: rail.effort, attach: rail.attach },
				{ effort: full.effort, attach: full.attach },
			),
			{ opening: true, reduced: false },
		);
		expect(plan.map(({ control }) => control.name)).toEqual([
			"effort",
			"attach",
		]);
	});
});

describe("planHandoff reduced motion", () => {
	const reducedOpen = planHandoff(
		controls(withoutStop(rail), withoutStop(full)),
		{ opening: true, reduced: true },
	);
	const reducedClose = planHandoff(
		controls(withoutStop(full), withoutStop(rail)),
		{ opening: false, reduced: true },
	);

	it("crossfades every control at once over 150ms", () => {
		for (const { timing } of [...reducedOpen, ...reducedClose])
			expect(timing).toEqual({
				duration: 150,
				easing: "ease",
				fill: "backwards",
				id: "duo-handoff",
			});
	});

	it("jumps a control only while it is invisible", () => {
		expect(step(reducedOpen, "model").keyframes).toEqual([
			{
				offset: 0,
				transform: "translate(322px, 289px)",
				opacity: 1,
				width: "44px",
			},
			{
				offset: 0.5,
				transform: "translate(322px, 289px)",
				opacity: 0,
				width: "44px",
			},
			{ offset: 0.5, transform: "none", opacity: 0, width: "116px" },
			{ offset: 1, transform: "none", opacity: 1, width: "116px" },
		]);
	});

	it("forces only a folding bud visible, not a control that stays shown", () => {
		expect(
			step(reducedClose, "attach").keyframes.map((f) => f["visibility"]),
		).toEqual([undefined, undefined, undefined, undefined]);
	});

	it("only fades a bud in when opening, and only fades it out when closing", () => {
		expect(
			step(reducedOpen, "effort").keyframes.map((f) => f["opacity"]),
		).toEqual([0, 0, 0, 1]);
		expect(step(reducedClose, "effort").keyframes).toEqual([
			{
				offset: 0,
				transform: "translate(-202px, -289px)",
				opacity: 1,
				visibility: "visible",
			},
			{
				offset: 0.5,
				transform: "translate(-202px, -289px)",
				opacity: 0,
				visibility: "visible",
			},
			{ offset: 0.5, transform: "none", opacity: 0, visibility: "visible" },
			{ offset: 1, transform: "none", opacity: 0, visibility: "visible" },
		]);
	});
});
