import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";

const panel = (page: Page) => page.locator("#messages .turn-activity");
const newestTop = new WeakMap<Page, number>();

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
		role: "menuitem" as const,
	};
}

export async function chooseShowStop(page: Page, label: string) {
	const options = await showOptions(page);
	await options.locator
		.getByRole(options.role, { name: label, exact: true })
		.click();
	if (options.role === "menuitem") {
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
			options.locator.getByRole(options.role, { name, exact: true }),
		).toContainText(count);
	if (options.role === "menuitem") {
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
		await expect(control).toContainText(`Show · ${label}`);
		return;
	}
	await expect(
		control.getByRole("tab", { name: label, exact: true }),
	).toHaveAttribute("aria-selected", "true");
}

export const turnActivityShowHandlers: StepHandler[] = [
	{
		name: "open an earlier live strip tool",
		match: /^I open the first tool step from the live strip$/,
		run: async ({ world }) => {
			const step = panel(world.page).locator(
				'[data-step-id="surfacing-agent/surfacing-tool-1"]',
			);
			await step.click();
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
					: scope.getByRole("button", { name: /^\+ \d+ earlier messages$/ });
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
			/^the Show bar has flat accessible tabs with Answer, Key 3, Most 5, All messages 6, Full log 16 and Usage$/,
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
				"Usage",
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
			await expect(
				panel(world.page).getByRole("tab", { name: "Usage", exact: true }),
			).toHaveAttribute("aria-selected", "true");
			await world.page.keyboard.press("ArrowLeft");
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
				panel(world.page).getByTestId("turn-show-bar").locator(".turn-meta"),
			).toContainText(match[1] ?? "");
		},
	},
];
