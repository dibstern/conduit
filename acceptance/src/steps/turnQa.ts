import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";

export const turnQaHandlers: StepHandler[] = [
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
