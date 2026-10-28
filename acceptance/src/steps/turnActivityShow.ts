import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";

const panel = (page: Page) => page.locator("#messages .turn-activity");
const newestTop = new WeakMap<Page, number>();

export function showOptionName(
	name: string,
	role: "tab" | "menuitemradio" | "radio",
) {
	if (role !== "menuitemradio") return name;
	switch (name) {
		case "Answer":
			return "Answer only";
		case "Key":
			return "Key messages";
		case "Most":
			return "Most messages";
		default:
			return name;
	}
}

export async function showOptions(page: Page) {
	const control = panel(page).getByTestId("surfacing-level");
	if ((await control.getAttribute("role")) === "tablist")
		return { locator: control, role: "tab" as const };
	await control.click();
	const menu = page.getByRole("menu", {
		name: "Show, least to most",
		exact: true,
	});
	await expect(menu).toBeVisible();
	return {
		locator: menu,
		role: "menuitemradio" as const,
	};
}

export async function chooseShowStop(page: Page, label: string) {
	const options = await showOptions(page);
	await options.locator
		.getByRole(options.role, {
			name: showOptionName(label, options.role),
			exact: true,
		})
		.click();
	if (options.role === "menuitemradio") {
		await expect(panel(page).getByTestId("surfacing-level")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	}
}

export async function expectShowCounts(
	page: Page,
	counts: readonly (readonly [string, string])[],
) {
	const options = await showOptions(page);
	for (const [name, count] of counts)
		await expect(
			options.locator.getByRole(options.role, {
				name: showOptionName(name, options.role),
				exact: true,
			}),
		).toContainText(count);
	if (options.role === "menuitemradio") {
		await panel(page).getByTestId("surfacing-level").click();
		await expect(panel(page).getByTestId("surfacing-level")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
	}
}

export async function expectShowStop(page: Page, label: string) {
	const control = panel(page).getByTestId("surfacing-level");
	if ((await control.getAttribute("role")) !== "tablist") {
		await expect(control).toContainText(
			`Show · ${showOptionName(label, "menuitemradio")}`,
		);
		return;
	}
	await expect(
		control.getByRole("tab", { name: label, exact: true }),
	).toHaveAttribute("aria-selected", "true");
}

export const turnActivityShowHandlers: StepHandler[] = [
	{
		name: "dismiss phone Show menu with Escape",
		match: /^I dismiss the phone Show menu with Escape$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
			await expect(
				world.page.getByRole("menu", {
					name: "Show, least to most",
					exact: true,
				}),
			).toHaveCount(0);
			await expect(
				panel(world.page).getByTestId("surfacing-level"),
			).toBeFocused();
		},
	},
	{
		name: "assert phone Show button label",
		match: /^the phone Show button reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(panel(world.page).getByTestId("surfacing-level")).toHaveText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "open phone Show menu",
		match: /^I open the phone Show menu$/,
		run: async ({ world }) => {
			await panel(world.page).getByTestId("surfacing-level").click();
			await expect(
				world.page.getByRole("menu", {
					name: "Show, least to most",
					exact: true,
				}),
			).toBeVisible();
		},
	},
	{
		name: "assert phone Show menu content",
		match: /^the phone Show menu lists the stops with counts and descriptions$/,
		run: async ({ world }) => {
			const menu = world.page.getByRole("menu", {
				name: "Show, least to most",
				exact: true,
			});
			await expect(
				menu.getByText("Show, least to most", { exact: true }),
			).toBeVisible();
			const rows = menu.getByRole("menuitemradio");
			await expect(rows).toHaveCount(5);
			for (const [index, [name, count, description]] of [
				["Answer only", "", "Just the final message"],
				["Key messages", "3", "Adds asks and risks"],
				["Most messages", "5", "Adds decisions"],
				["All messages", "6", "Adds findings"],
				["Full log", "16", "Adds every step, messages in place"],
			].entries()) {
				const row = rows.nth(index);
				await expect(row.getByText(name ?? "", { exact: true })).toHaveCSS(
					"font-weight",
					"500",
				);
				await expect(
					row.getByText(description ?? "", { exact: true }),
				).toBeVisible();
				if (count) await expect(row.locator("small")).toHaveText(count);
				else await expect(row.locator("small")).toHaveCount(0);
			}
			const fullLog = rows.last();
			await expect(
				fullLog.locator("xpath=preceding-sibling::*[1]"),
			).toHaveAttribute("role", "separator");
			for (const name of ["Make default", "Back to default"])
				await expect(
					menu.getByRole("menuitem", { name, exact: true }),
				).toBeVisible();
		},
	},
	{
		name: "assert anchored Show menu and leading selection",
		match:
			/^the Show menu stays anchored to its button with a leading selected check$/,
		run: async ({ world }) => {
			const menu = world.page.getByRole("menu", {
				name: "Show, least to most",
				exact: true,
			});
			await expect(menu).toHaveAttribute("data-side", /^(top|bottom)$/);
			const menuBox = await menu.boundingBox();
			const buttonBox = await panel(world.page)
				.getByTestId("surfacing-level")
				.boundingBox();
			if (!menuBox || !buttonBox) throw new Error("Missing Show menu anchor");
			expect(Math.abs(menuBox.x - buttonBox.x)).toBeLessThanOrEqual(8);
			const gap =
				(await menu.getAttribute("data-side")) === "bottom"
					? menuBox.y - buttonBox.y - buttonBox.height
					: buttonBox.y - menuBox.y - menuBox.height;
			expect(gap).toBeGreaterThanOrEqual(0);
			expect(gap).toBeLessThanOrEqual(8);
			await expect(world.page.getByTestId("menu-sheet-scrim")).toHaveCount(0);
			const selected = menu.getByRole("menuitemradio", { checked: true });
			await expect(selected).toHaveCount(1);
			const label = selected.getByText("Most messages", { exact: true });
			const check = selected.locator("svg");
			await expect(check).toBeVisible();
			const checkBox = await check.boundingBox();
			const labelBox = await label.boundingBox();
			if (!checkBox || !labelBox)
				throw new Error("Missing selected stop geometry");
			expect(checkBox.x + checkBox.width).toBeLessThan(labelBox.x);
			await expect(selected).toHaveCSS(
				"background-color",
				await selected.evaluate((row) => {
					const probe = document.createElement("span");
					probe.style.backgroundColor = "var(--color-selection)";
					row.append(probe);
					const colour = getComputedStyle(probe).backgroundColor;
					probe.remove();
					return colour;
				}),
			);
		},
	},
	{
		name: "open an earlier live strip tool",
		match: /^I open the first tool step from the live strip$/,
		run: async ({ world }) => {
			const step = panel(world.page).locator(
				'[data-step-id="surfacing-agent/surfacing-tool-1"]',
			);
			await step.scrollIntoViewIfNeeded();
			const box = await step.boundingBox();
			if (!box) throw new Error("Missing first tool step");
			await world.page.mouse.click(
				box.x + box.width / 2,
				box.y + box.height / 2,
			);
		},
	},
	{
		name: "assert explicit live step scroll target",
		match: /^the first tool step is fully in view$/,
		run: async ({ world }) => {
			const step = panel(world.page).locator(
				'.step-log [data-part="surfacing-agent/surfacing-tool-1"]',
			);
			await expect(step).toBeInViewport({ ratio: 1 });
		},
	},
	{
		name: "set an overflowing desktop transcript viewport",
		match: /^the viewport is a short desktop$/,
		run: async ({ world }) => {
			await world.driver.setViewport(world.page, {
				name: "1440x600",
				width: 1440,
				height: 600,
			});
		},
	},
	{
		name: "open earlier live rows without moving the newest step",
		match: /^I open the live Full log from (the Show bar|earlier steps)$/,
		run: async ({ world, match }) => {
			const scope = panel(world.page);
			const trigger =
				match[1] === "the Show bar"
					? scope.getByRole("tab", { name: "Full log", exact: true })
					: scope.getByRole("button", { name: /^\+ \d+ earlier steps$/ });
			await trigger.scrollIntoViewIfNeeded();
			await trigger.focus();
			const row = scope.locator(".step-log [data-log-part]").last();
			const box = await row.boundingBox();
			if (!box) throw new Error("Missing newest live row");
			newestTop.set(world.page, box.y);
			await trigger.click();
		},
	},
	{
		name: "assert live log scroll anchoring",
		match: /^the newest live step stays in place$/,
		run: async ({ world }) => {
			const before = newestTop.get(world.page);
			if (before === undefined) throw new Error("Missing live row position");
			await expect
				.poll(async () => {
					const box = await panel(world.page)
						.locator(".step-log [data-log-part]")
						.last()
						.boundingBox();
					return box ? Math.abs(box.y - before) : Infinity;
				})
				.toBeLessThan(2);
		},
	},
	{
		name: "read an unjudged log message",
		match: /^I read the unjudged message in Full log$/,
		run: async ({ world }) => {
			await panel(world.page)
				.locator(
					'.step-log [data-log-part="surfacing-agent/surfacing-pending"] button',
				)
				.click();
		},
	},
	{
		name: "assert unjudged message full text is readable",
		match: /^the unjudged log message shows its full text$/,
		run: async ({ world }) => {
			await expect(
				panel(world.page).locator(
					'.step-log [data-log-part="surfacing-agent/surfacing-pending"] .md-content',
				),
			).toHaveText("I am inspecting the final dependency.");
		},
	},
	{
		name: "assert single left Turn chevron",
		match: /^the Turn has one left chevron and no separate log toggle$/,
		run: async ({ world }) => {
			const scope = panel(world.page);
			const toggle = scope.getByTestId("surfacing-minimise-toggle");
			await expect(toggle).toHaveCount(1);
			await expect(toggle).toHaveAccessibleName(/^(Expand|Collapse) turn$/);
			await expect(scope.locator(".turn-activity-toggle")).toHaveCount(1);
			await expect(
				scope.locator(".turn-head-card button").first(),
			).toHaveAttribute("data-testid", "surfacing-minimise-toggle");
		},
	},
	{
		name: "collapse Turn via chevron and reopen with h",
		match: /^I collapse and reopen the Turn with its chevron and h$/,
		run: async ({ world }) => {
			const scope = panel(world.page);
			const toggle = scope.getByTestId("surfacing-minimise-toggle");
			if ((await toggle.getAttribute("aria-expanded")) === "false")
				await toggle.click();
			await expect(toggle).toHaveAccessibleName("Collapse turn");
			await toggle.click();
			await expect(toggle).toHaveAccessibleName("Expand turn");
			for (const selector of [
				".step-log",
				'[data-testid="turn-show-bar"]',
				".axis-notes",
				'[data-testid="surfacing-msg-card"]',
			])
				await expect(scope.locator(selector)).toHaveCount(0);
			await expect(
				scope.locator('[aria-label^="Activity timeline"]'),
			).toBeVisible();
			await toggle.focus();
			await world.page.keyboard.press("h");
			await expect(toggle).toHaveAccessibleName("Collapse turn");
		},
	},
	{
		name: "assert desktop footer tabs and counts",
		match:
			/^the Show bar has flat accessible tabs with Answer, Key 3, Most 5, All messages 6 and Full log 16$/,
		run: async ({ world }) => {
			const bar = panel(world.page).getByTestId("turn-show-bar");
			await expect(bar).toBeVisible();
			const tabs = bar.getByRole("tablist", { name: "Show" });
			await expect(tabs).toHaveAttribute("data-testid", "surfacing-level");
			await expect(tabs.getByRole("tab")).toHaveText([
				"Answer",
				"Key3",
				"Most5",
				"All messages6",
				"Full log16",
			]);
			await expect(
				tabs.getByRole("tab", { name: "Most", exact: true }),
			).toHaveAttribute("aria-selected", "true");
			await expect(
				tabs.getByRole("tab", { name: "Most", exact: true }),
			).toHaveCSS("border-top-width", "2px");
			await expect(
				tabs.getByRole("tab", { name: "Most", exact: true }),
			).toHaveCSS("box-shadow", "none");
			for (const name of ["Make default", "Back to default"]) {
				await expect(
					bar.getByRole("button", { name, exact: true }),
				).toBeVisible();
				await expect(
					tabs.getByRole("button", { name, exact: true }),
				).toHaveCount(0);
			}
		},
	},
	{
		name: "use footer arrow navigation",
		match: /^I navigate the Show tabs with arrow keys$/,
		run: async ({ world }) => {
			await panel(world.page)
				.getByRole("tab", { name: "Most", exact: true })
				.focus();
			await world.page.keyboard.press("ArrowRight");
			await expect(
				panel(world.page).getByRole("tab", {
					name: "All messages",
					exact: true,
				}),
			).toHaveAttribute("aria-selected", "true");
			await world.page.keyboard.press("ArrowLeft");
			await expect(
				panel(world.page).getByRole("tab", { name: "Most", exact: true }),
			).toHaveAttribute("aria-selected", "true");
			await world.page.keyboard.press("End");
		},
	},
	{
		name: "assert Full log is a per-Turn view",
		match:
			/^the Show bar selects Full log without changing the saved Most stop$/,
		run: async ({ world }) => {
			await expect(
				panel(world.page).getByRole("tab", { name: "Full log", exact: true }),
			).toHaveAttribute("aria-selected", "true");
			await expect(panel(world.page).locator(".step-log")).toBeVisible();
		},
	},
	{
		name: "assert unified bordered Turn and compact message rows",
		match:
			/^the open Turn is one bordered panel with one-line message rows and card-only actions$/,
		run: async ({ world }) => {
			const card = panel(world.page).locator(".turn-head-card");
			await expect(card).toHaveCSS("border-width", "1px");
			await expect(card).toHaveCSS("border-radius", "14px");
			await expect(card.locator(".step-log")).toBeVisible();
			await expect(card.getByTestId("turn-show-bar")).toBeVisible();
			await expect(
				card.locator('.step-log [data-testid^="surfacing-step-mark-"]'),
			).toHaveCount(0);
			await expect(card.locator(".step-log [data-message-number]")).toHaveCount(
				8,
			);
			await expect(
				card.locator('.step-log [data-message-number="3"] button'),
			).toHaveCount(1);
			await expect(
				card
					.locator('.step-log [data-message-number="6"] button > span')
					.first(),
			).toHaveText("· #6");
		},
	},
	{
		name: "assert one Show bar across hand-back segments",
		match:
			/^the Turn has one Show bar with Key 0, Most 1, All messages 1 and Full log 4$/,
		run: async ({ world }) => {
			await expect(panel(world.page).getByTestId("turn-show-bar")).toHaveCount(
				1,
			);
			for (const [name, count] of [
				["Key", "0"],
				["Most", "1"],
				["All messages", "1"],
				["Full log", "4"],
			] as const)
				await expect(
					panel(world.page).getByRole("tab", { name, exact: true }),
				).toContainText(count ?? "");
		},
	},
	{
		name: "assert whole Turn bill",
		match: /^the whole Turn bill is (\$[\d.]+)$/,
		run: async ({ world, match }) => {
			await expect(
				panel(world.page).locator(".step-log .turn-meta"),
			).toContainText(match[1] ?? "");
		},
	},
];
