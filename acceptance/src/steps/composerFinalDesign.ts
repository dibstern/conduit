import { expect, type Locator, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl, setSessionRowStatus } from "./shared.js";

// Literal values from docs/plans/2026-10-02-composer-final-designs.html.
const BUTTON = 32;
// Desktop controls from docs/plans/2026-10-11-composer-harness-account-final-design.html.
const CONTROL = 26;
const iconsControls = {
	harness: "composer-harness-trigger",
	model: "model-picker-trigger",
	effort: "variant-badge",
	mode: "permission-mode-badge",
} as const;
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
		name: "tap desktop icons control",
		match: /^I tap the icons (harness|model|effort|mode) control$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId(iconsControls[match[1] as keyof typeof iconsControls])
				.click();
		},
	},
	{
		name: "assert icons control regains focus",
		match: /^the icons (harness|model|effort|mode) control is focused$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(
					iconsControls[match[1] as keyof typeof iconsControls],
				),
			).toBeFocused();
		},
	},
	{
		name: "assert E1 desktop split footer and control sizing",
		match: /^the desktop icons footer matches E1 in the (wide|narrow) tier$/,
		run: async ({ world, match }) => {
			const layout = world.page.getByTestId("composer-layout");
			await expect(layout).toHaveAttribute("data-rows", "2");
			const left = layout.getByTestId("composer-icons-left");
			const controls = Object.values(iconsControls);
			const order = await left
				.locator("button")
				.evaluateAll((buttons) =>
					buttons.map((button) => button.getAttribute("data-testid")),
				);
			expect(order).toEqual(controls);
			for (const id of controls) {
				const control = left.getByTestId(id);
				await expect(control).toHaveCSS("height", `${CONTROL}px`);
				await expect(control).toHaveCSS("padding-left", "6px");
				await expect(control).toHaveCSS("padding-right", "6px");
				await expect(control).toHaveCSS("border-radius", "7px");
				await expect(control).toHaveCSS("font-size", "11.5px");
				await expect(control).toHaveCSS("column-gap", "5px");
				await expect(control).toHaveCSS("flex-shrink", "0");
			}
			const harness = left.getByTestId("composer-harness-trigger");
			await expect(harness.getByTestId("harness-logo")).toHaveCSS(
				"width",
				"13px",
			);
			await expect(harness).toHaveAttribute("aria-label", /Claude.*personal/);
			for (const [id, label] of [
				["composer-harness-label", "Claude"],
				["composer-harness-account", "personal"],
				["composer-effort-label", "High"],
				["composer-mode-label", "Ask"],
			] as const) {
				if (match[1] === "wide")
					await expect(left.getByTestId(id)).toHaveText(label);
				else await expect(left.getByTestId(id)).toHaveCount(0);
			}
			const divider = left.getByTestId("composer-control-divider");
			await expect(divider).toHaveCSS("width", "1px");
			await expect(divider).toHaveCSS("height", "14px");
			await expect(divider).toHaveCSS("margin-left", "4px");
			await expect(divider).toHaveCSS("margin-right", "4px");
			await expect(layout.locator('[data-slot="field"]')).toHaveCSS(
				"grid-column",
				"1 / -1",
			);
			const input = await box(world.page.locator("#input"));
			const footer = await box(harness);
			expect(input.y + input.height).toBeLessThanOrEqual(footer.y);
		},
	},
	{
		name: "assert quiet checkout yields room before left controls",
		match: /^the icons checkout is a quiet shrinking control before send$/,
		run: async ({ world }) => {
			const layout = world.page.getByTestId("composer-layout");
			const right = layout.locator('[data-slot="send"]');
			const checkout = right.getByTestId("composer-checkout");
			await expect(checkout).toHaveCSS("height", `${CONTROL}px`);
			await expect(checkout).toHaveCSS("border-radius", "7px");
			await expect(checkout).toHaveCSS("padding-left", "6px");
			await expect(checkout).toHaveCSS("padding-right", "6px");
			await expect(checkout).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			await expect(checkout.locator('[data-part="chevron"]')).toBeVisible();
			await expect(checkout.locator("..")).toHaveCSS("flex-shrink", "1");
			await expect(checkout.locator("..")).toHaveCSS("min-width", "0px");
			const footer = [
				world.page.locator("#attach-btn"),
				...Object.values(iconsControls).map((id) => world.page.getByTestId(id)),
				checkout,
				right.locator("#send"),
			];
			const boxes = await Promise.all(footer.map(box));
			for (let i = 1; i < boxes.length; i++) {
				const previous = boxes[i - 1];
				const current = boxes[i];
				if (!previous || !current) throw new Error("Footer control is missing");
				expect(previous.x + previous.width).toBeLessThanOrEqual(current.x + 1);
				expect(
					Math.abs(
						previous.y + previous.height / 2 - current.y - current.height / 2,
					),
				).toBeLessThanOrEqual(1);
			}
			const send = boxes.at(-1);
			const bounds = await box(layout);
			if (!send) throw new Error("Send is missing");
			expect(send.x + send.width).toBeLessThanOrEqual(
				bounds.x + bounds.width + 1,
			);
		},
	},
	{
		name: "assert mode warns for every non-default desktop mode",
		match: /^the icons mode control has hot tint (true|false)$/,
		run: async ({ world, match }) => {
			const mode = world.page.getByTestId("permission-mode-badge");
			const hot = match[1] === "true";
			if (hot) await expect(mode).toHaveAttribute("data-hot", "true");
			else await expect(mode).not.toHaveAttribute("data-hot");
			await expect
				.poll(() =>
					mode.evaluate((element, hot) => {
						const probe = document.createElement("span");
						probe.style.color = hot
							? "var(--color-warning)"
							: "var(--color-text-secondary)";
						document.body.append(probe);
						const expected = getComputedStyle(probe).color;
						probe.remove();
						return getComputedStyle(element).color === expected;
					}, hot),
				)
				.toBe(true);
			if (hot)
				await expect(mode).toHaveCSS("background-color", /(?:\/|,)\s*0\.14\)/);
			else await expect(mode).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		},
	},
	{
		name: "assert E3 draft keeps context below split icons footer",
		match:
			/^the icons draft has no checkout and keeps context below the composer$/,
		run: async ({ world }) => {
			const area = world.page.locator("#input-area");
			await expect(area.getByTestId("composer-checkout")).toHaveCount(0);
			const layout = area.getByTestId("composer-layout");
			await expect(layout).toHaveAttribute("data-rows", "2");
			await expect(layout.locator('[data-slot="send"] button')).toHaveCount(1);
			const context = world.page.getByTestId("new-session-context");
			await expect(context).toBeVisible();
			const contextBox = await box(context);
			const border = await box(area.locator("#input-row"));
			expect(contextBox.y).toBeGreaterThanOrEqual(border.y + border.height);
		},
	},
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
			const [model, context] = (match[1] ?? "").split(" · ");
			await expect(trigger.locator(".model-label")).toHaveText(model ?? "");
			await expect(trigger.getByTestId("picker-selected-context")).toHaveText(
				context ?? "",
			);
			await expect(trigger.getByTestId("model-chip-chevron")).toBeVisible();
			expect(
				Math.abs((await box(trigger)).height - CONTROL),
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
			expect(Math.abs((await box(chip)).height - CONTROL)).toBeLessThanOrEqual(
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
			setSessionRowStatus(world.page, sessionIdOf(world.page), "busy");
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
		match: /^the picker root (sections and )?rows are (.+)$/,
		run: async ({ world, match }) => {
			const rows = world.page.locator(
				match[1]
					? '#model-picker [data-testid^="picker-row-"], #model-picker [data-testid="picker-harness-section"], #model-picker [data-testid="picker-account-section"]'
					: '#model-picker [data-testid^="picker-row-"]',
			);
			await expect(rows).toHaveCount((match[2] ?? "").split(", ").length);
			expect(
				await rows.evaluateAll((elements) =>
					elements.map((element) =>
						element
							.getAttribute("data-testid")
							?.replace(/^picker-(row-)?/, "")
							.replace(/-section$/, ""),
					),
				),
			).toEqual((match[2] ?? "").split(", "));
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
