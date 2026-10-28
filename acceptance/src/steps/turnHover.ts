import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const panel = (page: Page) => page.locator("#messages .turn-activity").last();
const preview = (page: Page) =>
	panel(page).getByTestId("surfacing-hover-preview");
const beforeHover = new WeakMap<Page, { height: number; focused: string }>();
const previewBoxes = new WeakMap<
	Page,
	{ x: number; y: number; width: number }
>();

export const turnHoverHandlers: StepHandler[] = [
	{
		name: "hover the actual message or work step",
		match: /^I hover turn step (message|tool) (\d+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			await page.clock.resume();
			await panel(page).scrollIntoViewIfNeeded();
			const scope = panel(page);
			const box = await scope.boundingBox();
			if (!box) throw new Error("Missing Turn");
			beforeHover.set(page, {
				height: box.height,
				focused: await page.evaluate(
					() => document.activeElement?.outerHTML ?? "",
				),
			});
			const step = scope.locator(
				`[data-step-id="surfacing-agent/surfacing-${match[1] === "message" ? "part" : "tool"}-${match[2]}"]`,
			);
			const target = await step.boundingBox();
			if (!target) throw new Error("Missing hovered step");
			await page.mouse.move(
				target.x + target.width / 2,
				target.y + target.height / 2,
			);
		},
	},
	{
		name: "assert full read-only hover card",
		match:
			/^the hanging preview shows full message (\d+) without actions or navigation$/,
		run: async ({ world, match }) => {
			const card = preview(world.page);
			await expect(card).toBeVisible();
			await expect(card).toHaveAttribute("data-ordinal", match[1] ?? "");
			await expect(card.locator(".md-content")).toHaveText(
				"The routing table has three consumers.",
			);
			await expect(card).toContainText("Finding");
			await expect(card).toContainText(
				"Hover preview · click to open the turn on this message",
			);
			await expect(card.locator("button, input, [tabindex]")).toHaveCount(0);
			const box = await card.boundingBox();
			if (!box) throw new Error("Missing preview card");
			previewBoxes.set(world.page, box);
		},
	},
	{
		name: "preview neither reads nor focuses nor pushes layout",
		match:
			/^the preview leaves focus, read state and collapsed layout unchanged$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.clock.runFor(1_200);
			const before = beforeHover.get(page);
			expect(before).toBeDefined();
			expect(
				await page.evaluate(() => document.activeElement?.outerHTML ?? ""),
			).toBe(before?.focused);
			expect((await panel(page).boundingBox())?.height).toBe(before?.height);
			await expect(panel(page)).toHaveAttribute("data-minimised", "true");
			expect(
				requireRpcControl(page)
					.getRequests()
					.filter((request) => request.tag === "SetMessagesRead")
					.some((request) =>
						JSON.stringify(request.payload).includes("surfacing-part-1"),
					),
			).toBe(false);
		},
	},
	{
		name: "click a hover card without taking focus",
		match: /^I click the hanging preview$/,
		run: async ({ world }) => {
			await preview(world.page).click();
		},
	},
	{
		name: "open a message in the same hanging position",
		match: /^message 1 opens where its preview hung$/,
		run: async ({ world }) => {
			const card = panel(world.page).getByTestId("surfacing-msg-card");
			await expect(card).toHaveAttribute("data-ordinal", "1");
			await expect(panel(world.page)).toHaveAttribute(
				"data-minimised",
				"false",
			);
			const before = previewBoxes.get(world.page);
			const after = await card.boundingBox();
			if (!before || !after) throw new Error("Missing hanging geometry");
			expect(Math.abs(before.x - after.x)).toBeLessThan(1);
			expect(Math.abs(before.width - after.width)).toBeLessThan(1);
			// Opening adds the pin lane above the same strip-relative hanging slot.
			const strip = await panel(world.page)
				.locator(".surface-strip")
				.boundingBox();
			if (!strip) throw new Error("Missing strip");
			expect(after.y - (strip.y + strip.height)).toBeCloseTo(10, 0);
		},
	},
];
