import { beforeEach, describe, expect, it, vi } from "vitest";
import { sheetGlide } from "../../../src/lib/frontend/actions/drag-to-dismiss.js";

type Box = { left: number; top: number; width: number; height: number };

/** jsdom lays nothing out, so each element reports the box it would have on screen. */
function lay(element: HTMLElement, { left, top, width, height }: Box): void {
	const rect = {
		left,
		top,
		width,
		height,
		x: left,
		y: top,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	};
	element.getBoundingClientRect = () => rect;
	element.getClientRects = () =>
		(width > 0 ? [rect] : []) as unknown as DOMRectList;
	Object.defineProperty(element, "offsetHeight", {
		configurable: true,
		value: height,
	});
}

describe("a top sheet's entrance and exit", () => {
	let sheet: HTMLElement;
	let trigger: HTMLElement | null;
	let nextFrame: FrameRequestCallback | undefined;

	beforeEach(() => {
		document.body.innerHTML = `<div id="layout" data-pose="duo-folded-portrait"><button id="more"></button></div><div id="sheet"></div>`;
		sheet = document.getElementById("sheet") as HTMLElement;
		trigger = document.getElementById("more") as HTMLElement;
		lay(sheet, { left: 0, top: 100, width: 400, height: 400 });
		lay(trigger, { left: 340, top: 40, width: 40, height: 40 });
		nextFrame = undefined;
		vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
			nextFrame = run;
			return 1;
		});
	});

	const glide = (direction: "in" | "out") =>
		sheetGlide(sheet, { edge: "top", trigger: () => trigger })({ direction });
	const more = () => document.getElementById("more") as HTMLElement;

	it("grows out of its trigger in a Duo pose, then settles at rest", () => {
		expect(glide("in").duration).toBe(220);
		expect(sheet.style.transformOrigin).toBe("360px -40px");
		expect(sheet.style.transform).toBe("scale(0.1)");
		nextFrame?.(0);
		expect(sheet.style.transform).toBe("");
		expect(sheet.style.transition).toBe(
			"transform 220ms cubic-bezier(0.32, 0.72, 0, 1)",
		);
	});

	it("shrinks back into its trigger in a Duo pose", () => {
		expect(glide("out").duration).toBe(220);
		expect(sheet.style.transformOrigin).toBe("360px -40px");
		expect(sheet.style.transform).toBe("scale(0.1)");
	});

	it("grows from the side when its trigger sits beside it", () => {
		lay(sheet, { left: 80, top: 100, width: 400, height: 400 });
		lay(more(), { left: 0, top: 200, width: 40, height: 40 });
		glide("out");
		expect(sheet.style.transformOrigin).toBe("-60px 120px");
	});

	it("grows out of a control outside its popover that names its content", () => {
		trigger = null;
		more().setAttribute("aria-controls", "panel");
		sheet.innerHTML = `<section id="panel"></section>`;
		glide("out");
		expect(sheet.style.transformOrigin).toBe("360px -40px");
		expect(sheet.style.transform).toBe("scale(0.1)");
	});

	it("never grows past its resting size from a large trigger", () => {
		lay(more(), { left: 0, top: 40, width: 800, height: 40 });
		glide("out");
		expect(sheet.style.transform).toBe("scale(1)");
	});

	it.each([
		[
			"on a phone",
			() => more().closest("#layout")?.setAttribute("data-pose", "phone"),
		],
		[
			"on a desktop",
			() => more().closest("#layout")?.setAttribute("data-pose", "desktop"),
		],
		[
			"without a trigger",
			() => {
				trigger = null;
			},
		],
		[
			"with its trigger off screen",
			() => lay(more(), { left: 0, top: 0, width: 0, height: 0 }),
		],
	])("glides behind the header %s", (_, arrange) => {
		arrange();
		expect(glide("in").duration).toBe(220);
		expect(sheet.style.transform).toBe("translateY(-400px)");
		nextFrame?.(0);
		expect(sheet.style.transform).toBe("");
		expect(glide("out").duration).toBe(220);
		expect(sheet.style.transform).toBe("translateY(-400px)");
	});

	it("leaves the way it was dragged once a finger has put it away", () => {
		sheet.style.transform = "translateY(-400px)";
		expect(glide("out").duration).toBe(0);
		expect(sheet.style.transform).toBe("translateY(-400px)");
		expect(sheet.style.transformOrigin).toBe("");
	});
});
