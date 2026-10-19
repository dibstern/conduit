import { expect } from "@playwright/test";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../src/lib/contracts/message-surfacing.js";
import type { StepHandler } from "../runtime.js";
import { mockMessageSurfacing, requireRpcControl } from "./shared.js";

export const surfacingSwitchesHandlers: StepHandler[] = [
	{
		name: "configure independent surfacing switches",
		match:
			/^Jev is off with summaries (on|off) and a (valid|missing) key in the (dark|light) theme$/,
		run: async ({ world, match }) => {
			mockMessageSurfacing.set(world.page, {
				...DEFAULT_MESSAGE_SURFACING_SETTINGS,
				summariesEnabled: match[1] === "on",
				active: false,
				key: {
					source: match[2] === "valid" ? "stored" : "none",
					rejected: false,
				},
			});
			await world.page.addInitScript(
				(theme) => localStorage.setItem("conduit-theme", theme),
				match[3] ?? "dark",
			);
		},
	},
	{
		name: "assert Jev off keeps the plain turn",
		match: /^the turn has no Jev controls$/,
		run: async ({ world }) => {
			for (const id of [
				"surfacing-card",
				"surfacing-pins",
				"surfacing-level",
				"surfacing-msg-card",
				"surfacing-ask-chip",
				"surfacing-head-unread",
				"surfacing-minimise-toggle",
			])
				await expect(world.page.getByTestId(id)).toHaveCount(0);
			// Today's activity strip stays whenever Jev is off.
			await expect(
				world.page.getByRole("slider", { name: /Activity timeline/ }),
			).toBeVisible();
			await expect(world.page.locator("#messages")).toContainText(
				"The final reply remains in the transcript.",
			);
		},
	},
	{
		name: "assert plain summary citation",
		match: /^recap citation #(\d+) is a plain chip$/,
		run: async ({ world, match }) => {
			await expect(
				world.page.getByRole("slider", { name: /Activity timeline/ }),
			).toBeVisible();
			const chip = world.page.getByTestId(`surfacing-recap-cite-${match[1]}`);
			await expect(chip).toHaveText(`#${match[1]}`);
			for (const attribute of ["data-ask", "data-unread", "data-followed"])
				await expect(chip).toHaveAttribute(attribute, "false");
		},
	},
	{
		name: "assert summary citation opens and focuses its numbered log row",
		match: /^the numbered log is focused at message #(\d+)$/,
		run: async ({ world, match }) => {
			const row = world.page.locator(`[data-message-number="${match[1]}"]`);
			await expect(row).toBeVisible();
			await expect(row).toHaveAttribute("data-highlighted", "true");
			await expect(row.locator("..")).toBeFocused();
			await expect(row).toBeInViewport();
			await expect(
				world.page.getByTestId("surfacing-recap-reader"),
			).toHaveCount(0);
		},
	},
	{
		name: "open the existing step log",
		match: /^I open the plain turn log$/,
		run: async ({ world }) => {
			const toggle = world.page.locator(".turn-activity-toggle");
			await toggle.click();
			await toggle.blur();
			await world.page.mouse.move(1, 1);
		},
	},
	{
		name: "assert both off removes message numbers",
		match: /^the plain log keeps its messages without numbers$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByRole("slider", { name: /Activity timeline/ }),
			).toBeVisible();
			await expect(world.page.locator(".step-log")).toContainText(
				"The file includes a second route.",
			);
			await expect(world.page.locator("[data-message-number]")).toHaveCount(0);
		},
	},
	{
		name: "assert missing key leaves summaries available",
		match: /^Jev needs Add key and Turn summaries stays enabled$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByRole("switch", {
					name: "Jev categorisation & escalation",
					exact: true,
				}),
			).toBeDisabled();
			await expect(
				world.page.getByRole("switch", { name: "Turn summaries", exact: true }),
			).toBeEnabled();
			await expect(world.page.getByTestId("surfacing-add-key")).toBeVisible();
			await world.page.getByTestId("surfacing-add-key").click();
			await expect(world.page.getByTestId("surfacing-key-input")).toBeFocused();
		},
	},
	{
		name: "persist only the summary switch",
		match: /^I toggle Turn summaries off and on$/,
		run: async ({ world }) => {
			const toggle = world.page.getByRole("switch", {
				name: "Turn summaries",
				exact: true,
			});
			for (const checked of [false, true]) {
				await toggle.click();
				await expect(toggle).toHaveAttribute("aria-checked", String(checked));
				await expect(toggle).toBeEnabled();
				expect(
					requireRpcControl(world.page)
						.getRequests()
						.filter(({ tag }) => tag === "UpdateMessageSurfacing")
						.at(-1)?.payload,
				).toEqual({
					_tag: "UpdateMessageSurfacing",
					summariesEnabled: checked,
				});
			}
		},
	},
	{
		name: "assert split settings survive reload",
		match: /^the split flags survive reloading settings$/,
		run: async ({ world }) => {
			await world.page.reload();
			await expect(world.page.locator("#connect-overlay")).toBeHidden();
			await world.page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", {
						detail: { section: "surfacing" },
					}),
				),
			);
			await expect(
				world.page.getByRole("switch", {
					name: "Jev categorisation & escalation",
					exact: true,
				}),
			).toHaveAttribute("aria-checked", "false");
			await expect(
				world.page.getByRole("switch", { name: "Turn summaries", exact: true }),
			).toHaveAttribute("aria-checked", "true");
		},
	},
];
