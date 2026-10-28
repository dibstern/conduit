import { expect, type Page } from "@playwright/test";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";
import { surfacingHistory } from "./surfacingCard.js";

const panel = (page: Page) => page.locator("#messages .turn-activity").last();
const preview = (page: Page) =>
	panel(page).getByTestId("surfacing-hover-preview");
const beforeHover = new WeakMap<Page, { height: number }>();
const previewBoxes = new WeakMap<
	Page,
	{ x: number; y: number; width: number; gap: number }
>();

export const turnHoverHandlers: StepHandler[] = [
	{
		name: "preserve the focused element while previewing an open card",
		match: /^the hover keeps keyboard focus$/,
		run: async ({ world }) => {
			expect(
				await world.page.evaluate(() =>
					document.activeElement?.hasAttribute("data-hover-focus-owner"),
				),
			).toBe(true);
		},
	},
	{
		name: "keep answered historical asks distinct from an open Ask",
		match: /^the historical Ask card is not labelled Needs reply$/,
		run: async ({ world }) => {
			await expect(
				panel(world.page)
					.getByTestId("surfacing-msg-card")
					.getByText("Needs reply", { exact: true }),
			).toHaveCount(0);
		},
	},
	{
		name: "leave hover without choosing a message",
		match: /^I leave the strip hover$/,
		run: async ({ world }) => {
			await world.page.mouse.move(0, 0);
		},
	},
	{
		name: "restore the selected card or Usage after hovering",
		match:
			/^the (open|usage) slot returns without selecting the hovered message$/,
		run: async ({ world, match }) => {
			await expect(preview(world.page)).toHaveCount(0);
			if (match[1] === "usage") {
				await expect(
					panel(world.page).getByRole("region", { name: "Turn usage" }),
				).toBeVisible();
				await expect(
					panel(world.page).getByTestId("surfacing-msg-card"),
				).toHaveCount(0);
			} else {
				await expect(
					panel(world.page).getByTestId("surfacing-msg-card"),
				).toHaveAttribute("data-ordinal", "2");
				await panel(world.page).getByTestId("surfacing-pin-2").hover();
				await expect(preview(world.page)).toHaveCount(0);
				await expect(
					panel(world.page).getByTestId("surfacing-msg-card"),
				).toBeVisible();
				await panel(world.page).getByTestId("surfacing-pin-4").hover();
				await expect(preview(world.page)).toHaveAttribute("data-ordinal", "4");
				await expect(
					panel(world.page).getByTestId("surfacing-pin-2"),
				).toHaveAttribute("aria-pressed", "true");
				await world.page.mouse.move(0, 0);
				await expect(
					panel(world.page).getByTestId("surfacing-msg-card"),
				).toHaveAttribute("data-ordinal", "2");
			}
		},
	},
	{
		name: "seed a failed or running work step",
		match: /^the hover session has a (failed|running|thinking) step$/,
		run: async ({ world, match }) => {
			const page = world.page;
			await page.clock.install({ time: PINNED_CLOCK_MS });
			await page.clock.pauseAt(PINNED_CLOCK_MS + 1_000);
			const running = match[1] !== "failed";
			const messages = surfacingHistory(running ? "live" : "settled").map(
				(message) => ({
					...message,
					parts: message.parts
						?.filter(
							(part) =>
								!running ||
								!part.id.startsWith("surfacing-") ||
								["surfacing-part-1", "surfacing-tool-1"].includes(part.id),
						)
						.map((part) =>
							part.id !== "surfacing-tool-1"
								? part
								: {
										...part,
										...(match[1] === "thinking"
											? {
													type: "reasoning" as const,
													text: "Checking the routing table.",
												}
											: {}),
										time: {
											start: PINNED_CLOCK_MS - 2_000,
											...(running ? {} : { end: PINNED_CLOCK_MS + 1_000 }),
										},
										state: {
											status: running ? "running" : "error",
											input: {
												_tag: "whole" as const,
												value: { filePath: "src/route-surfacing-tool-1.ts" },
											},
											...(running ? {} : { error: "Read failed" }),
										},
									},
						),
				}),
			);
			requireRpcControl(page).setDetailRows(
				"sess-surfacing",
				messages.flatMap(detailRowsOf),
			);
			setSessionRowStatus(page, "sess-surfacing", running ? "busy" : "idle", {
				title: "Hover work state",
				accountId: "claude",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(page, "sess-surfacing");
			await expect(panel(page)).toBeVisible();
		},
	},
	{
		name: "assert failure and running popover semantics",
		match:
			/^the step popover describes the (failed|running|thinking) work and its time$/,
		run: async ({ world, match }) => {
			const popover = panel(world.page).getByTestId("turn-step-popover");
			await expect(popover).toContainText(
				match[1] !== "failed" ? "Running" : "failed",
			);
			await expect(popover).toContainText(
				match[1] !== "failed" ? /\d+s so far/ : "3s",
			);
			await expect(popover).toContainText(
				match[1] !== "failed" ? "Step 2 · click" : "Step 2 of 16 · click",
			);
			const colour = await popover
				.locator("svg")
				.evaluate((element, running) => {
					const probe = document.createElement("span");
					probe.style.color = running
						? "var(--color-accent)"
						: "var(--color-seg-fail)";
					element.after(probe);
					const colours = [
						getComputedStyle(element).color,
						getComputedStyle(probe).color,
					];
					probe.remove();
					return colours;
				}, match[1] !== "failed");
			expect(colour[0]).toBe(colour[1]);
		},
	},
	{
		name: "scroll the last collapsed Turn near the transcript foot",
		match: /^I put the last strip near the transcript foot$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.setViewportSize({ width: 1440, height: 650 });
			await panel(page).scrollIntoViewIfNeeded();
			const strip = await panel(page).locator(".surface-strip").boundingBox();
			const messages = await page.locator("#messages").boundingBox();
			if (!strip || !messages) throw new Error("Missing transcript geometry");
			await page.locator("#messages").evaluate(
				(element, delta) => {
					element.scrollTop -= delta;
				},
				messages.y + messages.height - 25 - strip.y - strip.height,
			);
		},
	},
	{
		name: "assert the overlay flips above without clipping",
		match:
			/^the (tool|message) preview hangs above the strip within the transcript$/,
		run: async ({ world, match }) => {
			const overlay = panel(world.page).getByTestId(
				match[1] === "tool" ? "turn-step-popover" : "surfacing-hover-preview",
			);
			await expect(overlay).toBeVisible();
			const box = await overlay.boundingBox();
			const strip = await panel(world.page)
				.locator(".surface-strip")
				.boundingBox();
			const messages = await world.page.locator("#messages").boundingBox();
			if (!box || !strip || !messages)
				throw new Error("Missing overlay geometry");
			expect(box.y + box.height).toBeLessThan(strip.y);
			expect(box.y).toBeGreaterThanOrEqual(messages.y);
			await expect(overlay.locator("..")).toHaveAttribute("data-side", "top");
		},
	},
	{
		name: "choose the panel mode for a hover",
		match: /^the hover Turn is (collapsed|open|usage)$/,
		run: async ({ world, match }) => {
			if (match[1] === "open")
				await panel(world.page).getByTestId("surfacing-msg-card").focus();
			if (match[1] === "collapsed")
				await panel(world.page)
					.getByRole("button", { name: "Collapse turn", exact: true })
					.click();
			if (match[1] === "usage")
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
				/monospace/,
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
		match: /^I (click|tap) turn step tool 1$/,
		run: async ({ world, match }) => {
			const box = await panel(world.page)
				.locator('[data-step-id="surfacing-agent/surfacing-tool-1"]')
				.boundingBox();
			if (!box) throw new Error("Missing work segment");
			const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
			if (match[1] === "click") await world.page.mouse.click(point.x, point.y);
			else {
				const cdp = await world.page.context().newCDPSession(world.page);
				try {
					await cdp.send("Input.dispatchTouchEvent", {
						type: "touchStart",
						touchPoints: [point],
					});
					await cdp.send("Input.dispatchTouchEvent", {
						type: "touchEnd",
						touchPoints: [],
					});
				} finally {
					await cdp.detach();
				}
			}
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
			const paint = await row.evaluate((element) => {
				const probe = document.createElement("span");
				probe.style.backgroundColor = "var(--color-selection)";
				element.append(probe);
				const colours = [
					getComputedStyle(element).backgroundColor,
					getComputedStyle(probe).backgroundColor,
				];
				probe.remove();
				return colours;
			});
			expect(paint[0]).toBe(paint[1]);
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
				`[data-step-id*="/surfacing-${match[1] === "message" ? "part" : "tool"}-${match[2]}"]`,
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
			const strip = await panel(world.page)
				.locator(".surface-strip")
				.boundingBox();
			if (!box || !strip) throw new Error("Missing preview card or strip");
			previewBoxes.set(world.page, {
				...box,
				gap: box.y - strip.y - strip.height,
			});
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
			expect(after.y - (strip.y + strip.height)).toBeCloseTo(before.gap, 0);
		},
	},
];
