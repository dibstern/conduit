import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const panel = (page: Page) => page.locator("#messages .turn-activity").last();
const preview = (page: Page) =>
	panel(page).getByTestId("surfacing-hover-preview");
const beforeHover = new WeakMap<Page, { height: number }>();
const previewBoxes = new WeakMap<
	Page,
	{ x: number; y: number; width: number }
>();

export const turnHoverHandlers: StepHandler[] = [
	{
		name: "choose the panel mode for a hover",
		match: /^the hover Turn is (collapsed|open|Usage)$/,
		run: async ({ world, match }) => {
			if (match[1] === "collapsed")
				await panel(world.page)
					.getByRole("button", { name: "Collapse turn", exact: true })
					.click();
			if (match[1] === "Usage")
				await panel(world.page)
					.getByRole("tab", { name: "Usage", exact: true })
					.click();
			await world.page.mouse.move(0, 0);
		},
	},
	{
		name: "assert work popover content and marker",
		match: /^the step popover describes tool 1 as step 2 of 16$/,
		run: async ({ world }) => {
			const popover = panel(world.page).getByTestId("turn-step-popover");
			await expect(popover).toBeVisible();
			await expect(popover).toContainText("Read");
			await expect(popover).toContainText("src/route-surfacing-tool-1.ts");
			await expect(popover).toContainText("3s");
			await expect(popover).toContainText("00:10");
			await expect(popover).toContainText(
				"Step 2 of 16 · click to open it in the log",
			);
			await expect(popover.locator("svg")).toHaveCount(1);
			await expect(popover.locator("code")).toHaveCSS(
				"font-family",
				/JetBrains/,
			);
			await expect(
				panel(world.page).getByTestId("strip-hover-marker"),
			).toHaveCSS("width", "2px");
			await expect(world.page.getByRole("tooltip")).toHaveCount(0);
		},
	},
	{
		name: "track work rather than the nearest message",
		match:
			/^hovering across that work step keeps its own popover and moving marker$/,
		run: async ({ world }) => {
			const step = panel(world.page).locator(
				'[data-step-id="surfacing-agent/surfacing-tool-1"]',
			);
			const box = await step.boundingBox();
			if (!box) throw new Error("Missing work segment");
			for (const fraction of [0.15, 0.85]) {
				const x = box.x + box.width * fraction;
				await world.page.mouse.move(x, box.y + box.height / 2);
				await expect(
					panel(world.page).getByTestId("turn-step-popover"),
				).toContainText("Step 2 of 16");
				await expect(preview(world.page)).toHaveCount(0);
				const marker = await panel(world.page)
					.getByTestId("strip-hover-marker")
					.boundingBox();
				if (!marker) throw new Error("Missing hover marker");
				expect(Math.abs(marker.x + marker.width / 2 - x)).toBeLessThan(1);
			}
		},
	},
	{
		name: "dismiss any hover with Escape",
		match: /^I press Escape over the hover$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "assert hover dismissal",
		match: /^the strip hover is cleared$/,
		run: async ({ world }) => {
			for (const id of [
				"surfacing-hover-preview",
				"turn-step-popover",
				"strip-hover-marker",
			])
				await expect(panel(world.page).getByTestId(id)).toHaveCount(0);
		},
	},
	{
		name: "activate a step from the strip",
		match: /^I click turn step tool 1$/,
		run: async ({ world }) => {
			const box = await panel(world.page)
				.locator('[data-step-id="surfacing-agent/surfacing-tool-1"]')
				.boundingBox();
			if (!box) throw new Error("Missing work segment");
			await world.page.mouse.click(
				box.x + box.width / 2,
				box.y + box.height / 2,
			);
		},
	},
	{
		name: "assert Full log step landing and highlight",
		match: /^Full log opens at highlighted tool 1$/,
		run: async ({ world }) => {
			const row = panel(world.page).locator(
				'[data-log-part="surfacing-agent/surfacing-tool-1"]',
			);
			await expect(row).toBeInViewport();
			await expect(row).toBeFocused();
			await expect(row).toHaveCSS("background-color", /.+/);
			await expect(panel(world.page)).toHaveAttribute(
				"data-minimised",
				"false",
			);
			await expect(panel(world.page).locator(".step-log")).toBeVisible();
		},
	},
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
			beforeHover.set(page, { height: box.height });
			await page.evaluate(() =>
				document.activeElement?.setAttribute("data-hover-focus-owner", "true"),
			);
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
				await page.evaluate(() =>
					document.activeElement?.hasAttribute("data-hover-focus-owner"),
				),
			).toBe(true);
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
