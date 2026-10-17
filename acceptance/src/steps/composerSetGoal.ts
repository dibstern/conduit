import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";

export const composerSetGoalHandlers: StepHandler[] = [
	{
		name: "open composer add menu",
		match: /^I open the composer add menu$/,
		run: async ({ world }) => {
			await world.page.locator("#attach-btn").click();
			await expect(world.page.getByTestId("attach-menu")).toBeVisible();
		},
	},
	{
		name: "select Set goal",
		match: /^I select Set goal$/,
		run: async ({ world }) => {
			const entry = world.page.getByTestId("attach-set-goal");
			await expect(entry).toBeEnabled();
			await expect(entry.getByText("Set goal", { exact: true })).toBeVisible();
			await expect(entry).toContainText("Same as $goal");
			await entry.click();
			await expect(world.page.getByTestId("attach-menu")).toHaveCount(0);
		},
	},
	{
		name: "assert focused goal prefix",
		match: /^the composer contains the focused goal prefix$/,
		run: async ({ world }) => {
			const input = world.page.locator("#input");
			await expect(input).toHaveValue("$goal ");
			await expect(input).toBeFocused();
			await expect
				.poll(() =>
					input.evaluate((el: HTMLTextAreaElement) => [
						el.selectionStart,
						el.selectionEnd,
					]),
				)
				.toEqual([6, 6]);
		},
	},
	{
		name: "assert disabled goal entry",
		match: /^the goal entry is disabled and reads Goal with Claude only$/,
		run: async ({ world }) => {
			const entry = world.page.getByTestId("attach-set-goal");
			await expect(entry).toBeDisabled();
			await expect(entry.getByText("Goal", { exact: true })).toBeVisible();
			await expect(
				entry.getByText("Claude only", { exact: true }),
			).toBeVisible();
		},
	},
	{
		name: "try disabled goal entry",
		match: /^I try the disabled goal entry$/,
		run: async ({ world }) => {
			const input = world.page.locator("#input");
			const draft = await input.inputValue();
			await world.page.getByTestId("attach-set-goal").dispatchEvent("click");
			await expect(input).toHaveValue(draft);
			await expect(world.page.getByTestId("attach-menu")).toBeVisible();
			await world.page.keyboard.press("Escape");
			await expect(world.page.getByTestId("attach-menu")).toHaveCount(0);
		},
	},
	{
		name: "assert composer goal send controls",
		match: /^the composer shows (goal|normal) send controls$/,
		run: async ({ world, match }) => {
			const goal = match[1] === "goal";
			const send = world.page.locator("#send");
			const hint = world.page.getByTestId("composer-goal-hint");
			await expect(send).toHaveAttribute("data-goal", String(goal));
			if (goal) {
				await expect(send).toHaveAttribute("aria-label", "Set goal");
				await expect(send).toHaveText("Set goal");
				await expect(hint).toContainText(
					"Claude keeps working until this is true, and checks after each turn.",
				);
				await expect(hint).toContainText("Esc to cancel");
				await expect(hint.locator("svg.lucide-target")).toBeVisible();
			} else {
				await expect(send).not.toHaveAttribute("aria-label", "Set goal");
				await expect(hint).toHaveCount(0);
			}
			await expect(
				send.locator(goal ? "svg.lucide-target" : "svg.lucide-arrow-up"),
			).toBeVisible();
			await expect
				.poll(() =>
					send.evaluate((element) => {
						const probe = document.createElement("span");
						probe.style.color = "var(--color-status-goal)";
						element.append(probe);
						const teal = getComputedStyle(probe).color;
						probe.remove();
						return getComputedStyle(element).backgroundColor === teal;
					}),
				)
				.toBe(goal);
		},
	},
];
