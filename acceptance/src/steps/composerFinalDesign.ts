import { expect, type Locator, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

// Literal values from docs/plans/2026-10-02-composer-final-designs.html.
const BUTTON = 32;
const SEND_OFF = { background: "rgb(74, 34, 51)", color: "rgb(185, 138, 156)" };

async function box(locator: Locator) {
	const rect = await locator.boundingBox();
	if (!rect) throw new Error(`${locator} has no box`);
	return rect;
}

async function expectSquare(locator: Locator, size: number): Promise<void> {
	await expect
		.poll(
			async () => {
				const { width, height } = await box(locator);
				return Math.abs(width - size) <= 0.5 && Math.abs(height - size) <= 0.5;
			},
			{ message: `${locator} is a ${size}px square` },
		)
		.toBe(true);
}

const style = (locator: Locator, property: string) =>
	locator.evaluate(
		(element, name) => getComputedStyle(element).getPropertyValue(name),
		property,
	);

const sessionIdOf = (page: Page): string => {
	const sessionId = new URL(page.url()).pathname.split("/")[2];
	if (!sessionId) throw new Error("No session is open");
	return sessionId;
};

export const composerFinalDesignHandlers: StepHandler[] = [
	{
		name: "assert composer placeholder text",
		match: /^the composer placeholder reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#input")).toHaveAttribute(
				"placeholder",
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert placeholder shares the controls row",
		match: /^the placeholder sits on the controls row$/,
		run: async ({ world }) => {
			const input = world.page.locator("#input");
			const send = await box(world.page.locator("#send"));
			const model = await box(world.page.getByTestId("model-picker-trigger"));
			const line = await input.evaluate((textarea) => {
				const rect = textarea.getBoundingClientRect();
				const css = getComputedStyle(textarea);
				const lineHeight = Number.parseFloat(css.lineHeight);
				return {
					centre: rect.top + Number.parseFloat(css.paddingTop) + lineHeight / 2,
					right: rect.right,
				};
			});
			// One row: the first text line is vertically centred with the 32px controls.
			expect(
				Math.abs(line.centre - (send.y + send.height / 2)),
			).toBeLessThanOrEqual(2);
			expect(line.right).toBeLessThanOrEqual(model.x + 1);
		},
	},
	{
		name: "assert no standalone agent selector",
		match: /^the composer has no standalone agent selector$/,
		run: async ({ world }) => {
			await expect(
				world.page.locator(
					"#composer-layout #agent-selector, #agent-selector-wrap, [data-testid='composer-layout'] #agent-selector",
				),
			).toHaveCount(0);
		},
	},
	{
		name: "assert phone model button",
		match: /^the model button is ([0-9]+) pixels tall and reads (.+)$/,
		run: async ({ world, match }) => {
			const trigger = world.page.getByTestId("model-picker-trigger");
			await expect(trigger).toHaveText(match[2] ?? "");
			expect(
				Math.abs((await box(trigger)).height - Number(match[1])),
			).toBeLessThanOrEqual(0.5);
		},
	},
	{
		name: "assert desktop model chip",
		match: /^the model chip reads (.+) with a chevron$/,
		run: async ({ world, match }) => {
			const trigger = world.page.getByTestId("model-picker-trigger");
			await expect(trigger).toHaveText(match[1] ?? "");
			await expect(trigger.getByTestId("model-chip-chevron")).toBeVisible();
			expect(
				Math.abs((await box(trigger)).height - BUTTON),
			).toBeLessThanOrEqual(0.5);
		},
	},
	{
		name: "assert effort meter visible",
		match: /^the effort meter is visible$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByTestId("variant-badge")
					.locator("[data-testid='effort-meter']"),
			).toBeVisible();
		},
	},
	{
		name: "assert desktop effort chip",
		match: /^the effort chip reads (.+)$/,
		run: async ({ world, match }) => {
			const chip = world.page.getByTestId("variant-badge");
			await expect(chip).toHaveText(match[1] ?? "");
			await expect(chip.getByTestId("effort-meter")).toBeVisible();
			expect(Math.abs((await box(chip)).height - BUTTON)).toBeLessThanOrEqual(
				0.5,
			);
		},
	},
	{
		name: "assert send off state",
		match: /^send is a 32 pixel square in the off colours$/,
		run: async ({ world }) => {
			const send = world.page.locator("#send");
			await expectSquare(send, BUTTON);
			expect(await style(send, "background-color")).toBe(SEND_OFF.background);
			expect(await style(send, "color")).toBe(SEND_OFF.color);
			expect(await style(send, "opacity")).toBe("1");
		},
	},
	{
		name: "assert plain attach button",
		match: /^the attach button has no border$/,
		run: async ({ world }) => {
			const attach = world.page.locator("#attach-btn");
			await expectSquare(attach, BUTTON);
			expect(await style(attach, "border-top-width")).toBe("0px");
		},
	},
	{
		name: "start open session working",
		match: /^the open session starts working$/,
		run: async ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "status",
				status: "processing",
				sessionId: sessionIdOf(world.page),
			});
			await world.page.locator("#stop").waitFor({ state: "visible" });
		},
	},
	{
		name: "assert stop button",
		match:
			/^stop is a 32 pixel square filled with the text colour around a 10 pixel square$/,
		run: async ({ world }) => {
			const stop = world.page.locator("#stop");
			await expectSquare(stop, BUTTON);
			const textColour = await stop.evaluate((element) => {
				const probe = document.createElement("span");
				probe.style.color = "var(--color-text)";
				element.append(probe);
				const colour = getComputedStyle(probe).color;
				probe.remove();
				return colour;
			});
			expect(await style(stop, "background-color")).toBe(textColour);
			const square = stop.getByTestId("stop-square");
			await expectSquare(square, 10);
			expect(await style(square, "background-color")).toBe(
				await style(stop, "color"),
			);
		},
	},
	{
		name: "assert send hidden while working and empty",
		match: /^send is hidden while the field is empty$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#input")).toHaveValue("");
			await expect(world.page.locator("#send")).toHaveCount(0);
		},
	},
	{
		name: "assert picker root row order",
		match: /^the picker root rows are (.+)$/,
		run: async ({ world, match }) => {
			const rows = world.page.locator(
				'#model-picker [data-testid^="picker-row-"]',
			);
			await expect(rows).toHaveCount((match[1] ?? "").split(", ").length);
			expect(
				await rows.evaluateAll((elements) =>
					elements.map((element) =>
						element.getAttribute("data-testid")?.replace("picker-row-", ""),
					),
				),
			).toEqual((match[1] ?? "").split(", "));
		},
	},
	{
		name: "assert picker agent choices",
		match: /^the picker lists agents (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.locator('#model-picker [data-testid^="picker-agent-"]'),
			).toHaveText((match[1] ?? "").split(", "));
		},
	},
	{
		name: "choose picker agent",
		match: /^I choose agent (.+) in the picker$/,
		run: async ({ world, match }) => {
			requireRpcControl(world.page).setResponse("SwitchAgent", { ok: true });
			await world.page
				.locator('#model-picker [data-testid^="picker-agent-"]')
				.filter({ hasText: match[1] ?? "" })
				.click();
		},
	},
	{
		name: "assert agent switch request",
		match: /^the relay is asked to switch the agent to (.+)$/,
		run: async ({ world, match }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "SwitchAgent",
			);
			expect(request.payload["agentId"]).toBe(match[1]);
			expect(request.payload["sessionId"]).toBe(sessionIdOf(world.page));
		},
	},
	{
		name: "assert picker agent row value",
		match: /^the picker agent row reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("picker-row-agent")).toContainText(
				match[1] ?? "",
			);
		},
	},
];
