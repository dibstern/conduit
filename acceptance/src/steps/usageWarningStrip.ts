import { expect } from "@playwright/test";
import type {
	UsageReading,
	UsageWindow,
} from "../../../src/lib/contracts/limit-recovery.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";
import { snapshot } from "./usageSettings.js";

export const usageWarningStripHandlers: StepHandler[] = [
	{
		name: "publish a changed usage window through the shared mock feed",
		match:
			/^the mock usage window (five_hour|seven_day|seven_day_model) for (\S+) is ([0-9]+(?:\.[0-9]+)?) percent resetting at (\S+)$/,
		run: ({ world, match }) => {
			const kind = match[1] as UsageWindow["kind"];
			const utilization = Number(match[3]);
			const resets = match[4] ?? "none";
			if (resets !== "none" && !Number.isFinite(Date.parse(resets)))
				throw new Error("Invalid usage warning reset time");
			const readings = snapshot(world.page).map((reading): UsageReading => {
				if (reading.accountId !== match[2]) return reading;
				const replacement: UsageWindow = {
					kind,
					utilization,
					...(resets === "none" ? {} : { resetsAt: resets }),
				};
				return {
					...reading,
					windows: [
						...reading.windows.filter((window) => window.kind !== kind),
						replacement,
					],
				};
			});
			const rpc = requireRpcControl(world.page);
			rpc.setUsageReadings(readings);
			rpc.setStubs({ QuotaForAccounts: () => readings });
		},
	},
	{
		name: "publish an account's usage availability or remove its reading",
		match:
			/^the mock usage reading for (\S+) becomes (available|limited|unknown|unavailable|missing)$/,
		run: ({ world, match }) => {
			const status = match[2] as UsageReading["status"] | "missing";
			const readings = snapshot(world.page).flatMap(
				(reading): UsageReading[] =>
					reading.accountId !== match[1]
						? [reading]
						: status === "missing"
							? []
							: [{ ...reading, status }],
			);
			const rpc = requireRpcControl(world.page);
			rpc.setUsageReadings(readings);
			rpc.setStubs({ QuotaForAccounts: () => readings });
		},
	},
	{
		name: "assert usage warning visibility",
		match: /^the usage warning strip is (visible|not visible)$/,
		run: async ({ world, match }) => {
			const strip = world.page.getByTestId("usage-warning-strip");
			if (match[1] === "visible") await expect(strip).toBeVisible();
			else await expect(strip).toBeHidden();
		},
	},
	{
		name: "assert which plan window warns",
		match: /^the usage warning strip shows the (five_hour|seven_day) window$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId("usage-warning-strip"),
			).toHaveAttribute("data-window", match[1] ?? "");
		},
	},
	{
		name: "assert usage warning copy",
		match: /^the usage warning strip (title|detail) reads (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByTestId(`usage-warning-${match[1]}`),
			).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "assert omission of a reset sentence",
		match: /^the usage warning strip has no reset detail$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("usage-warning-strip")).toBeVisible();
			await expect(world.page.getByTestId("usage-warning-detail")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "press a usage warning action",
		match:
			/^I press (Details|Switch account|Dismiss) on the usage warning strip$/,
		run: async ({ world, match }) => {
			const action = match[1];
			const suffix =
				action === "Details"
					? "details"
					: action === "Switch account"
						? "switch-account"
						: "dismiss";
			await world.page.getByTestId(`usage-warning-${suffix}`).click();
			if (action === "Switch account")
				await expect(
					world.page.getByTestId("account-switch-picker"),
				).toBeVisible();
			else if (action === "Details")
				await expect(world.page.getByTestId("usage-settings")).toBeVisible();
			else
				await expect(
					world.page.getByTestId("usage-warning-strip"),
				).toBeHidden();
		},
	},
	{
		name: "assert desktop and phone warning actions and their order",
		match:
			/^the usage warning actions match the (desktop|phone) (one|several) account layout$/,
		run: async ({ world, match }) => {
			const phone = match[1] === "phone";
			const several = match[2] === "several";
			const dismiss = world.page.getByTestId("usage-warning-dismiss");
			const details = world.page.getByTestId("usage-warning-details");
			const switchAccount = world.page.getByTestId(
				"usage-warning-switch-account",
			);
			await expect(dismiss).toBeVisible();
			await expect(dismiss).toHaveAccessibleName("Dismiss usage warning");
			await expect(dismiss).toHaveText(phone ? "Dismiss" : "");
			if (several) {
				await expect(details).toHaveCount(0);
				await expect(switchAccount).toBeVisible();
				await expect(switchAccount).toHaveText("Switch account");
				await expect(switchAccount.locator("svg")).toHaveCount(phone ? 0 : 1);
				await expect(switchAccount).toHaveCSS("height", "30px");
			} else {
				await expect(switchAccount).toHaveCount(0);
				if (phone) await expect(details).toHaveCount(0);
				else {
					await expect(details).toBeVisible();
					await expect(details).toHaveText("Details");
				}
			}
			if (several || !phone) {
				const actionId = several
					? "usage-warning-switch-account"
					: "usage-warning-details";
				expect(
					await dismiss.evaluate((button, id) => {
						const action = document.querySelector(`[data-testid="${id}"]`);
						if (!action) throw new Error("No usage warning action to order");
						return Boolean(
							button.compareDocumentPosition(action) &
								Node.DOCUMENT_POSITION_FOLLOWING,
						);
					}, actionId),
				).toBe(false);
			}
		},
	},
	{
		name: "assert the draft omits account switching",
		match: /^the usage warning has no Switch account action$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("usage-warning-strip")).toBeVisible();
			await expect(
				world.page.getByTestId("usage-warning-switch-account"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert warning and context strips stack with the same theme geometry",
		match: /^the usage warning stacks above the composer context warning$/,
		run: async ({ world }) => {
			const warning = world.page.getByTestId("usage-warning-strip");
			const context = world.page.getByTestId("composer-context-warning");
			await expect(warning).toBeVisible();
			await expect(context).toBeVisible();
			const [warningBox, contextBox, inputBox] = await Promise.all([
				warning.boundingBox(),
				context.boundingBox(),
				world.page.locator("#input-row").boundingBox(),
			]);
			if (!warningBox || !contextBox || !inputBox)
				throw new Error("Missing stacked warning geometry");
			expect(warningBox.y + warningBox.height).toBeCloseTo(contextBox.y, 0);
			expect(contextBox.y + contextBox.height).toBeCloseTo(inputBox.y, 0);
			expect(warningBox.x).toBeCloseTo(contextBox.x, 0);
			expect(warningBox.width).toBeCloseTo(contextBox.width, 0);
			const styles = await world.page.evaluate(() =>
				["usage-warning-strip", "composer-context-warning"].map((id) => {
					const strip = document.querySelector(`[data-testid="${id}"]`);
					if (!strip) throw new Error("Missing warning strip styles");
					const style = getComputedStyle(strip);
					return [
						style.backgroundColor,
						style.padding,
						style.fontSize,
						style.gap,
					];
				}),
			);
			expect(styles[0]).toEqual(styles[1]);
			await expect(warning).toHaveCSS("border-radius", "16px 16px 0px 0px");
			await expect(context).toHaveCSS("border-radius", "0px");
		},
	},
	{
		name: "open a draft on the bound project",
		match: /^I open the usage warning draft for (\S+)$/,
		run: async ({ world, match }) => {
			await world.page.goto(
				new URL(
					`/new?project=${encodeURIComponent(match[1] ?? "")}`,
					world.page.url(),
				).toString(),
			);
			await expect(world.page.locator("#input")).toBeVisible();
		},
	},
	{
		name: "reload to discard in-memory usage warning dismissals",
		match: /^I reload the usage warning session$/,
		run: async ({ world }) => {
			await world.page.reload();
			await expect(world.page.locator("#input")).toBeVisible();
		},
	},
];
