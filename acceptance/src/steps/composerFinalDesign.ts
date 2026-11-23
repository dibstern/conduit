import { expect, type Locator, type Page } from "@playwright/test";
import { inspectTouchTarget } from "../../../src/lib/frontend/stories/touch-target.js";
import { DESKTOP_VIEWPORT, PHONE_VIEWPORT } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openModelPicker,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

// Final composer dimensions from the 2026-10-16 redesign.
const BUTTON = 34;
const CONTROL = 30;
const iconsControls = {
	harness: "model-picker-trigger",
	model: "model-picker-trigger",
	effort: "variant-badge",
	mode: "permission-mode-badge",
} as const;
const phoneRows = {
	Harness: "picker-harness-section",
	Account: "picker-row-account",
	Model: "picker-row-model",
	Effort: "picker-row-effort",
	Permissions: "picker-row-permissions",
	Checkout: "picker-row-checkout",
} as const;

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
		name: "assert phone checkout icon and touch target",
		match:
			/^the phone composer checkout is one (branch|folder) icon with a 44 pixel touch target$/,
		run: async ({ world, match }) => {
			const checkout = world.page.getByTestId("composer-checkout");
			await expect(checkout).toBeVisible();
			await expect(
				checkout.locator(`[data-icon="${match[1]}"] svg`),
			).toBeVisible();
			await expect(
				checkout.locator('[data-part="project"], [data-part="branch"]'),
			).toHaveCount(0);
			const target = await checkout.evaluate(inspectTouchTarget, 44);
			expect(target.width).toBeGreaterThanOrEqual(44);
			expect(target.height).toBeGreaterThanOrEqual(44);
			expect(target.missing, JSON.stringify(target.failures)).toBe(0);
		},
	},
	{
		name: "assert checkout gives way before phone model label",
		match:
			/^the phone checkout moves before Settle and the model name stays whole$/,
		run: async ({ world }) => {
			const page = world.page;
			const composer = page.getByTestId("composer-layout");
			await expect(composer).toHaveAttribute(
				"data-footer-fit",
				"checkout-hidden",
			);
			await expect(page.getByTestId("composer-checkout")).not.toBeVisible();
			await expect(page.locator("#send")).toBeVisible();
			await expect(page.locator("#stop")).toBeVisible();
			await expect(composer.getByTestId("permission-mode-badge")).toBeVisible();
			const checkout = page.getByTestId("session-bar-checkout");
			await expect(checkout).toBeVisible();
			await expect(checkout.locator('[data-icon="branch"] svg')).toBeVisible();
			await expect(checkout.locator('[data-part="branch"]')).toHaveText(
				"account-chip",
			);
			await expect(
				page.locator(
					'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
				),
			).toHaveCount(1);
			await expect(
				page
					.getByTestId("session-controls-pill")
					.locator(
						'.git-pill:has([data-testid="session-bar-checkout"]) ~ #session-bar-settle',
					),
			).toBeVisible();
			await expect
				.poll(() =>
					page.getByTestId("session-controls-pill").evaluate((el) => {
						const segments = Array.from(el.children).filter(
							(child) => child.getClientRects().length > 0,
						);
						const checkout = segments.findIndex((child) =>
							child.querySelector('[data-testid="session-bar-checkout"]'),
						);
						return (
							checkout >= 0 &&
							segments[checkout + 1]?.id === "session-bar-settle"
						);
					}),
				)
				.toBe(true);
			await expect(page.getByTestId("session-controls-pill")).toHaveCSS(
				"background-color",
				"rgba(0, 0, 0, 0)",
			);
			await expect(page.getByTestId("session-controls-pill")).toHaveCSS(
				"padding",
				"2px",
			);
			const label = composer
				.getByTestId("model-picker-trigger")
				.locator(".model-label");
			await expect(label).toBeVisible();
			await expect(label).toHaveText("Sonnet 5");
			await expect
				.poll(() => label.evaluate((el) => el.scrollWidth <= el.clientWidth))
				.toBe(true);
		},
	},
	{
		name: "tap moved header checkout",
		match: /^I tap the session header checkout$/,
		run: async ({ world }) => {
			await world.page.getByTestId("session-bar-checkout").click();
		},
	},
	{
		name: "assert phone footer priority collapse across widths",
		match:
			/^the (idle|busy|auto-switch|goal|at-reset) phone footer fits at 320, 393 and 320 pixels$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const state = match[1] ?? "";
			const hasOptions = state === "auto-switch" || state === "at-reset";
			const expectedActions = hasOptions
				? ["send", "composer-send-menu-trigger", "stop"]
				: state === "idle"
					? ["send"]
					: ["send", "stop"];
			const touch = await page.context().newCDPSession(page);
			await touch.send("Emulation.setTouchEmulationEnabled", {
				enabled: true,
				maxTouchPoints: 1,
			});
			await touch.detach();
			await page.evaluate(() => document.fonts.ready);
			let initialFit: string | undefined;
			for (const width of [320, 393, 320]) {
				await world.driver.setViewport(page, { ...PHONE_VIEWPORT, width });
				expect(page.viewportSize()).toEqual({
					width,
					height: PHONE_VIEWPORT.height,
				});
				expect(await page.evaluate(() => window.innerWidth)).toBe(width);
				const layout = page.getByTestId("composer-layout");
				await expect(layout).toHaveAttribute("data-footer-fit", /\S+/);
				for (const control of [
					page.locator("#attach-btn"),
					layout.getByTestId("model-picker-trigger"),
					layout.getByTestId("permission-mode-badge"),
				])
					await expect(control).toBeVisible();
				await expect
					.poll(() =>
						layout.evaluate((element, expectedActions) => {
							const frame = document.querySelector("#input-row");
							const actions = Array.from(
								element.querySelectorAll<HTMLElement>(
									'#send, #stop, [data-testid="composer-send-menu-trigger"]',
								),
							);
							if (!frame || !actions.length) return ["Missing footer actions"];
							if (
								actions
									.map((action) => action.dataset["testid"] || action.id)
									.join() !== expectedActions.join()
							)
								return ["Missing expected footer actions"];
							const actionBoxes = actions.map((action) =>
								action.getBoundingClientRect(),
							);
							const firstAction = actionBoxes[0];
							if (!firstAction) return ["Missing Send action"];
							const controls = Array.from(
								element.querySelectorAll<HTMLElement>(
									'#attach-btn, [data-testid="model-picker-trigger"], [data-testid="variant-badge"], [data-testid="permission-mode-badge"]',
								),
							);
							const problems: string[] = [];
							// Separate protocol reads can straddle a footer resize.
							for (const [index, current] of actionBoxes.entries()) {
								const previous = actionBoxes[index - 1];
								if (!previous) continue;
								const gap = actions[index]?.id === "stop" ? 5 : 0;
								if (current.x - previous.right !== gap)
									problems.push(
										`Footer actions have a ${current.x - previous.right}px gap instead of ${gap}px`,
									);
							}
							const targets = controls.flatMap((control) => {
								if (!control.getClientRects().length) return [];
								const body = control.getBoundingClientRect();
								const before = getComputedStyle(control, "::before");
								const targetWidth = Math.max(
									body.width,
									Number.parseFloat(before.minWidth) || 0,
								);
								const targetHeight = Math.max(
									body.height,
									Number.parseFloat(before.minHeight) || 0,
								);
								const clip =
									Number.parseFloat(
										control.style.getPropertyValue("--composer-target-clip"),
									) || 0;
								const targetLeft = body.x + (body.width - targetWidth) / 2;
								const target = new DOMRect(
									targetLeft,
									body.y + (body.height - targetHeight) / 2,
									Math.max(body.right, targetLeft + targetWidth - clip) -
										targetLeft,
									targetHeight,
								);
								const id = control.id || control.dataset["testid"] || "control";
								if (target.height < 44 || (target.width < 44 && !clip))
									problems.push(`${id} lost its touch target`);
								if (
									Math.abs(
										body.y +
											body.height / 2 -
											firstAction.y -
											firstAction.height / 2,
									) > 0.5
								)
									problems.push(`${id} wrapped or lost row alignment`);
								for (const action of actionBoxes) {
									if (
										target.left < action.right &&
										target.right > action.left &&
										target.top < action.bottom &&
										target.bottom > action.top
									)
										problems.push(`${id} covers an action`);
								}
								return [{ id, target }];
							});
							for (const [index, current] of targets.entries()) {
								const previous = targets[index - 1];
								if (previous && previous.target.right > current.target.left)
									problems.push(`${current.id} covers another footer target`);
							}
							const effort = element.querySelector<HTMLElement>(
								'[data-testid="variant-badge"]',
							);
							const checkout = element.querySelector<HTMLElement>(
								'[data-testid="composer-checkout"]',
							);
							if (targets.length < 3)
								problems.push("A persistent footer control disappeared");
							if (element.getAttribute("data-footer-fit") === "effort-hidden") {
								if (
									effort?.getClientRects().length ||
									checkout?.getClientRects().length
								)
									problems.push("Effort collapsed before checkout");
								// Reveal only for this synchronous measurement; the observer sees the restored state.
								const modelMinimum = element.style.getPropertyValue(
									"--composer-model-minimum",
								);
								const fit = element.getAttribute("data-footer-fit");
								try {
									element.style.setProperty("--composer-model-minimum", "88px");
									element.setAttribute("data-footer-fit", "model-logo");
									const firstAction = Math.min(
										...actions.map(
											(action) => action.getBoundingClientRect().left,
										),
									);
									const wouldOverlap = controls.some((control) => {
										const body = control.getBoundingClientRect();
										const targetWidth = Math.max(
											body.width,
											Number.parseFloat(
												getComputedStyle(control, "::before").minWidth,
											) || 0,
										);
										return (
											body.x + (body.width + targetWidth) / 2 > firstAction
										);
									});
									const wouldOverflow = actions.some(
										(action) =>
											action.getBoundingClientRect().right >
											frame.getBoundingClientRect().right - 4,
									);
									if (!wouldOverlap && !wouldOverflow)
										problems.push("Effort was hidden while it fit");
								} finally {
									if (fit === null) element.removeAttribute("data-footer-fit");
									else element.setAttribute("data-footer-fit", fit);
									if (modelMinimum)
										element.style.setProperty(
											"--composer-model-minimum",
											modelMinimum,
										);
									else element.style.removeProperty("--composer-model-minimum");
								}
							} else if (!effort?.getClientRects().length)
								problems.push("Effort is absent without a fit constraint");
							if (
								actionBoxes.some(
									(action) =>
										action.right > frame.getBoundingClientRect().right - 4,
								)
							)
								problems.push("Actions overflow the footer gutter");
							if (document.documentElement.scrollWidth > window.innerWidth)
								problems.push("Footer causes horizontal scrolling");
							return problems;
						}, expectedActions),
					)
					.toEqual([]);
				const fit = await layout.getAttribute("data-footer-fit");
				const moved = fit !== "labels";
				await expect(page.getByTestId("session-bar-checkout")).toHaveCount(
					moved ? 1 : 0,
				);
				await expect(
					page.locator('[data-testid="composer-checkout"]:visible'),
				).toHaveCount(moved ? 0 : 1);
				const modelLabel = layout
					.getByTestId("model-picker-trigger")
					.locator(".model-label");
				if (fit === "labels" || fit === "checkout-hidden")
					await expect(modelLabel).toBeVisible();
				else await expect(modelLabel).not.toBeVisible();
				if (initialFit === undefined) initialFit = fit ?? "";
				else if (width === 320) expect(fit).toBe(initialFit);
				if (width === 393 && state === "idle") {
					await expect(layout.getByTestId("variant-badge")).toBeVisible();
					await expect(layout).not.toHaveAttribute(
						"data-footer-fit",
						"effort-hidden",
					);
				}
				const send = page.locator("#send");
				const sendBox = await box(send);
				expect(sendBox.height).toBe(34);
				if (state === "goal") await expect(send).toHaveText("Set goal");
				const options = layout.getByTestId("composer-send-menu-trigger");
				if (hasOptions) {
					const optionsBox = await box(options);
					expect(optionsBox.width).toBe(28);
					expect(optionsBox.height).toBe(34);
					await expect(send).toHaveCSS("border-top-right-radius", "0px");
					await expect(options).toHaveCSS("border-top-left-radius", "0px");
				} else await expect(options).toHaveCount(0);
				const stop = page.locator("#stop");
				if (state === "idle") await expect(stop).toHaveCount(0);
				else await expectSquare(stop, 34);
			}
		},
	},
	{
		name: "assert pinned goal command with teal icon",
		match: /^the built-in menu pins \$goal first with a teal icon$/,
		run: async ({ world }) => {
			const menu = world.page.getByRole("listbox", {
				name: "Built-in commands",
			});
			const first = menu.getByRole("option").first();
			await expect(first.locator(".cmd-name")).toHaveText("$goal");
			await expect(first).toHaveAttribute("data-goal", "true");
			await expect(first.locator(".cmd-desc")).toHaveText(
				"Keep working until something is true",
			);
			await expect
				.poll(() =>
					first.evaluate((element) => {
						const icon = element.querySelector("svg");
						const name = element.querySelector(".cmd-name");
						if (!icon || !name) return false;
						const probe = document.createElement("span");
						probe.style.color = "var(--color-status-goal)";
						element.append(probe);
						const expectedIcon = getComputedStyle(probe).color;
						probe.style.color = "var(--color-text)";
						const expectedName = getComputedStyle(probe).color;
						probe.remove();
						return (
							getComputedStyle(icon).color === expectedIcon &&
							getComputedStyle(name).color === expectedName
						);
					}),
				)
				.toBe(true);
		},
	},
	{
		name: "assert compact command menu fits composer",
		match: /^the compact command menu fits the composer width$/,
		run: async ({ world }) => {
			await expect
				.poll(async () => {
					const menu = await box(
						world.page.getByRole("listbox", { name: "Built-in commands" }),
					);
					const composer = await box(world.page.locator("#input-row"));
					return (
						Math.abs(menu.x - composer.x) <= 1 &&
						Math.abs(menu.width - Math.min(340, composer.width)) <= 1
					);
				})
				.toBe(true);
		},
	},
	{
		name: "assert compact context percentage",
		match: /^the compact command reports (\d+)% context$/,
		run: async ({ world, match }) => {
			const compact = world.page.getByRole("option").filter({
				has: world.page.locator(".cmd-name", { hasText: "$compact" }),
			});
			await expect(compact.getByTestId("command-context-percent")).toHaveText(
				`${match[1]}%`,
			);
		},
	},

	{
		name: "open phone Session panel",
		match: /^I open the phone Session panel$/,
		run: async ({ world }) => {
			await openModelPicker(world.page);
		},
	},
	{
		name: "close phone Session panel",
		match: /^I close the phone Session panel$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
			await expect(world.page.getByTestId("model-picker")).toHaveCount(0);
			await expect(
				world.page.getByTestId(
					/^(model-picker-trigger|composer-words-sheet-trigger)$/,
				),
			).toBeFocused();
		},
	},
	{
		name: "assert phone Session panel is closed",
		match: /^the phone Session panel is closed$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("model-picker")).toHaveCount(0);
		},
	},
	{
		name: "tap phone Session panel row",
		match:
			/^I tap the phone Session panel (Harness|Account|Model|Effort|Permissions|Checkout) row$/,
		run: async ({ world, match }) => {
			await openModelPicker(world.page);
			const row = world.page
				.getByTestId("model-picker")
				.getByTestId(phoneRows[match[1] as keyof typeof phoneRows]);
			if (match[1] === "Harness") {
				await row.locator('[aria-checked="true"]').focus();
			} else if (match[1] === "Effort") {
				await row.focus();
			} else {
				await row.click();
			}
		},
	},
	{
		name: "assert phone model pill regains focus",
		match: /^the phone model pill is focused$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("model-picker-trigger"),
			).toBeFocused();
		},
	},
	{
		name: "assert phone Session panel row value",
		match:
			/^the phone Session panel (Account|Context|Effort|Permissions) row reads (.+)$/,
		run: async ({ world, match }) => {
			const picker = world.page.getByTestId("model-picker");
			const value = match[2] ?? "";
			if (
				match[1] === "Permissions" &&
				!(await picker.getByTestId("picker-row-permissions").isVisible())
			) {
				await expect(
					picker.locator(
						'[data-testid^="picker-permission-"][aria-pressed="true"]',
					),
				).toContainText(value);
				return;
			}
			const row = picker.getByTestId(
				match[1] === "Context"
					? "picker-row-context"
					: phoneRows[match[1] as "Account" | "Effort" | "Permissions"],
			);
			await expect(row).toBeVisible();
			if (match[1] === "Effort") {
				const options = row.getByRole("radio");
				if ((await options.count()) === 0)
					await expect(row).toContainText(value);
				else if (value === "Default")
					await expect(row.locator('[aria-checked="true"]')).toHaveCount(0);
				else
					await expect(
						row.getByRole("radio", { name: value, exact: true }),
					).toBeChecked();
			} else {
				await expect(row).toContainText(value);
			}
		},
	},
	{
		name: "activate inline phone footer control",
		match:
			/^I (tap|hold) the (?:phone footer|visible phone) (effort|checkout) control$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Emulation.setTouchEmulationEnabled", {
				enabled: true,
				maxTouchPoints: 1,
			});
			const control =
				match[2] === "effort"
					? page.getByTestId("variant-badge")
					: page.locator(
							'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
						);
			await expect(control).toBeVisible();
			await expect(control).toBeEnabled();
			await expect(control).not.toHaveAttribute("aria-busy", "true");
			const bounds = await box(control);
			await cdp.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [
					{
						x: bounds.x + bounds.width / 2,
						y: bounds.y + bounds.height / 2,
					},
				],
			});
			try {
				if (match[1] === "hold") {
					await expect(page.getByTestId("model-picker")).toBeVisible();
				}
			} finally {
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
				await cdp.detach();
			}
		},
	},
	{
		name: "assert inline phone effort meter label",
		match: /^the phone footer effort meter names (.+)$/,
		run: async ({ world, match }) => {
			const effort = world.page.getByTestId("variant-badge");
			await expect(effort).toHaveAccessibleName(
				`Effort: ${match[1]}. Tap to raise; hold for options`,
			);
			await expect(effort.locator(".effort-meter")).toBeVisible();
			await expect(effort).toHaveText("");
		},
	},
	{
		name: "assert inline phone checkout opens the Session bottom sheet",
		match: /^the checkout menu is a phone bottom sheet$/,
		run: async ({ world }) => {
			const viewport = world.page.viewportSize();
			if (!viewport || viewport.width >= 768)
				throw new Error("Phone viewport is required");
			const picker = world.page.getByTestId("model-picker");
			await expect(picker).toBeVisible();
			await expect(picker.getByTestId("picker-row-checkout")).toBeFocused();
			await expect
				.poll(async () => {
					const bounds = await box(picker);
					return (
						Math.abs(bounds.x) <= 1 &&
						Math.abs(bounds.width - viewport.width) <= 2 &&
						Math.abs(bounds.y + bounds.height - viewport.height) <= 2
					);
				})
				.toBe(true);
		},
	},
	{
		name: "assert Final phone controls",
		match: /^the phone icons controls show one model chip and the shield$/,
		run: async ({ world }) => {
			const layout = world.page.getByTestId("composer-layout");
			await expect(layout).toHaveAttribute("data-rows", "2");
			await expect(layout.getByTestId("model-picker-trigger")).toHaveCount(1);
			await expect(layout.getByTestId("model-picker-trigger")).toContainText(
				"Sonnet 5",
			);
			await expect(layout.getByTestId("permission-mode-badge")).toBeVisible();
			await expect(layout.getByTestId("permission-mode-badge")).toHaveText("");
			await expect(layout.getByTestId("variant-badge")).toBeVisible();
			await expect(layout.getByTestId("variant-badge")).toHaveText("");
			const input = await box(world.page.locator("#input"));
			const model = await box(layout.getByTestId("model-picker-trigger"));
			expect(input.y + input.height).toBeLessThanOrEqual(model.y + 1);
			await expect(world.page.locator("#input-row")).toHaveCSS(
				"border-radius",
				"22px",
			);
			await expect(world.page.locator("#input")).toHaveCSS("font-size", "15px");
		},
	},
	{
		name: "assert phone Session panel sections, rows and geometry",
		match:
			/^the phone Session panel has Harness and Account sections and Model, Context, Effort, Agent, Permissions and Checkout rows$/,
		run: async ({ world }) => {
			const sheet = world.page.getByTestId("model-picker");
			await expect(
				sheet.getByRole("heading", { name: "Session", exact: true }),
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
			for (const id of Object.values(phoneRows)) {
				const row = sheet.getByTestId(id);
				await expect(row).toBeVisible();
				expect((await box(row)).height).toBeGreaterThanOrEqual(50);
			}
			await expect(sheet.getByTestId("picker-harness-section")).toContainText(
				"Claude",
			);
			await expect(sheet.getByTestId("picker-row-account")).toContainText(/\S/);
			await expect(sheet.getByTestId("picker-row-model")).toContainText(
				"Sonnet 5",
			);
			await expect(sheet.getByTestId("picker-row-context")).toContainText(
				"200K",
			);
			await expect(
				sheet.getByTestId("picker-row-effort").getByRole("radiogroup"),
			).toBeVisible();
			await expect(sheet.getByTestId("picker-row-agent")).toBeVisible();
			await expect(sheet.getByTestId("picker-row-permissions")).toContainText(
				"Ask before edits",
			);
			await expect(sheet.getByTestId("picker-row-checkout")).toContainText(
				"account-chip",
			);
		},
	},
	{
		name: "assert phone Session panel remains open",
		match: /^the phone Session panel remains open$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("model-picker")).toBeVisible();
		},
	},
	{
		name: "assert phone Session panel shows its choices",
		match: /^the phone Session panel shows (Permissions|Checkout) choices$/,
		run: async ({ world, match }) => {
			const picker = world.page.getByTestId("model-picker");
			await expect(picker).toBeVisible();
			await expect(
				picker.getByRole("heading", { name: match[1] ?? "", exact: true }),
			).toBeVisible();
			await expect(picker.getByTestId("picker-back")).toBeVisible();
			if (match[1] === "Permissions")
				await expect(picker.getByTestId("picker-permission-ask")).toBeVisible();
			else
				await expect(
					picker.getByTestId("picker-worktree").first(),
				).toBeVisible();
		},
	},
	{
		name: "assert always-visible phone shield",
		match:
			/^the phone shield is visible for (Never ask|Plan|Ask before edits|Auto-accept edits|Auto|Full access)$/,
		run: async ({ world, match }) => {
			const shield = world.page
				.getByTestId("composer-layout")
				.getByTestId("permission-mode-badge");
			await expect(shield).toBeVisible();
			await expect(shield).toHaveAttribute(
				"aria-label",
				new RegExp(`Permissions.*${match[1]}`),
			);
			await expect(shield).toHaveText("");
			await expect(shield.locator("svg")).toHaveCount(1);
		},
	},
	{
		name: "assert phone checkout warning mark",
		match: /^the phone checkout warning mark is (visible|hidden)$/,
		run: async ({ world, match }) => {
			const dot = world.page
				.locator(
					'[data-testid="composer-checkout"]:visible, [data-testid="session-bar-checkout"]:visible',
				)
				.getByTestId("workspace-notice-indicator");
			if (match[1] === "hidden") {
				await expect(dot).toHaveCount(0);
				return;
			}
			await expect(dot).toBeVisible();
			await expect(dot.locator("svg")).toBeVisible();
			await expect(dot).toHaveAttribute("aria-label", /\S/);
		},
	},
	{
		name: "assert phone Session panel checkout notice and actions",
		match:
			/^the phone Session panel checkout notice reports (.+) and offers (Move|Retry move) and Dismiss$/,
		run: async ({ world, match }) => {
			const picker = world.page.getByTestId("model-picker");
			await expect(picker.getByTestId("picker-checkout-warning")).toBeVisible();
			const warning = picker
				.getByTestId("picker-checkout-notice")
				.filter({ hasText: match[1] ?? "" })
				.first();
			await expect(warning).toContainText(match[1] ?? "");
			const colour = await warning.evaluate((element) => {
				const probe = document.createElement("span");
				probe.style.color = "var(--color-warning)";
				element.append(probe);
				const resolved = getComputedStyle(probe).color;
				probe.remove();
				return resolved;
			});
			await expect(warning).toHaveCSS("color", colour);
			for (const id of [
				"picker-checkout-notice-move",
				"picker-checkout-notice-dismiss",
			]) {
				const button = warning.getByTestId(id);
				await expect(button).toBeVisible();
				await expect(button).toHaveText(
					id.endsWith("dismiss") ? "Dismiss" : (match[2] ?? ""),
				);
			}
		},
	},
	{
		name: "choose phone Session panel checkout notice action",
		match:
			/^I choose (Move|Retry move|Dismiss) in the phone Session panel checkout notice$/,
		run: async ({ world, match }) => {
			const picker = world.page.getByTestId("model-picker");
			const mismatch = picker.locator(
				'[data-testid="picker-checkout-notice"][data-kind="mismatch"]',
			);
			const kind =
				match[1] === "Move"
					? "hint"
					: match[1] === "Retry move" || (await mismatch.isVisible())
						? "mismatch"
						: "hint";
			await picker
				.locator(`[data-testid="picker-checkout-notice"][data-kind="${kind}"]`)
				.getByTestId(
					match[1] === "Dismiss"
						? "picker-checkout-notice-dismiss"
						: "picker-checkout-notice-move",
				)
				.click();
		},
	},
	{
		name: "assert phone Session panel checkout notice is absent",
		match: /^the phone Session panel checkout notice is absent$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("picker-checkout-notice"),
			).toHaveCount(0);
			await expect(
				world.page.getByTestId("picker-checkout-warning"),
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
				"2",
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
			await openModelPicker(world.page);
			await expect(
				world.page
					.getByTestId("model-picker")
					.getByTestId("picker-row-checkout"),
			).toHaveCount(0);
			await expect(
				world.page.getByTestId("picker-checkout-notice"),
			).toHaveCount(0);
		},
	},
	{
		name: "activate desktop icons control",
		match:
			/^I (tap|open options from) the icons (harness|model|effort|mode) control$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId(iconsControls[match[2] as keyof typeof iconsControls])
				.click({
					modifiers:
						match[1] === "open options from" && match[2] === "effort"
							? ["Alt"]
							: [],
				});
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
		name: "assert Final desktop controls",
		match: /^the desktop icons controls match Final in the (wide|narrow) tier$/,
		run: async ({ world }) => {
			const layout = world.page.getByTestId("composer-layout");
			await expect(layout).toHaveAttribute("data-rows", "2");
			await expect(layout.getByTestId("model-picker-trigger")).toHaveCount(1);
			await expect(
				layout.getByTestId("model-picker-trigger").getByTestId("harness-logo"),
			).toBeVisible();
			await expect(layout.getByTestId("permission-mode-badge")).toHaveText("");
			await expect(layout.getByTestId("variant-badge")).toBeVisible();
			const input = await box(world.page.locator("#input"));
			const model = await box(layout.getByTestId("model-picker-trigger"));
			expect(input.y + input.height).toBeLessThanOrEqual(model.y + 1);
		},
	},
	{
		name: "set a desktop composer width",
		match: /^the desktop composer is (\d+) pixels wide$/,
		run: async ({ world, match }) => {
			await world.driver.setViewport(world.page, DESKTOP_VIEWPORT);
			await world.page.locator("#input-wrapper").evaluate((element, width) => {
				element.style.width = `${width}px`;
			}, Number(match[1]));
		},
	},
	{
		name: "move the desktop composer to the window's left edge",
		match: /^the desktop composer sits at the window's left edge$/,
		run: async ({ world }) => {
			// A closed sidebar with Files open leaves the composer at the window's left edge.
			await world.page.locator("#input-wrapper").evaluate((element) => {
				element.style.left = `${12 - element.getBoundingClientRect().left}px`;
			});
		},
	},
	{
		name: "assert the desktop model picker stays inside the window",
		match: /^the model picker stays inside the window$/,
		run: async ({ world }) => {
			const picker = await box(world.page.getByTestId("model-picker"));
			const width = world.page.viewportSize()?.width ?? 0;
			expect(picker.x).toBeGreaterThanOrEqual(8 - 0.5);
			expect(picker.x + picker.width).toBeLessThanOrEqual(width - 8 + 0.5);
		},
	},
	{
		name: "assert checkout yields before the model label",
		match: /^the model label remains Sonnet 5 before checkout labels$/,
		run: async ({ world }) => {
			const model = world.page
				.getByTestId("model-picker-trigger")
				.locator(".model-label");
			await expect(model).toHaveText("Sonnet 5");
			const label = await model.evaluate((element) => ({
				width: element.clientWidth,
				content: element.scrollWidth,
			}));
			expect(label.width).toBeGreaterThanOrEqual(label.content - 1);
		},
	},
	{
		name: "assert which checkout labels fit beside send",
		match: /^the composer checkout labels are (.+)$/,
		run: async ({ world, match }) => {
			const shown = match[1] === "none" ? [] : (match[1] ?? "").split(", ");
			const checkout = world.page.getByTestId("composer-checkout");
			for (const part of ["project", "branch", "upstream"]) {
				await expect(checkout.locator(`[data-part="${part}"]`)).toHaveCount(
					shown.includes(part) ? 1 : 0,
				);
			}
			// The checkout icon and its dirty mark survive every width.
			await expect(checkout.locator("[data-icon] svg")).toBeVisible();
			await expect(checkout.locator('[data-part="dirty"]')).toBeVisible();
		},
	},
	{
		name: "assert checkout pill yields room before model and send",
		match: /^the checkout pill yields room before the model label and send$/,
		run: async ({ world }) => {
			const checkout = world.page.getByTestId("composer-checkout");
			await expect(checkout).toBeVisible();
			expect(
				Number.parseFloat(await style(checkout, "border-radius")),
			).toBeGreaterThanOrEqual((await box(checkout)).height / 2);
			const fill = await style(checkout, "background-color");
			expect(fill).not.toBe("rgba(0, 0, 0, 0)");
			const effort = world.page.getByTestId("variant-badge");
			const controls = [
				world.page.locator("#attach-btn"),
				world.page.getByTestId("model-picker-trigger"),
				...((await effort.count()) ? [effort] : []),
				world.page.getByTestId("permission-mode-badge"),
				checkout,
				world.page.locator("#send"),
			];
			const boxes = await Promise.all(controls.map(box));
			for (let i = 1; i < boxes.length; i++) {
				const previous = boxes[i - 1];
				const current = boxes[i];
				if (!previous || !current) throw new Error("Footer control is missing");
				expect(previous.x + previous.width).toBeLessThanOrEqual(current.x + 1);
			}
		},
	},
	{
		name: "assert send survives all clipping ancestors",
		match: /^send is fully inside the composer and its clipping ancestors$/,
		run: async ({ world }) => {
			const visibility = await world.page
				.locator("#send")
				.evaluate((element) => {
					const send = element.getBoundingClientRect();
					let left = 0,
						top = 0,
						right = window.innerWidth,
						bottom = window.innerHeight;
					const composer = document
						.getElementById("input-row")
						?.getBoundingClientRect();
					if (!composer) throw new Error("Composer is missing");
					left = Math.max(left, composer.left);
					top = Math.max(top, composer.top);
					right = Math.min(right, composer.right);
					bottom = Math.min(bottom, composer.bottom);
					for (
						let parent = element.parentElement;
						parent;
						parent = parent.parentElement
					) {
						const css = getComputedStyle(parent);
						const bounds = parent.getBoundingClientRect();
						if (/hidden|clip|scroll|auto/.test(css.overflowX)) {
							left = Math.max(left, bounds.left);
							right = Math.min(right, bounds.right);
						}
						if (/hidden|clip|scroll|auto/.test(css.overflowY)) {
							top = Math.max(top, bounds.top);
							bottom = Math.min(bottom, bounds.bottom);
						}
					}
					return (
						send.left >= left - 0.5 &&
						send.right <= right + 0.5 &&
						send.top >= top - 0.5 &&
						send.bottom <= bottom + 0.5
					);
				});
			expect(visibility).toBe(true);
		},
	},
	{
		name: "assert desktop mode shield name",
		match:
			/^the mode shield names (Never ask|Plan|Ask before edits|Auto-accept edits|Auto|Full access)$/,
		run: async ({ world, match }) => {
			const mode = world.page.getByTestId("permission-mode-badge");
			await expect(mode).toHaveText("");
			await expect(mode).toHaveAttribute(
				"aria-label",
				new RegExp(`Permissions.*${match[1]}`),
			);
		},
	},
	{
		name: "assert mode shield permission tone",
		match: /^the mode shield uses the (never|plan|ask|edits|auto|full) tone$/,
		run: async ({ world, match }) => {
			const mode = world.page.getByTestId("permission-mode-badge");
			await expect
				.poll(() =>
					mode.evaluate((element, tone) => {
						const probe = document.createElement("span");
						probe.style.color = `var(--color-p-${tone})`;
						element.append(probe);
						const expected = getComputedStyle(probe).color;
						probe.remove();
						return (
							getComputedStyle(element.querySelector("svg") ?? element)
								.color === expected
						);
					}, match[1] ?? "ask"),
				)
				.toBe(true);
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
		name: "assert text is above the controls",
		match: /^the placeholder sits above the controls row$/,
		run: async ({ world }) => {
			const input = await box(world.page.locator("#input"));
			const model = await box(world.page.getByTestId("model-picker-trigger"));
			expect(input.y + input.height).toBeLessThanOrEqual(model.y + 1);
		},
	},
	{
		name: "assert reply placeholder at each viewport",
		match: /^the composer placeholder matches the (phone|desktop) reply copy$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#input")).toHaveAttribute(
				"placeholder",
				match[1] === "phone" ? "Reply…" : "Reply to Claude…",
			);
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
		name: "assert unified model chip",
		match: /^the model chip reads (.+) with a chevron$/,
		run: async ({ world, match }) => {
			const trigger = world.page.getByTestId("model-picker-trigger");
			await expect(trigger.locator(".model-label")).toHaveText(match[1] ?? "");
			await expect(trigger.getByTestId("harness-logo")).toBeVisible();
			await expect(trigger.getByTestId("model-chip-chevron")).toBeVisible();
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
		name: "assert neutral circular send",
		match: /^send is a 34 pixel neutral circle$/,
		run: async ({ world }) => {
			const send = world.page.locator("#send");
			await expectSquare(send, BUTTON);
			expect(
				Number.parseFloat(await style(send, "border-radius")),
			).toBeGreaterThanOrEqual(BUTTON / 2);
			const neutral = await send.evaluate((element) => {
				const probe = document.createElement("span");
				probe.style.color = "var(--color-text)";
				element.append(probe);
				const colour = getComputedStyle(probe).color;
				probe.remove();
				return colour;
			});
			expect(await style(send, "background-color")).toBe(neutral);
		},
	},
	{
		name: "assert plain attach button",
		match: /^the attach button has no border$/,
		run: async ({ world }) => {
			const attach = world.page.locator("#attach-btn");
			await expectSquare(attach, 30);
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
		match: /^stop is a 34 pixel neutral circle around a 10 pixel square$/,
		run: async ({ world }) => {
			const stop = world.page.locator("#stop");
			await expectSquare(stop, BUTTON);
			expect(
				Number.parseFloat(await style(stop, "border-radius")),
			).toBeGreaterThanOrEqual(BUTTON / 2);
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
					? '#model-picker [data-testid^="picker-row-"]:not([data-testid="picker-row-account-meta"]), #model-picker [data-testid="picker-harness-section"]'
					: '#model-picker [data-testid^="picker-row-"]:not([data-testid="picker-row-account-meta"])',
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
			requireRpcControl(world.page).setStubs({
				SwitchAgent: () => ({ ok: true }),
			});
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
