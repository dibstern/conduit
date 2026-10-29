import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { tapAt } from "./composer.js";
import {
	boxOf,
	INTERACTIVE,
	RAIL_LEFT,
	railControls,
	SLOT,
} from "./duoFoldedPortrait.js";

/** The full composer's one row of targets (mockup card 7). */
const ROW_TOP = 254;
const GLIDE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

type Glide = {
	name: string;
	delay: number;
	duration: number;
	easing: string;
	keyframes: {
		offset: number;
		opacity: string | undefined;
		transform: string | undefined;
	}[];
};

/** The handoff's running animations, one per control, read off the page. */
function handoffGlides(page: Page): Promise<Glide[]> {
	return page.evaluate((controls) => {
		return (
			document
				.getAnimations()
				// The handoff is scripted; a button's own colour transition is not part of it.
				.filter((animation) => !(animation instanceof CSSTransition))
				.flatMap((animation) => {
					const effect = animation.effect;
					if (!(effect instanceof KeyframeEffect) || !effect.target) return [];
					const target = effect.target;
					const name = Object.entries(controls).find(([, selector]) =>
						target.matches(selector),
					)?.[0];
					if (!name) return [];
					const timing = effect.getTiming();
					return [
						{
							name,
							delay: Number(timing.delay),
							duration: Number(timing.duration),
							easing: String(timing.easing),
							keyframes: effect.getKeyframes().map((frame) => ({
								offset: Number(frame.computedOffset),
								opacity: frame["opacity"] as string | undefined,
								transform: frame["transform"] as string | undefined,
							})),
						},
					];
				})
				.sort((a, b) => a.delay - b.delay)
		);
	}, railControls);
}

/** Wait out every finite animation; spinners run forever and are left alone. */
function settle(page: Page): Promise<void> {
	return page.evaluate(async () => {
		await Promise.all(
			document
				.getAnimations()
				.filter(
					(animation) =>
						typeof animation.effect?.getComputedTiming().endTime === "number" &&
						Number.isFinite(animation.effect.getComputedTiming().endTime),
				)
				.map((animation) => animation.finished.catch(() => undefined)),
		);
	});
}

function translateOf(transform = ""): { x: number; y: number } {
	const [, x = "0", y = "0"] =
		/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(transform) ?? [];
	return { x: Number(x), y: Number(y) };
}

function glideOf(glides: Glide[], name: string): Glide {
	const glide = glides.find((candidate) => candidate.name === name);
	if (!glide) throw new Error(`${name} does not glide`);
	return glide;
}

/** Where a control's glide starts: its resting corner plus its first offset. */
async function glideStart(
	page: Page,
	glide: Glide,
): Promise<{ x: number; y: number }> {
	const rest = await boxOf(page, railControls[glide.name] ?? "");
	const offset = translateOf(glide.keyframes[0]?.transform);
	return { x: rest.x + offset.x, y: rest.y + offset.y };
}

/**
 * Every interactive element a touch inside the area would land on, found by
 * hit-testing a 4px grid. Hit-testing, not boxes: transcript buttons scrolled
 * out of the message list keep boxes far down the page but take no touch.
 */
function tappablesIn(
	page: Page,
	area: { left: number; top: number; right: number; bottom: number },
): Promise<string[]> {
	return page.evaluate(
		({ area, selector }) => {
			const hits = new Map<Element, string>();
			const bottom = Math.min(area.bottom, innerHeight);
			const right = Math.min(area.right, innerWidth);
			for (let y = area.top + 1; y < bottom; y += 4)
				for (let x = area.left + 1; x < right; x += 4) {
					const hit = document.elementFromPoint(x, y)?.closest(selector);
					if (hit && !hits.has(hit))
						hits.set(hit, `${hit.outerHTML.slice(0, 80)} at x${x} y${y}`);
				}
			return [...hits.values()];
		},
		{ area, selector: INTERACTIVE },
	);
}

export const duoFoldedKeyboardHandlers: StepHandler[] = [
	{
		name: "focus the composer",
		match: /^I focus the composer$/,
		run: async ({ world }) => {
			await world.page.locator("#input-area textarea").focus();
		},
	},
	{
		// The form bar's tick blurs the field, which is what closes the keyboard.
		name: "close the keyboard",
		match: /^I close the keyboard$/,
		run: async ({ world }) => {
			await world.page.evaluate(() => {
				if (document.activeElement instanceof HTMLElement)
					document.activeElement.blur();
			});
		},
	},
	{
		name: "keyboard state",
		match: /^the keyboard is (open|closed)$/,
		run: async ({ world, match }) => {
			const layout = world.page.locator("#layout");
			if (match[1] === "open")
				await expect(layout).toHaveAttribute("data-keyboard", "open");
			else await expect(layout).not.toHaveAttribute("data-keyboard");
		},
	},
	{
		name: "handoff settles",
		match: /^the handoff settles$/,
		run: async ({ world }) => {
			await settle(world.page);
		},
	},
	{
		name: "full composer row slots",
		match: /^the composer row reads (.+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			await settle(page);
			for (const slot of (match[1] ?? "").split(", ")) {
				const [, name = "", left = "", right] =
					/^(\w+) at (\d+)(?: to (\d+))?$/.exec(slot) ?? [];
				const selector = railControls[name];
				if (!selector) throw new Error(`Unknown composer slot: ${slot}`);
				await expect(page.locator(selector)).toBeVisible();
				const box = await boxOf(page, selector);
				expect({ name, ...box }).toEqual({
					name,
					x: Number(left),
					y: ROW_TOP,
					width: right ? Number(right) - Number(left) : SLOT,
					height: SLOT,
				});
				const reachable = await page.evaluate(
					({ x, y, selector }) =>
						document.elementFromPoint(x, y)?.closest(selector) !== null,
					{ x: box.x + box.width / 2, y: box.y + SLOT / 2, selector },
				);
				expect(reachable, `${name} is covered`).toBe(true);
			}
		},
	},
	{
		name: "context hairline span",
		match: /^the context hairline spans y (\d+) to (\d+)$/,
		run: async ({ world, match }) => {
			const box = await boxOf(world.page, "[data-testid='context-hairline']");
			expect({ top: box.y, bottom: box.y + box.height }).toEqual({
				top: Number(match[1]),
				bottom: Number(match[2]),
			});
		},
	},
	{
		name: "nothing tappable below a line",
		match: /^nothing tappable sits below y (\d+)$/,
		run: async ({ world, match }) => {
			await settle(world.page);
			expect(
				await tappablesIn(world.page, {
					left: 0,
					top: Number(match[1]),
					right: Number.POSITIVE_INFINITY,
					bottom: Number.POSITIVE_INFINITY,
				}),
			).toEqual([]);
		},
	},
	{
		name: "nothing tappable in the rail",
		match: /^nothing tappable sits in the rail$/,
		run: async ({ world }) => {
			await settle(world.page);
			const railLeft = await world.page
				.locator("#duo-rail")
				.evaluate((rail) => rail.getBoundingClientRect().left);
			expect(railLeft).toBeLessThan(RAIL_LEFT);
			expect(
				await tappablesIn(world.page, {
					left: railLeft,
					top: 0,
					right: Number.POSITIVE_INFINITY,
					bottom: Number.POSITIVE_INFINITY,
				}),
			).toEqual([]);
		},
	},
	{
		name: "glide order and clock",
		match:
			/^the controls glide in the order (.+), (\d+) ms apart over (\d+) ms$/,
		run: async ({ world, match }) => {
			const glides = await handoffGlides(world.page);
			const step = Number(match[2]);
			expect(
				glides.map(({ name, delay, duration, easing }) => ({
					name,
					delay,
					duration,
					easing,
				})),
			).toEqual(
				(match[1] ?? "").split(", ").map((name, index) => ({
					name,
					delay: index * step,
					duration: Number(match[3]),
					easing: GLIDE_EASING,
				})),
			);
		},
	},
	{
		name: "effort and directory bud from or fold into Model",
		match: /^Effort and Directory (bud out of|fold back into) Model$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const glides = await handoffGlides(page);
			await settle(page);
			const opening = match[1] === "bud out of";
			const model = glideOf(glides, "Model");
			const modelPlace = opening
				? await glideStart(page, model)
				: await boxOf(page, railControls["Model"] ?? "");
			for (const name of ["Effort", "Directory"]) {
				const glide = glideOf(glides, name);
				const small = opening ? glide.keyframes[0] : glide.keyframes.at(-1);
				expect({ name, ...small }).toMatchObject({
					name,
					opacity: "0",
					transform: expect.stringContaining("scale(0.6)"),
				});
				const place = opening
					? await glideStart(page, glide)
					: await boxOf(page, railControls[name] ?? "");
				expect({ name, x: place.x, y: place.y }).toEqual({
					name,
					x: modelPlace.x,
					y: modelPlace.y,
				});
			}
		},
	},
	{
		name: "reduced-motion crossfade",
		match: /^the controls crossfade over (\d+) ms without moving$/,
		run: async ({ world, match }) => {
			const glides = await handoffGlides(world.page);
			expect(glides.map(({ name }) => name).sort()).toEqual(
				[
					"Attach",
					"Directory",
					"Effort",
					"Model",
					"Permissions",
					"Send",
				].sort(),
			);
			for (const glide of glides) {
				expect({ name: glide.name, delay: glide.delay }).toEqual({
					name: glide.name,
					delay: 0,
				});
				expect(glide.duration).toBe(Number(match[1]));
				expect(glide.keyframes.some((frame) => frame.opacity === "0")).toBe(
					true,
				);
				// A control may change place only in an instant, while it is invisible.
				const glidesWhileVisible = glide.keyframes
					.slice(1)
					.filter((frame, index) => {
						const previous = glide.keyframes[index];
						return (
							(frame.transform ?? "none") !== (previous?.transform ?? "none") &&
							(frame.offset !== previous?.offset || frame.opacity !== "0")
						);
					});
				expect({ name: glide.name, glidesWhileVisible }).toEqual({
					name: glide.name,
					glidesWhileVisible: [],
				});
			}
		},
	},
	{
		name: "touch a full composer control",
		match: /^I tap the composer's (\w+) control$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const box = await boxOf(page, railControls[match[1] ?? ""] ?? "");
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Emulation.setTouchEmulationEnabled", {
				enabled: true,
				maxTouchPoints: 1,
			});
			await tapAt(cdp, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
			await cdp.detach();
		},
	},
	{
		name: "no effort or directory in the closed composer",
		match: /^the composer shows no Effort or Directory control$/,
		run: async ({ world }) => {
			for (const name of ["Effort", "Directory"])
				await expect(
					world.page.locator(`#input-area ${railControls[name]}`),
				).toBeHidden();
		},
	},
	{
		name: "model sheet holds effort and checkout",
		match: /^the Model sheet holds the Effort and Checkout rows$/,
		run: async ({ world }) => {
			const sheet = world.page.getByTestId("model-picker");
			await expect(sheet.getByTestId("picker-row-effort")).toBeVisible();
			await expect(sheet.getByTestId("picker-row-checkout")).toBeVisible();
		},
	},
];
