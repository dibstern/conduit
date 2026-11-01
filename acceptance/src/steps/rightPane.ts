import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

export const rightPaneHandlers: StepHandler[] = [
	{
		name: "escape file preview",
		match: /^I press Escape in the right pane$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "file tree after preview",
		match: /^the file tree is visible without a preview$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#right-pane #file-tree")).toBeVisible();
			await expect(world.page.locator("#file-viewer")).toHaveCount(0);
		},
	},
	{
		name: "open right pane",
		match: /^I open the (Files|Diff) right pane$/,
		run: async ({ world, match }) => {
			const view = match[1]?.toLowerCase();
			requireRpcControl(world.page).setStubs({
				GetFileTree: () => ({ projectSlug: "myapp", entries: ["README.md"] }),
				GetFileList: ({ path = "." }) => ({
					projectSlug: "myapp",
					path,
					entries: [{ name: "README.md", type: "file", size: 12 }],
				}),
				GetFileContent: ({ path = "README.md" }) => ({
					projectSlug: "myapp",
					path,
					content: "# conduit\n",
				}),
			});
			if ((world.page.viewportSize()?.width ?? 1440) < 768) {
				await world.page.getByTestId("session-bar-island-overflow").click();
				await world.page.getByTestId(`overflow-view-${view}`).click();
			} else {
				await world.page.getByTestId(`views-rail-${view}`).click();
			}
			await expect(world.page.locator("#right-pane")).toBeVisible();
		},
	},
	{
		name: "select right pane tab",
		match: /^I select the (Files|Diff) right pane tab$/,
		run: async ({ world, match }) => {
			await world.page
				.locator("#right-pane")
				.getByRole("tab", { name: match[1] ?? "", exact: true })
				.click();
		},
	},
	{
		name: "right pane selection",
		match: /^the (Files|Diff) right pane is selected$/,
		run: async ({ world, match }) => {
			const pane = world.page.locator("#right-pane");
			await expect(
				pane.getByRole("tab", { name: match[1] ?? "", exact: true }),
			).toHaveAttribute("aria-selected", "true");
			await expect(
				pane.getByRole("tabpanel", { name: match[1] ?? "", exact: true }),
			).toBeVisible();
			await expect(pane.getByRole("tab", { selected: true })).toHaveCount(1);
		},
	},
	{
		name: "resize right pane",
		match: /^I resize the right pane to its minimum width$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("separator", { name: "Resize Files pane" })
				.press("Home");
		},
	},
	{
		name: "shared right pane width",
		match: /^the right pane keeps its minimum width$/,
		run: async ({ world }) => {
			await expect(world.page.getByRole("separator")).toHaveAttribute(
				"aria-valuenow",
				"280",
			);
			await expect
				.poll(
					async () =>
						(await world.page.locator("#right-pane").boundingBox())?.width,
				)
				.toBe(280);
		},
	},
	{
		name: "reload pane session",
		match: /^I reload the right pane session$/,
		run: async ({ world }) => {
			await world.page.reload();
		},
	},
	{
		name: "phone pane geometry",
		match: /^the right pane fills the phone screen$/,
		run: async ({ world }) => {
			await expect
				.poll(() => world.page.locator("#right-pane").boundingBox())
				.toEqual({ x: 0, y: 0, ...world.page.viewportSize() });
		},
	},
	{
		name: "preview file in pane",
		match: /^I preview a file in the right pane$/,
		run: async ({ world }) => {
			await world.page
				.locator("#right-pane .fb-entry:not([aria-expanded])")
				.first()
				.click();
		},
	},
	{
		name: "single file preview",
		match: /^exactly one file preview is visible$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#file-viewer")).toHaveCount(1);
			await expect(
				world.page.locator("#right-pane #file-viewer"),
			).toBeVisible();
		},
	},
	{
		name: "close right pane",
		match: /^I close the right pane$/,
		run: async ({ world }) => {
			await world.page.getByTestId("right-pane-close").click();
		},
	},
	{
		name: "chat after closing pane",
		match: /^the right pane is closed and chat is available$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#right-pane")).toHaveCount(0);
			await expect(world.page.locator("#input")).toBeEditable();
		},
	},
];
