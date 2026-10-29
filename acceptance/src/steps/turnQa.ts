import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";
import { chooseShowStop } from "./turnActivityShow.js";

export const turnQaHandlers: StepHandler[] = [
	{
		name: "draft Q&A answer",
		match: /^I draft an answer in Q&A$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("region", { name: "Turn Q&A", exact: true })
				.getByRole("textbox", { name: "Type your answer", exact: true })
				.fill("Canary rollout");
		},
	},
	{
		name: "assert Q&A draft retained",
		match: /^Q&A keeps the unfinished answer$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByRole("region", { name: "Turn Q&A", exact: true })
					.getByRole("textbox", { name: "Type your answer", exact: true }),
			).toHaveValue("Canary rollout");
		},
	},
	{
		name: "select Q&A staging option",
		match: /^I select the Q&A staging option$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("region", { name: "Turn Q&A", exact: true })
				.locator(".question-card")
				.getByText("Staging", { exact: true })
				.click();
		},
	},
	{
		name: "assert Q&A option retained",
		match: /^Q&A keeps the selected staging option$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByRole("region", { name: "Turn Q&A", exact: true })
					.locator(".question-card")
					.getByRole("radio")
					.first(),
			).toBeChecked();
		},
	},
	{
		name: "dismiss Q&A async question",
		match: /^I dismiss the Q&A async question$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("region", { name: "Turn Q&A", exact: true })
				.getByRole("button", { name: "Dismiss question", exact: true })
				.click();
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "RejectQuestion",
			);
			expect(request.payload["toolId"]).toBe("waiting-question");
		},
	},
	{
		name: "assert Q&A async dismissal retained",
		match: /^the Q&A async question stays dismissed$/,
		run: async ({ world }) => {
			const qa = world.page.getByRole("region", {
				name: "Turn Q&A",
				exact: true,
			});
			await expect(qa.locator(".question-card")).toHaveCount(0);
			await expect(qa).toContainText("Dismissed");
		},
	},
	{
		name: "assert hand-back pins",
		match: /^the strip has a question-mark pin for each hand-back$/,
		run: async ({ world }) => {
			const pins = world.page
				.locator("#messages .turn-activity")
				.getByTestId("turn-hand-back-pin");
			await expect(pins).toHaveCount(2);
			for (const pin of await pins.all()) {
				await expect(pin).toBeVisible();
				await expect(pin).toHaveText("?");
			}
		},
	},
	{
		name: "activate hand-back navigation",
		match:
			/^I activate hand-back (1|2) by (pin|pin keyboard|collapsed pin|row)$/,
		run: async ({ world, match }) => {
			const panel = world.page.locator("#messages .turn-activity");
			const index = Number(match[1]) - 1;
			if (match[2] === "row") {
				const expand = panel.getByRole("button", {
					name: "Expand turn",
					exact: true,
				});
				if (await expand.count()) await expand.click();
				const tab = panel.getByRole("tab", {
					name: /^(Full log|Log)$/,
					exact: true,
				});
				if (await tab.count()) await tab.click();
				else await chooseShowStop(world.page, "Full log");
				await panel.getByTestId("turn-hand-back-row").nth(index).click();
				return;
			}
			if (match[2] === "collapsed pin") {
				const collapse = panel.getByRole("button", {
					name: "Collapse turn",
					exact: true,
				});
				if (await collapse.count()) await collapse.click();
			}
			const pin = panel.getByTestId("turn-hand-back-pin").nth(index);
			if (match[2] === "pin keyboard") {
				await pin.focus();
				await world.page.keyboard.press("Enter");
			} else await pin.click();
		},
	},
	{
		name: "assert focused Q&A entry",
		match: /^Q&A focuses hand-back (1|2)$/,
		run: async ({ world, match }) => {
			const qa = world.page.getByRole("region", {
				name: "Turn Q&A",
				exact: true,
			});
			await expect(qa).toBeVisible();
			const entry = qa.locator("[data-qa-entry]").nth(Number(match[1]) - 1);
			await expect(entry).toBeFocused();
			await expect(entry).toBeInViewport();
			await expect(entry).toContainText(
				match[1] === "1" ? "Which target?" : "Deploy to staging.",
			);
		},
	},
	{
		name: "assert inline Q&A plan approval",
		match: /^the plan approval is answerable only in Q&A$/,
		run: async ({ world }) => {
			const qa = world.page.getByRole("region", {
				name: "Turn Q&A",
				exact: true,
			});
			await expect(qa).toBeVisible();
			await expect(
				world.page.locator("#messages .permission-card"),
			).toHaveCount(1);
			await expect(qa.getByTestId("plan-approval-content")).toContainText(
				"Deploy to staging.",
			);
			await expect(
				qa.getByRole("button", { name: "Approve Plan", exact: true }),
			).toBeVisible();
			await expect(
				world.page
					.locator("#messages")
					.getByRole("button", { name: "Approve Plan", exact: true }),
			).toHaveCount(1);
		},
	},
	{
		name: "approve Q&A plan",
		match: /^I approve the Q&A plan$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("region", { name: "Turn Q&A", exact: true })
				.getByRole("button", { name: "Approve Plan", exact: true })
				.click();
		},
	},
	{
		name: "assert Q&A plan approval RPC",
		match: /^the Q&A plan approval reaches the relay$/,
		run: async ({ world }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === "RespondPermission",
			);
			expect(request.payload["requestId"]).toBe("waiting-question");
			expect(request.payload["decision"]).toBe("allow");
		},
	},
	{
		name: "assert waiting Q&A default",
		match: /^the waiting Turn defaults to Q&A$/,
		run: async ({ world }) => {
			const panel = world.page.locator("#messages .turn-activity");
			await expect(
				panel.getByRole("region", { name: "Turn Q&A", exact: true }),
			).toBeVisible();
			await expect(panel.locator(".question-card")).toBeVisible();
			await expect(panel.locator(".step-log:visible")).toHaveCount(0);
			await expect(panel.getByTestId("turn-show-bar")).toBeVisible();
		},
	},
	{
		name: "choose waiting log",
		match: /^I choose the waiting Turn log$/,
		run: async ({ world }) => {
			const panel = world.page.locator("#messages .turn-activity");
			const tab = panel.getByRole("tab", {
				name: /^(Full log|Log)$/,
				exact: true,
			});
			if (await tab.count()) await tab.click();
			else await chooseShowStop(world.page, "Full log");
		},
	},
	{
		name: "assert explicit waiting log pick",
		match: /^the waiting Turn respects the log pick with a three-step ticker$/,
		run: async ({ world }) => {
			const panel = world.page.locator("#messages .turn-activity");
			const log = panel.getByRole("region", { name: /^Turn log,/ });
			await expect(log).toBeVisible();
			await expect(log.locator("[data-log-part]:visible")).toHaveCount(3);
			await expect(
				panel.getByRole("region", { name: "Turn Q&A", exact: true }),
			).toHaveCount(0);
		},
	},
	{
		name: "assert answered live default",
		match: /^the answered Turn returns to its live log default$/,
		run: async ({ world }) => {
			const panel = world.page.locator("#messages .turn-activity");
			await expect(
				panel.getByRole("region", { name: "Turn Q&A", exact: true }),
			).toHaveCount(0);
			await expect(
				panel.getByRole("region", { name: /^Turn log,/ }),
			).toBeVisible();
			await expect(
				panel.getByRole("button", { name: /^Collapse turn$/ }),
			).toContainText("Working");
			await expect(world.page.locator(".question-card")).toHaveCount(0);
		},
	},
	{
		name: "select Turn Q&A",
		match: /^I select the Turn Q&A tab$/,
		run: async ({ world }) => {
			const panel = world.page.locator("#messages .turn-activity");
			const toggle = panel.getByTestId("surfacing-minimise-toggle");
			await expect(toggle).toBeVisible();
			if ((await toggle.getAttribute("aria-expanded")) === "false")
				await toggle.click();
			const tab = panel.getByRole("tab", { name: "Q&A", exact: true });
			await expect(
				tab.or(
					panel.getByRole("button", { name: "Show messages", exact: true }),
				),
			).toBeVisible();
			if (await tab.isVisible()) await tab.click();
			else await chooseShowStop(world.page, "Q&A");
		},
	},
	{
		name: "assert ordered Q&A history",
		match: /^Q&A lists the question and plan with their answers in order$/,
		run: async ({ world }) => {
			const qa = world.page.getByRole("region", {
				name: "Turn Q&A",
				exact: true,
			});
			await expect(qa).toBeVisible();
			const entries = qa.locator("[data-qa-entry]");
			await expect(entries).toHaveCount(2);
			await expect(entries.nth(0)).toContainText("Which target?");
			await expect(entries.nth(0)).toContainText("Staging");
			await expect(entries.nth(0)).toContainText("Answered");
			await expect(entries.nth(1)).toContainText("Deploy to staging.");
			await expect(entries.nth(1)).toContainText("Approved");
			await expect(
				world.page
					.locator("#messages .turn-activity")
					.getByTestId("surfacing-msg-card"),
			).toHaveCount(0);
			await expect(
				world.page.locator("#messages .step-log:visible"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert conditional Q&A navigation",
		match: /^the Turn (offers|omits) Q&A on (desktop|phone)$/,
		run: async ({ world, match }) => {
			const panel = world.page.locator("#messages .turn-activity");
			const expand = panel.getByRole("button", {
				name: "Expand turn",
				exact: true,
			});
			if (await expand.count()) await expand.click();
			const phoneMenu = panel.getByRole("button", {
				name: "Show messages",
				exact: true,
			});
			if (match[2] === "phone" && (await phoneMenu.count())) {
				// Wait for the menu to take focus: an absent Q&A item passes at once,
				// and an Escape that still lands on the trigger folds the open card.
				const menu = world.page.getByRole("menu");
				await phoneMenu.click();
				await expect
					.poll(() =>
						menu.evaluate((el) => el.contains(document.activeElement)),
					)
					.toBe(true);
				await expect(
					menu.getByRole("menuitemradio", { name: "Q&A", exact: true }),
				).toHaveCount(match[1] === "offers" ? 1 : 0);
				await world.page.keyboard.press("Escape");
				await expect(menu).toHaveCount(0);
			} else {
				await expect(
					panel.getByRole("tab", { name: "Q&A", exact: true }),
				).toHaveCount(match[1] === "offers" ? 1 : 0);
			}
		},
	},
];
