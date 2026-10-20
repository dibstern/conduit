import { expect, type Page } from "@playwright/test";
import {
	type ProposalFixtureState,
	surfacingTuningFixture,
} from "../../../test/e2e/fixtures/surfacing-tuning.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const fixtures = new WeakMap<Page, ReturnType<typeof surfacingTuningFixture>>();
const fixture = (page: Page) => {
	const value = fixtures.get(page);
	if (!value) throw new Error("Surfacing tuning fixture was not seeded");
	return value;
};
const requests = (page: Page, tag: string) =>
	requireRpcControl(page)
		.getRequests()
		.filter((request) => request.tag === tag);
const review = (page: Page) => page.getByTestId("surfacing-proposal-review");
const hunk = (page: Page, id: string) =>
	page.getByTestId(`surfacing-proposal-hunk-${id}`);
const preview = (page: Page) => page.getByTestId("surfacing-category-preview");

export const surfacingTuningHandlers: StepHandler[] = [
	{
		name: "seed the feedback ledger and tuning RPC seam",
		match:
			/^Surfacing tuning has (\d+) marks and a (valid|none) key in the (dark|light) theme$/,
		run: async ({ world, match }) => {
			const seeded = surfacingTuningFixture({
				marks: Number(match[1]),
				key: match[2] === "none" ? "none" : "valid",
			});
			fixtures.set(world.page, seeded);
			requireRpcControl(world.page).setStubs(seeded.stubs);
			await world.page.evaluate(
				(theme) => localStorage.setItem("conduit-theme", theme),
				match[3] ?? "dark",
			);
			await world.page.reload();
			await expect(world.page.locator("#connect-overlay")).toBeHidden();
		},
	},
	{
		name: "open feedback and tuning",
		match: /^I open Surfacing Feedback$/,
		run: async ({ world }) => {
			await world.page.getByTestId("surfacing-tab-feedback").click();
			await expect(
				world.page.getByTestId("surfacing-settings-feedback"),
			).toBeVisible();
		},
	},
	{
		name: "assert the five mark threshold",
		match:
			/^Surfacing explains the five-mark proposal threshold with (\d+) marks$/,
		run: async ({ world, match }) => {
			const panel = world.page.getByTestId("surfacing-settings-feedback");
			await expect(panel).toContainText(
				"Raise or lower a few messages and Opus can propose fixes",
			);
			await expect(panel).toContainText(`${match[1]}`);
			await expect(
				panel.getByRole("button", { name: "Propose changes", exact: true }),
			).toBeDisabled();
			expect(requests(world.page, "ProposeCategoryTuning")).toHaveLength(0);
		},
	},
	{
		name: "assert feedback summary counts",
		match: /^Surfacing shows feedback tiles and category counts$/,
		run: async ({ world }) => {
			const tiles = world.page.getByTestId("surfacing-feedback-tiles");
			for (const text of [
				"Marks",
				"6",
				"Agreement now",
				"Most raised",
				"Most lowered",
				"Finding",
				"Milestone",
			])
				await expect(tiles).toContainText(text);
			await expect(tiles).toContainText("3 ▲ · 2 ▼ · 1 ⇄");
			await expect(tiles).toContainText("1 / 6");
			const grid = world.page.getByTestId("surfacing-feedback-grid");
			for (const text of [
				"Finding",
				"Milestone",
				"Risk",
				"Replan",
				"raised",
				"lowered",
				"retyped",
			])
				await expect(grid).toContainText(text);
			for (const [label, counts] of [
				["Finding", ["2", "0", "0"]],
				["Milestone", ["0", "2", "0"]],
				["Risk", ["0", "0", "1"]],
				["Replan", ["1", "0", "0"]],
			] as const) {
				const cells = await grid
					.getByRole("row")
					.filter({ hasText: label })
					.getByRole("cell")
					.allTextContents();
				expect(cells.slice(1)).toEqual(counts);
			}
			expect(
				fixture(world.page).scoreRequests.every(
					({ jevCalls }) => jevCalls === 0,
				),
			).toBe(true);
		},
	},
	{
		name: "assert newest-first ledger content",
		match:
			/^Surfacing ledger records are newest first with verdicts reasons and session titles$/,
		run: async ({ world }) => {
			const records = world.page.getByTestId("surfacing-ledger-record");
			await expect(records).toHaveCount(6);
			for (const [index, record] of fixture(world.page).records.entries()) {
				await expect(records.nth(index)).toContainText(`#${record.ordinal}`);
				await expect(records.nth(index)).toContainText(record.text);
				await expect(records.nth(index)).toContainText(record.sessionTitle);
				await expect(records.nth(index)).toContainText(
					record.mark.reason ?? "",
				);
				await expect(records.nth(index)).toContainText("Jev");
			}
		},
	},
	{
		name: "clear the newest mark",
		match: /^I clear the newest Surfacing mark$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("surfacing-ledger-record")
				.first()
				.getByRole("button", { name: /Clear mark/ })
				.click();
		},
	},
	{
		name: "assert clear targets only one part",
		match: /^only that Surfacing mark is cleared$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("surfacing-ledger-record"),
			).toHaveCount(5);
			expect(
				fixture(world.page).records.some(
					({ partId }) => partId === "tuning-part-21",
				),
			).toBe(false);
			expect(
				requests(world.page, "SetSurfacingMark").at(-1)?.payload,
			).toMatchObject({ partId: "tuning-part-21", mark: null });
			expect(requests(world.page, "ReplaceCategorySet")).toHaveLength(0);
		},
	},
	{
		name: "set the next proposal response",
		match: /^the next Surfacing proposal is (pending|failed|empty)$/,
		run: ({ world, match }) =>
			fixture(world.page).setProposalState(match[1] as ProposalFixtureState),
	},
	{
		name: "request an Opus proposal",
		match: /^I request Surfacing changes$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: "Propose changes", exact: true })
				.click();
		},
	},
	{
		name: "assert proposing failed and empty states",
		match: /^Surfacing shows the (pending|failed|empty) proposal state$/,
		run: async ({ world, match }) => {
			const panel = world.page.getByTestId("surfacing-settings-feedback");
			if (match[1] === "pending") {
				await expect(panel).toContainText(/Proposing|Reading 6 marks/);
				expect(fixture(world.page).proposalRequests).toHaveLength(1);
				await expect(
					world.page.getByTestId("surfacing-proposal-apply"),
				).toBeHidden();
			} else if (match[1] === "failed") {
				await expect(panel).toContainText("Claude is not signed in");
				await expect(
					panel.getByRole("button", { name: "Retry", exact: true }),
				).toBeVisible();
			} else await expect(panel).toContainText("No changes suggested");
			expect(requests(world.page, "ReplaceCategorySet")).toHaveLength(0);
		},
	},
	{
		name: "recover a proposal state",
		match:
			/^Surfacing can recover from the (pending|failed|empty) proposal state$/,
		run: async ({ world, match }) => {
			if (match[1] === "pending") fixture(world.page).resolveProposal();
			else if (match[1] === "failed")
				await world.page
					.getByRole("button", { name: "Retry", exact: true })
					.click();
			else return;
			await expect(review(world.page)).toBeVisible();
		},
	},
	{
		name: "assert proposal changes stay local and explain evidence",
		match: /^Surfacing shows proposal diffs evidence and checked changes$/,
		run: async ({ world }) => {
			await expect(review(world.page)).toBeVisible();
			for (const [id, label] of [
				["finding-weight", "Finding"],
				["milestone-definition", "Milestone"],
				["replan-weight", "Replan"],
			]) {
				await expect(hunk(world.page, id ?? "")).toBeVisible();
				await expect(
					world.page.getByRole("checkbox", {
						name: `Include ${label} change`,
						exact: true,
					}),
				).toBeChecked();
			}
			await expect(hunk(world.page, "finding-weight")).toContainText("40");
			await expect(hunk(world.page, "finding-weight")).toContainText("60");
			await expect(hunk(world.page, "finding-weight")).toContainText(/#1|#26/);
			await expect(hunk(world.page, "milestone-definition")).toContainText(
				"build or test runs that only report green",
			);
			await expect(review(world.page)).toContainText(/Agrees|Agreement/);
			expect(fixture(world.page).settings.categories.version).toBe(1);
			expect(requests(world.page, "ReplaceCategorySet")).toHaveLength(0);
		},
	},
	{
		name: "assert missing TypeSafe key keeps proposal usable",
		match: /^Surfacing explains that definition scoring needs a TypeSafe key$/,
		run: async ({ world }) => {
			await expect(review(world.page)).toContainText(/TypeSafe key/);
			await expect(
				world.page.getByTestId("surfacing-proposal-apply"),
			).toBeEnabled();
			expect(
				fixture(world.page).scoreRequests.every(
					({ jevCalls }) => jevCalls === 0,
				),
			).toBe(true);
		},
	},
	{
		name: "require explicit paid proposal test",
		match: /^scoring a proposal definition requires an explicit paid test$/,
		run: async ({ world }) => {
			const seeded = fixture(world.page);
			expect(
				seeded.scoreRequests.reduce((sum, { jevCalls }) => sum + jevCalls, 0),
			).toBe(0);
			const test = hunk(world.page, "milestone-definition").getByRole(
				"button",
				{ name: /Test.*9.*Jev calls/ },
			);
			await expect(test).toBeVisible();
			await test.click();
			await expect
				.poll(() =>
					seeded.scoreRequests.reduce((sum, { jevCalls }) => sum + jevCalls, 0),
				)
				.toBe(9);
		},
	},
	{
		name: "apply only checked changes",
		match: /^I exclude the Milestone change and apply the Surfacing proposal$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("checkbox", {
					name: "Include Milestone change",
					exact: true,
				})
				.uncheck();
			await world.page.getByTestId("surfacing-proposal-apply").click();
		},
	},
	{
		name: "assert selected category save bumps version",
		match: /^only checked category changes are saved at the next version$/,
		run: async ({ world }) => {
			const seeded = fixture(world.page);
			await expect.poll(() => seeded.settings.categories.version).toBe(2);
			expect(
				seeded.settings.categories.categories.find(({ id }) => id === "finding")
					?.weight,
			).toBe(60);
			expect(
				seeded.settings.categories.categories.find(({ id }) => id === "replan")
					?.weight,
			).toBe(75);
			expect(
				seeded.settings.categories.categories.find(
					({ id }) => id === "milestone",
				)?.criteria.not_for,
			).toBeUndefined();
			expect(
				requests(world.page, "ReplaceCategorySet").at(-1)?.payload[
					"expectedVersion"
				],
			).toBe(1);
			await expect(review(world.page)).toBeHidden();
			await expect(
				world.page.getByTestId("surfacing-settings-feedback"),
			).toContainText("Applied");
		},
	},
	{
		name: "regenerate with rejected changes",
		match: /^I exclude the Milestone change and propose again$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("checkbox", {
					name: "Include Milestone change",
					exact: true,
				})
				.uncheck();
			await world.page.getByTestId("surfacing-proposal-again").click();
			await expect
				.poll(() => fixture(world.page).proposalRequests.length)
				.toBe(2);
		},
	},
	{
		name: "assert avoid is scoped to unchecked hunks",
		match: /^the next Surfacing request avoids only the rejected change$/,
		run: ({ world }) => {
			expect(fixture(world.page).proposalRequests[0]?.avoid).toEqual([]);
			expect(
				fixture(world.page).proposalRequests[1]?.avoid.map(({ id }) => id),
			).toEqual(["milestone-definition"]);
		},
	},
	{
		name: "dismiss local proposal",
		match: /^I dismiss the Surfacing proposal$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: "Dismiss", exact: true })
				.click();
		},
	},
	{
		name: "assert dismissed proposal is not persisted",
		match: /^the proposal is gone and no categories were saved$/,
		run: async ({ world }) => {
			await expect(review(world.page)).toBeHidden();
			expect(requests(world.page, "ReplaceCategorySet")).toHaveLength(0);
			expect(fixture(world.page).settings.categories.version).toBe(1);
		},
	},
	{
		name: "apply a stale proposal",
		match:
			/^categories change elsewhere before the Surfacing proposal is applied$/,
		run: async ({ world }) => {
			// Wait for the review first: a change landing before the proposal
			// arrives makes it stale on arrival, so Apply never renders.
			const apply = world.page.getByTestId("surfacing-proposal-apply");
			await expect(apply).toBeEnabled();
			fixture(world.page).settings.changeElsewhere();
			await apply.click();
		},
	},
	{
		name: "assert stale proposal reloads and cannot overwrite",
		match:
			/^Surfacing reloads the changed categories and asks for another proposal$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("surfacing-settings-feedback"),
			).toContainText(/changed elsewhere/);
			await expect(
				world.page.getByTestId("surfacing-proposal-apply"),
			).toBeDisabled();
			await expect(
				world.page.getByTestId("surfacing-proposal-again"),
			).toBeEnabled();
			expect(fixture(world.page).settings.categories.version).toBe(2);
			const tags = requireRpcControl(world.page)
				.getRequests()
				.map(({ tag }) => tag);
			expect(tags.slice(tags.lastIndexOf("ReplaceCategorySet"))).toContain(
				"GetCategorySet",
			);
		},
	},
	{
		name: "assert free category preview waits for the edit debounce",
		match: /^weight preview is debounced and makes no paid Jev call$/,
		run: async ({ world }) => {
			const page = world.page;
			await expect(preview(page)).toBeVisible();
			await expect(preview(page)).toContainText("agrees with");
			const now = Date.now();
			await page.clock.install({ time: now });
			await page.clock.pauseAt(now + 1);
			const initial = fixture(page).scoreRequests.length;
			await page.getByRole("button", { name: "Raise Finding weight" }).click();
			await page.getByRole("button", { name: "Raise Finding weight" }).click();
			await page.clock.runFor(499);
			expect(fixture(page).scoreRequests.length).toBe(initial);
			await page.clock.runFor(1);
			await expect
				.poll(() => fixture(page).scoreRequests.length)
				.toBe(initial + 2);
			await expect(preview(page)).toContainText("agrees with");
			await expect(preview(page)).toContainText("Balanced shows");
			expect(
				fixture(page).scoreRequests.every(({ jevCalls }) => jevCalls === 0),
			).toBe(true);
			await page.clock.resume();
		},
	},
	{
		name: "show definition scoring cost before spending",
		match: /^definition preview shows its call count before an explicit test$/,
		run: async ({ world }) => {
			const page = world.page;
			const row = page.getByTestId("surfacing-category-row-milestone");
			await row.hover();
			await row
				.getByRole("button", { name: "Edit Milestone definition", exact: true })
				.click();
			await page
				.getByRole("textbox", { name: "Not for", exact: true })
				.fill("build or test runs that only report green");
			await page.getByTestId("surfacing-category-apply").click();
			await expect(preview(page)).toContainText("9");
			await expect(preview(page)).toContainText(/Jev calls/);
			expect(
				fixture(page).scoreRequests.every(({ jevCalls }) => jevCalls === 0),
			).toBe(true);
			await page
				.getByRole("button", {
					name: "Test against my corrections",
					exact: true,
				})
				.click();
			await expect
				.poll(() =>
					fixture(page).scoreRequests.reduce(
						(sum, { jevCalls }) => sum + jevCalls,
						0,
					),
				)
				.toBe(9);
			await expect(preview(page)).toContainText("agrees with");
			expect(requests(page, "ReplaceCategorySet")).toHaveLength(0);
		},
	},
];
