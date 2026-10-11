import { expect, type Locator, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import {
	openComposerMoreSheet,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

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
const phoneRows = {
	Harness: "composer-harness-trigger",
	Model: "composer-more-model",
	Effort: "composer-more-effort",
	Mode: "composer-more-mode",
	Checkout: "composer-checkout",
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
		name: "open phone composer sheet",
		match: /^I open the phone composer sheet$/,
		run: async ({ world }) => {
			await openComposerMoreSheet(world.page);
		},
	},
	{
		name: "close phone composer sheet",
		match: /^I close the phone composer sheet$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
			await expect(world.page.getByTestId("composer-more-sheet")).toHaveCount(
				0,
			);
			await expect(world.page.getByTestId("composer-more")).toBeFocused();
		},
	},
	{
		name: "assert phone composer sheet is closed",
		match: /^the phone composer sheet is closed$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("composer-more-sheet")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "tap phone composer sheet row",
		match:
			/^I tap the phone composer (Harness|Model|Effort|Mode|Checkout) row$/,
		run: async ({ world, match }) => {
			await openComposerMoreSheet(world.page);
			await world.page
				.getByTestId("composer-more-sheet")
				.getByTestId(phoneRows[match[1] as keyof typeof phoneRows])
				.click();
		},
	},
	{
		name: "assert phone composer more regains focus",
		match: /^the phone composer more button is focused$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("composer-more")).toBeFocused();
		},
	},
	{
		name: "assert phone composer row value",
		match: /^the phone composer (Effort|Mode) row reads (.+)$/,
		run: async ({ world, match }) => {
			const row = world.page
				.getByTestId("composer-more-sheet")
				.getByTestId(phoneRows[match[1] as "Effort" | "Mode"]);
			await expect(row.locator('[data-part="value"]')).toHaveText(
				match[2] ?? "",
			);
		},
	},
	{
		name: "assert E1 phone one-line controls",
		match: /^the phone icons line matches E1 with the default shield hidden$/,
		run: async ({ world }) => {
			const layout = world.page.getByTestId("composer-layout");
			await expect(layout).toHaveAttribute("data-rows", "1");
			const order = await layout
				.locator("button")
				.evaluateAll((buttons) =>
					buttons.map(
						(button) => button.getAttribute("data-testid") ?? button.id,
					),
				);
			expect(order).toEqual([
				"attach-btn",
				"model-picker-trigger",
				"composer-more",
				"send",
			]);
			for (const id of [
				"variant-badge",
				"permission-mode-badge",
				"composer-checkout",
			])
				await expect(layout.getByTestId(id)).toHaveCount(0);
			await expect(world.page.getByTestId("composer-more-sheet")).toHaveCount(
				0,
			);
			const model = layout.getByTestId("model-picker-trigger");
			await expect(model.locator(".model-label")).toHaveText("S5");
			await expect(model.getByTestId("harness-logo")).toHaveCSS(
				"width",
				"13px",
			);
			await expect(model).toHaveCSS("height", "26px");
			await expect(model).toHaveCSS("font-size", "11.5px");
			await expect(layout.getByTestId("composer-more")).toHaveCSS(
				"height",
				"26px",
			);
			await expect(world.page.locator("#input-row")).toHaveCSS(
				"min-height",
				"42px",
			);
			await expect(world.page.locator("#input-row")).toHaveCSS(
				"border-radius",
				"14px",
			);
			await expect(world.page.locator("#input")).toHaveCSS(
				"font-size",
				"12.5px",
			);
			const controls = [
				layout.locator("#attach-btn"),
				world.page.locator("#input"),
				model,
				layout.getByTestId("composer-more"),
				layout.locator("#send"),
			];
			const boxes = await Promise.all(controls.map(box));
			for (let i = 1; i < boxes.length; i++) {
				const previous = boxes[i - 1];
				const current = boxes[i];
				if (!previous || !current) throw new Error("Phone control is missing");
				expect(previous.x + previous.width).toBeLessThanOrEqual(current.x + 1);
			}
		},
	},
	{
		name: "assert phone composer sheet rows and geometry",
		match: /^the phone composer sheet matches E1$/,
		run: async ({ world }) => {
			const sheet = world.page.getByTestId("composer-more-sheet");
			await expect(
				sheet.getByRole("heading", { name: "Composer", exact: true }),
			).toBeVisible();
			const viewport = world.page.viewportSize();
			if (!viewport || viewport.width >= 768)
				throw new Error("Phone viewport is required");
			await expect
				.poll(async () => {
					const bounds = await box(sheet);
					return (
						Math.abs(bounds.x) <= 1 &&
						Math.abs(bounds.width - viewport.width) <= 2 &&
						Math.abs(bounds.y + bounds.height - viewport.height) <= 2
					);
				})
				.toBe(true);
			const ids = Object.values(phoneRows);
			expect(
				await sheet.locator('[data-part="label"]').allTextContents(),
			).toEqual(Object.keys(phoneRows));
			for (const id of ids) {
				const row = sheet.getByTestId(id);
				await expect(row).toHaveCSS("min-height", "50px");
				await expect(row.locator('[data-part="label"]')).toHaveCSS(
					"width",
					"64px",
				);
				await expect(row.locator('[data-part="label"]')).toHaveCSS(
					"font-size",
					"11px",
				);
				await expect(row.locator('[data-part="chevron"] svg')).toBeVisible();
				if (id !== "composer-checkout")
					await expect(row.locator('[data-part="value"]')).toHaveCSS(
						"font-weight",
						"600",
					);
			}
			const harness = sheet.getByTestId("composer-harness-trigger");
			await expect(harness).toContainText("Claude · personal");
			await expect(harness.getByTestId("harness-logo")).toHaveCSS(
				"width",
				"16px",
			);
			await expect(sheet.getByTestId("composer-more-model")).toContainText(
				"Sonnet 5",
			);
			await expect(
				sheet.getByTestId("composer-more-model").locator("small"),
			).toHaveText("200K · 42% used");
			await expect(
				sheet
					.getByTestId("composer-more-effort")
					.locator('[data-part="value"]'),
			).toHaveText("high");
			await expect(
				sheet.getByTestId("composer-more-effort").getByTestId("effort-meter"),
			).toBeVisible();
			await expect(
				sheet.getByTestId("composer-more-mode").locator('[data-part="value"]'),
			).toHaveText("Ask");
			await expect(sheet.getByTestId("composer-checkout")).toContainText(
				"conduit",
			);
			await expect(sheet.getByTestId("composer-checkout")).toContainText(
				"account-chip",
			);
			await expect(sheet.getByTestId("composer-checkout-warning")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "assert composer picker replaces phone sheet",
		match: /^the phone composer sheet gives way to the picker$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("composer-more-sheet")).toHaveCount(
				0,
			);
			await expect(world.page.getByTestId("model-picker")).toBeVisible();
		},
	},
	{
		name: "assert phone sheet remains under its menu",
		match: /^the phone composer sheet keeps the (Mode|Checkout) menu above it$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("composer-more-sheet")).toBeVisible();
			await expect(
				world.page.getByTestId(
					match[1] === "Mode"
						? "permission-mode-dropdown"
						: "composer-checkout-menu",
				),
			).toBeVisible();
		},
	},
	{
		name: "assert phone nondefault hot shield",
		match:
			/^the phone hot shield is (visible|hidden) for (Never ask|Plan|Ask|Edits|Auto|Full access)$/,
		run: async ({ world, match }) => {
			const shield = world.page
				.getByTestId("composer-layout")
				.getByTestId("permission-mode-badge");
			if (match[1] === "hidden") {
				await expect(shield).toHaveCount(0);
				return;
			}
			await expect(shield).toBeVisible();
			await expect(shield).toHaveAttribute(
				"aria-label",
				new RegExp(`Approvals.*${match[2]}`),
			);
			await expect(shield).toHaveText("");
			await expect(shield.locator("svg")).toHaveCount(1);
			await expect(shield.locator("svg")).toHaveAttribute("width", "13");
			await expect(shield).toHaveAttribute("data-hot", "true");
			await expect(shield).toHaveCSS("background-color", /(?:\/|,)\s*0\.14\)/);
			const [shieldBox, moreBox] = await Promise.all([
				box(shield),
				box(world.page.getByTestId("composer-more")),
			]);
			expect(shieldBox.x + shieldBox.width).toBeLessThanOrEqual(moreBox.x + 1);
		},
	},
	{
		name: "assert phone composer warning dot",
		match: /^the phone composer amber dot is (visible|hidden)$/,
		run: async ({ world, match }) => {
			const dot = world.page.getByTestId("composer-more-attention");
			if (match[1] === "hidden") {
				await expect(dot).toHaveCount(0);
				return;
			}
			await expect(dot).toBeVisible();
			await expectSquare(dot, 6);
			await expect(dot).toHaveCSS("top", "3px");
			await expect(dot).toHaveCSS("right", "3px");
			await expect(dot).toHaveCSS("box-shadow", /0px 0px 0px 1\.5px/);
			const warning = await dot.evaluate((element) => {
				const probe = document.createElement("span");
				probe.style.color = "var(--color-warning)";
				element.append(probe);
				const colour = getComputedStyle(probe).color;
				probe.remove();
				return colour;
			});
			await expect(dot).toHaveCSS("background-color", warning);
		},
	},
	{
		name: "assert phone composer warning and actions",
		match:
			/^the phone composer warning row reports (.+) and offers Move and Dismiss$/,
		run: async ({ world, match }) => {
			const warning = world.page
				.getByTestId("composer-more-sheet")
				.getByTestId("composer-checkout-warning");
			await expect(warning).toContainText(match[1] ?? "");
			await expect(warning).toHaveCSS("flex-wrap", "wrap");
			const colour = await warning.evaluate((element) => {
				const probe = document.createElement("span");
				probe.style.color = "var(--color-warning)";
				element.append(probe);
				const resolved = getComputedStyle(probe).color;
				probe.remove();
				return resolved;
			});
			await expect(warning).toHaveCSS("color", colour);
			for (const id of ["workspace-hint-move", "workspace-hint-dismiss"]) {
				const button = warning.getByTestId(id);
				await expect(button).toBeVisible();
				await expect(button).toHaveCSS("border-radius", "7px");
				await expect(button).toHaveCSS("border-top-width", "1px");
			}
		},
	},
	{
		name: "choose phone composer warning action",
		match: /^I choose (Move|Dismiss) in the phone composer warning row$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("composer-more-sheet")
				.getByTestId("composer-checkout-warning")
				.getByTestId(
					match[1] === "Move"
						? "workspace-hint-move"
						: "workspace-hint-dismiss",
				)
				.click();
		},
	},
	{
		name: "assert phone composer workspace warning is absent",
		match: /^the phone composer warning row is absent$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("composer-checkout-warning"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert mismatch dismissal does not change durable workspace evidence",
		match:
			/^the workspace mismatch stays recorded at (.+) (without a|after (\d+)) Dismiss RPC$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			expect(
				rpc
					.getRequests()
					.filter((request) => request.tag === "DismissWorkspaceHint"),
			).toHaveLength(Number(match[3] ?? 0));
			const row = rpc.shellRows?.find(
				(candidate) =>
					(candidate as { id?: string }).id === sessionIdOf(world.page),
			);
			expect(row).toMatchObject({
				workspaceMismatch: { actualPath: match[1] },
			});
		},
	},
	{
		name: "assert E3 phone draft context stays above composer",
		match:
			/^the phone icons draft has no checkout and keeps context above the composer$/,
		run: async ({ world }) => {
			const area = world.page.locator("#input-area");
			await expect(area.getByTestId("composer-layout")).toHaveAttribute(
				"data-rows",
				"1",
			);
			const context = world.page.getByTestId("new-session-context");
			await expect(context).toBeVisible();
			await expect(context.getByTestId("draft-project-chip")).toContainText(
				"myapp",
			);
			const [contextBox, border] = await Promise.all([
				box(context),
				box(area.locator("#input-row")),
			]);
			expect(contextBox.y + contextBox.height).toBeLessThanOrEqual(border.y);
			await openComposerMoreSheet(world.page);
			await expect(
				world.page
					.getByTestId("composer-more-sheet")
					.getByTestId("composer-checkout"),
			).toHaveCount(0);
			await expect(
				world.page.getByTestId("composer-checkout-warning"),
			).toHaveCount(0);
		},
	},
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
			// The first text line stays vertically centred with send.
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
			await expect(trigger.locator(".model-label")).toHaveText(match[2] ?? "");
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
		match: /^send is a (30|32) pixel square in the off colours$/,
		run: async ({ world, match }) => {
			const send = world.page.locator("#send");
			await expectSquare(send, Number(match[1]));
			if (match[1] === "30") {
				await expect(send).toHaveCSS("border-radius", "9px");
				await expect(send.locator("svg")).toHaveAttribute("width", "13");
			}
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
			if ((await world.page.getByTestId("composer-more").count()) > 0) {
				await expect(attach).toHaveCSS("height", "30px");
				await expect(attach).toHaveCSS("width", "15px");
				await expect(attach.locator("svg")).toHaveCSS("width", "15px");
			} else await expectSquare(attach, BUTTON);
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
