import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { chooseShowStop } from "./turnActivityShow.js";

export const turnQaHandlers: StepHandler[] = [
	{
		name: "select Turn Q&A",
		match: /^I select the Turn Q&A tab$/,
		run: async ({ world }) => {
			const panel = world.page.locator("#messages .turn-activity");
			const expand = panel.getByRole("button", { name: "Expand turn", exact: true });
			if (await expand.count()) await expand.click();
			const tab = panel.getByRole("tab", { name: "Q&A", exact: true });
			if (await tab.count()) await tab.click();
			else await chooseShowStop(world.page, "Q&A");
		},
	},
	{
		name: "assert ordered Q&A history",
		match: /^Q&A lists the question and plan with their answers in order$/,
		run: async ({ world }) => {
			const qa = world.page.getByRole("region", { name: "Turn Q&A", exact: true });
			await expect(qa).toBeVisible();
			const entries = qa.locator("[data-qa-entry]");
			await expect(entries).toHaveCount(2);
			await expect(entries.nth(0)).toContainText("Which target?");
			await expect(entries.nth(0)).toContainText("Staging");
			await expect(entries.nth(0)).toContainText("Answered");
			await expect(entries.nth(1)).toContainText("Deploy to staging.");
			await expect(entries.nth(1)).toContainText("Approved");
			await expect(world.page.locator("#messages .turn-activity").getByTestId("surfacing-msg-card")).toHaveCount(0);
			await expect(world.page.locator("#messages .step-log:visible")).toHaveCount(0);
		},
	},
	{
		name: "assert conditional Q&A navigation",
		match: /^the Turn (offers|omits) Q&A on (desktop|phone)$/,
		run: async ({ world, match }) => {
			const panel = world.page.locator("#messages .turn-activity");
			const expand = panel.getByRole("button", { name: "Expand turn", exact: true });
			if (await expand.count()) await expand.click();
			const phoneMenu = panel.getByRole("button", { name: "Show messages", exact: true });
			if (match[2] === "phone" && await phoneMenu.count()) {
				await phoneMenu.click();
				await expect(world.page.getByRole("menuitemradio", { name: "Q&A", exact: true })).toHaveCount(match[1] === "offers" ? 1 : 0);
				await world.page.keyboard.press("Escape");
			} else {
				await expect(panel.getByRole("tab", { name: "Q&A", exact: true })).toHaveCount(match[1] === "offers" ? 1 : 0);
			}
		},
	},
];
