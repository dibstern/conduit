import { expect, type Page } from "@playwright/test";
import type { ProjectInfo } from "../../../src/lib/shared-types.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const home = "/Users/dev";
const folderPath = (name: string) => `${home}/src/${name}`;
const folderNames = (names: string) =>
	names.split(",").map((name) => name.trim());
const dialog = (page: Page) =>
	page.getByRole("dialog", { name: "Add a project", exact: true });
const row = (page: Page, name: string) =>
	dialog(page).locator(
		`[data-testid="folder-picker-row"][data-path="${folderPath(name)}"]`,
	);

export const addProjectDialogHandlers: StepHandler[] = [
	{
		name: "seed Add project folder suggestions",
		match: /^the Add project dialog has folder suggestions$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			let projects: ProjectInfo[] = [
				{ slug: "myapp", title: "myapp", folders: ["/myapp"] },
			];
			rpc.setProjects({ projects, current: "myapp" });
			rpc.setStubs({
				GetProjects: () => ({ projects, current: "myapp" }),
				FindFolders: ({ query }) => ({
					home,
					entries: [
						{ path: folderPath("conduit"), reason: "recent" as const },
						{ path: folderPath("docs"), reason: "recent" as const },
						{ path: folderPath("api"), reason: "sibling" as const },
					]
						.filter((entry) => entry.path.includes(query))
						.map((entry) => ({
							...entry,
							isGitRepo: entry.path !== folderPath("docs"),
							exists: true,
						})),
				}),
				SaveProject: ({ folders, title }) => {
					const [main, ...extra] = folders.map((folder) =>
						typeof folder === "string" ? folder : folder.path,
					);
					if (!main) throw new Error("A project needs a main folder");
					projects = [
						...projects,
						{
							slug: "dialog-project",
							title: title ?? "New project",
							folders: [main, ...extra],
						},
					];
					rpc.setProjects({ projects, current: "myapp" });
					return {
						projects,
						current: "myapp",
						savedSlug: "dialog-project",
						warnings: [],
					};
				},
			});
		},
	},
	{
		name: "open Add project dialog",
		match: /^I open the Add project dialog$/,
		run: async ({ world }) => {
			const back = world.page.getByTestId("session-bar-back");
			if (await back.isVisible()) await back.click();
			await world.page.getByTestId("session-scope-chip").click();
			await world.page
				.getByRole("menuitem", { name: "Add a project…", exact: true })
				.click();
			await expect(dialog(world.page)).toBeVisible();
			await expect(row(world.page, "conduit")).toBeVisible();
		},
	},
	{
		name: "assert phone project sheet",
		match: /^the Add project dialog is a phone sheet with a handle$/,
		run: async ({ world }) => {
			const sheet = dialog(world.page);
			await expect(sheet).toHaveAttribute("data-placement", "sheet");
			await expect(sheet.locator("[data-sheet-handle]")).toBeVisible();
			await expect(sheet.locator("[data-sheet-chrome]")).toHaveCSS(
				"border-top-left-radius",
				"22px",
			);
			const bounds = await sheet.locator("[data-sheet-chrome]").boundingBox();
			expect(bounds).not.toBeNull();
			expect(bounds?.y).toBeGreaterThanOrEqual(84);
			await expect(
				sheet.getByRole("button", { name: "Cancel", exact: true }),
			).toHaveCount(0);
			await expect(row(world.page, "conduit")).toHaveCSS("height", "52px");
			for (const input of await sheet.locator("input, textarea").all()) {
				expect(
					await input.evaluate((element) =>
						parseFloat(getComputedStyle(element).fontSize),
					),
				).toBeGreaterThanOrEqual(16);
			}
		},
	},
	{
		name: "tap project sheet scrim",
		match: /^I tap the Add project sheet scrim$/,
		run: async ({ world }) => {
			await expect(
				dialog(world.page).locator("[data-sheet-handle]"),
			).toBeVisible();
			const touch = await world.page.context().newCDPSession(world.page);
			try {
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [{ x: 12, y: 12 }],
				});
				await touch.send("Input.dispatchTouchEvent", {
					type: "touchEnd",
					touchPoints: [],
				});
			} finally {
				await touch.detach();
			}
		},
	},
	{
		name: "assert project dismissal restores focus",
		match: /^the Add project dialog is closed and focus returns to its opener$/,
		run: async ({ world }) => {
			await expect(dialog(world.page)).toBeHidden();
			await expect(world.page.getByTestId("session-scope-chip")).toBeFocused();
		},
	},
	{
		name: "seed a scrolling project folder list",
		match: /^the Add project folder list is long enough to scroll$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setStubs({
				FindFolders: () => ({
					home,
					entries: [
						"conduit",
						"api",
						...Array.from(
							{ length: 24 },
							(_, index) => `repository-${index + 1}`,
						),
					].map((name) => ({
						path: folderPath(name),
						reason: "recent" as const,
						exists: true,
						isGitRepo: true,
					})),
				}),
			});
		},
	},
	{
		name: "scroll project sheet body",
		match: /^I scroll the Add project folder list to the bottom$/,
		run: async ({ world }) => {
			const body = dialog(world.page).locator("[data-sheet-body]");
			await body.evaluate((element) => {
				element.scrollTop = element.scrollHeight;
			});
			await expect
				.poll(() => body.evaluate((element) => element.scrollTop))
				.toBeGreaterThan(0);
		},
	},
	{
		name: "assert project sheet footer stays visible",
		match: /^the Add project sheet footer is visible above the folder list$/,
		run: async ({ world }) => {
			const footer = dialog(world.page).locator("[data-sheet-footer]");
			const button = footer.getByRole("button", {
				name: "Add project",
				exact: true,
			});
			await expect(button).toBeInViewport({ ratio: 1 });
			await expect(button).toBeEnabled();
			for (const chip of await footer
				.getByTestId("project-folder-chip")
				.all()) {
				await expect(chip).toBeInViewport({ ratio: 1 });
			}
			const body = await dialog(world.page)
				.locator("[data-sheet-body]")
				.boundingBox();
			const bounds = await footer.boundingBox();
			expect(body).not.toBeNull();
			expect(bounds).not.toBeNull();
			expect(bounds?.y).toBeGreaterThanOrEqual(
				(body?.y ?? 0) + (body?.height ?? 0),
			);
		},
	},
	{
		name: "toggle a suggested project folder",
		match: /^I toggle the ([a-z0-9-]+) folder row$/,
		run: async ({ world, match }) => {
			await row(world.page, match[1] ?? "").click();
		},
	},
	{
		name: "assert project folder tick state",
		match: /^the ([a-z0-9-]+) folder row is (ticked|unticked)$/,
		run: async ({ world, match }) => {
			await expect(row(world.page, match[1] ?? "")).toHaveAttribute(
				"aria-selected",
				String(match[2] === "ticked"),
			);
		},
	},
	{
		name: "assert project chips in order and main folder",
		match: /^the project folder chips are (.+) with ([a-z0-9-]+) as Main$/,
		run: async ({ world, match }) => {
			const names = folderNames(match[1] ?? "");
			const chips = dialog(world.page).getByTestId("project-folder-chip");
			await expect(chips).toHaveCount(names.length);
			for (const [index, name] of names.entries()) {
				const chip = chips.nth(index);
				await expect(chip).toHaveAttribute("data-path", folderPath(name));
				await expect(chip.getByText("Main", { exact: true })).toHaveCount(
					name === match[2] ? 1 : 0,
				);
			}
		},
	},
	{
		name: "assert no project folder chips",
		match: /^the project has no folder chips$/,
		run: async ({ world }) => {
			await expect(
				dialog(world.page).getByTestId("project-folder-chip"),
			).toHaveCount(0);
		},
	},
	{
		name: "remove a project folder chip",
		match: /^I remove the ([a-z0-9-]+) project folder chip$/,
		run: async ({ world, match }) => {
			await dialog(world.page)
				.getByRole("button", {
					name: `Remove folder: ${folderPath(match[1] ?? "")}`,
					exact: true,
				})
				.click();
		},
	},
	{
		name: "promote a project folder to main",
		match: /^I make ([a-z0-9-]+) the main project folder$/,
		run: async ({ world, match }) => {
			await dialog(world.page)
				.getByRole("button", {
					name: `Make main: ${folderPath(match[1] ?? "")}`,
					exact: true,
				})
				.click();
		},
	},
	{
		name: "assert ticking has not saved a project",
		match: /^no project has been saved from the dialog$/,
		run: ({ world }) => {
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter((request) => request.tag === "SaveProject"),
			).toHaveLength(0);
		},
	},
	{
		name: "save Add project dialog",
		match: /^I save the Add project dialog$/,
		run: async ({ world }) => {
			await dialog(world.page)
				.getByRole("button", { name: "Add project", exact: true })
				.click();
			await expect(dialog(world.page)).toBeHidden();
		},
	},
	{
		name: "assert one project saved with ordered folders",
		match: /^one project is saved with folders (.+) in that order$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const saved = await rpc.waitForRequest(
				(request) => request.tag === "SaveProject",
			);
			const folders = folderNames(match[1] ?? "").map(folderPath);
			expect(saved.payload["folders"]).toEqual(folders);
			expect(
				rpc.getRequests().filter((request) => request.tag === "SaveProject"),
			).toHaveLength(1);
			expect(rpc.projectsFrame()["projects"]).toEqual([
				{ slug: "myapp", title: "myapp", folders: ["/myapp"] },
				expect.objectContaining({ slug: "dialog-project", folders }),
			]);
		},
	},
];
