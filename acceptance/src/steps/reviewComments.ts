import { expect, type Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const diffRow = (page: Page, path: string) =>
	page.locator(`[data-testid="session-diff-file"][data-path="${path}"]`);

const reviewChip = (page: Page) =>
	page.locator("#input-area").getByTestId("review-attachment-chip");

export const reviewCommentHandlers: StepHandler[] = [
	{
		name: "comment on a diff line",
		match:
			/^I comment "([^"]+)" on (additions|deletions) line ([0-9]+) of the (\S+) diff$/,
		run: async ({ world, match }) => {
			const [, comment = "", side, line, path = ""] = match;
			const row = diffRow(world.page, path);
			// Pierre renders inside an open shadow root, which CSS locators pierce.
			await row
				.locator(
					`[data-column-number="${line}"][data-line-type="change-${side === "additions" ? "addition" : "deletion"}"]`,
				)
				.click();
			await row.getByRole("textbox", { name: "Review comment" }).fill(comment);
			await row.getByRole("button", { name: "Add to message" }).click();
		},
	},
	{
		name: "review payload",
		match:
			/^the review sent for (\S+) quotes "([^"]*)" from (additions|deletions) lines ([0-9]+) to ([0-9]+)$/,
		run: async ({ world, match }) => {
			const [, path, excerpt, side, start, end] = match;
			const control = requireRpcControl(world.page);
			const request = await control.waitForRequest(
				(candidate) => candidate.tag === "AddDraftReview",
			);
			expect(request.payload).toMatchObject({
				review: {
					path,
					side,
					lines: { start: Number(start), end: Number(end) },
					excerpt,
				},
			});
		},
	},
	{
		name: "review chip shown",
		match: /^the composer shows a review chip (\S+) saying "([^"]+)"$/,
		run: async ({ world, match }) => {
			const chip = reviewChip(world.page);
			await expect(chip).toHaveCount(1);
			await expect(chip).toContainText(match[1] ?? "");
			await expect(chip).toContainText(match[2] ?? "");
		},
	},
	{
		name: "remove review chip",
		match: /^I remove the review chip (\S+)$/,
		run: async ({ world, match }) => {
			await reviewChip(world.page)
				.getByRole("button", { name: `Remove comment ${match[1]}` })
				.click();
		},
	},
	{
		name: "no review chip",
		match: /^the composer shows no review chip$/,
		run: async ({ world }) => {
			await expect(reviewChip(world.page)).toHaveCount(0);
		},
	},
];
