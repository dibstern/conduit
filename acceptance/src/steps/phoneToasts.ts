import { expect } from "@playwright/test";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

export const phoneToastsHandlers: StepHandler[] = [
	{
		name: "fail the phone list's real pin request",
		match: /^pinning a phone session fails$/,
		run: async ({ world }) => {
			const cards = world.page.getByTestId("toast");
			const previous = (await cards.count())
				? await cards.elementHandle()
				: null;
			requireRpcControl(world.page).setStubs({
				SetSessionPinned: () => {
					throw new WsRpcError({ message: "Please try again." });
				},
			});
			await world.page
				.locator('[data-session-id="sess-usage-footer-1"]')
				.click({ button: "right" });
			await world.page.getByTestId("session-ctx-pin").click();
			await expect(world.page.getByTestId("toast")).toContainText(
				"Couldn't pin session",
			);
			// Wait for the second response to replace the first card before counting.
			if (previous) {
				await expect
					.poll(() => previous.evaluate((element) => element.isConnected))
					.toBe(false);
				await previous.dispose();
			}
		},
	},
	{
		name: "assert the error sheet is visible",
		match: /^the phone error toast is visible$/,
		run: async ({ world }) => {
			const toast = world.page.getByTestId("toast");
			await expect(toast).toBeVisible();
			await expect(toast).toHaveAttribute("data-variant", "error");
			await expect(toast).toContainText("Please try again.");
		},
	},
	{
		name: "assert toast and usage clearance plus the FAB hit target",
		match: /^the New session button clears the toast sheet and receives taps$/,
		run: async ({ world }) => {
			const button = world.page.locator("#new-session-btn:visible");
			await expect(button).toBeVisible();
			await expect
				.poll(() =>
					button.evaluate((element) => {
						const box = element.getBoundingClientRect();
						const sheet = document
							.querySelector('[data-testid="toast"]')
							?.parentElement?.getBoundingClientRect();
						const dock = document
							.querySelector('[data-testid="usage-footer-phone"]')
							?.getBoundingClientRect();
						const hit = document.elementFromPoint(
							box.x + box.width / 2,
							box.y + box.height / 2,
						);
						return {
							aboveSheet: !!sheet && box.bottom <= sheet.top,
							aboveDock: !dock?.height || box.bottom <= dock.top,
							hitTarget: !!hit && element.contains(hit),
						};
					}),
				)
				.toEqual({ aboveSheet: true, aboveDock: true, hitTarget: true });
		},
	},
	{
		name: "tap the raised New session button",
		match: /^I tap New session above the toast$/,
		run: async ({ world }) => {
			await world.page.locator("#new-session-btn:visible").click();
		},
	},
	{
		name: "assert New session opened a draft",
		match: /^a new session draft is open$/,
		run: async ({ world }) => {
			await expect(world.page).toHaveURL(/\/new(?:\?|$)/);
			await expect(world.page.locator("#input-area")).toBeVisible();
		},
	},
	{
		name: "assert identical errors leave one toast card",
		match: /^exactly one toast card is visible$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("toast")).toHaveCount(1);
		},
	},
];
