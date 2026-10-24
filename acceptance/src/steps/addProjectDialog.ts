import { expect, type Locator, type Page } from "@playwright/test";
import type { FindFoldersResponse } from "../../../src/lib/contracts/ws-rpc.js";
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
const browseFolders: FindFoldersResponse["entries"] = [
	{ path: home, isGitRepo: false },
	{ path: `${home}/src`, isGitRepo: false, repoCount: 2 },
	{ path: folderPath("api"), isGitRepo: true, branch: "main" },
	{ path: folderPath("conduit"), isGitRepo: true, branch: "main" },
	{ path: folderPath("conduit/lib"), isGitRepo: false },
	{ path: folderPath("docs"), isGitRepo: false },
	{ path: folderPath("personal"), isGitRepo: false, repoCount: 2 },
	{ path: folderPath("personal/gym"), isGitRepo: true, branch: "main" },
	{
		path: folderPath("personal/site"),
		isGitRepo: true,
		branch: "feature/site",
	},
].map((entry) => ({ ...entry, reason: "match" as const, exists: true }));

const tapFolderControl = async (page: Page, control: Locator) => {
	await expect(control).toBeVisible();
	await control.scrollIntoViewIfNeeded();
	const bounds = await control.boundingBox();
	if (!bounds) throw new Error("Folder control has no tap target");
	const touch = await page.context().newCDPSession(page);
	try {
		await touch.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [
				{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
			],
		});
		await touch.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
	} finally {
		await touch.detach();
	}
};

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
				FindFolders: ({ query }) => {
					if (query.startsWith("/") || query.startsWith("~")) {
						const expanded = query.replace(/^~/, home).replace(/\/+/g, "/");
						const path = expanded.replace(/\/$/, "") || "/";
						const parent = expanded.endsWith("/")
							? path
							: path.slice(0, path.lastIndexOf("/")) || "/";
						const prefix = expanded.endsWith("/")
							? ""
							: path.slice(path.lastIndexOf("/") + 1);
						const typed = browseFolders.find(
							(entry) => entry.path === path,
						) ?? {
							path,
							isGitRepo: false,
							reason: "match" as const,
							exists: false,
						};
						return {
							home,
							entries: [
								typed,
								...browseFolders.filter(
									(entry) =>
										entry.path !== path &&
										(entry.path.slice(0, entry.path.lastIndexOf("/")) ||
											"/") === parent &&
										entry.path
											.slice(entry.path.lastIndexOf("/") + 1)
											.toLowerCase()
											.startsWith(prefix.toLowerCase()),
								),
							],
						};
					}
					return {
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
					};
				},
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
		name: "type a project folder query",
		match: /^I type "([^"]+)" in the Add project folder search$/,
		run: async ({ world, match }) => {
			await dialog(world.page)
				.getByRole("combobox", { name: "Add folder" })
				.fill(match[1] ?? "");
		},
	},
	{
		name: "assert project folder query",
		match: /^the folder search is "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				dialog(world.page).getByRole("combobox", { name: "Add folder" }),
			).toHaveValue(match[1] ?? "");
		},
	},
	{
		name: "assert folder breadcrumb trail",
		match: /^the folder breadcrumbs are (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				dialog(world.page)
					.getByRole("navigation", { name: "Folder breadcrumbs" })
					.getByRole("button"),
			).toHaveText(folderNames(match[1] ?? ""));
		},
	},
	{
		name: "assert listed project subfolders",
		match: /^the folder rows are (.+)$/,
		run: async ({ world, match }) => {
			const names = folderNames(match[1] ?? "");
			const rows = dialog(world.page).getByTestId("folder-picker-row");
			await expect(rows).toHaveCount(names.length);
			for (const [index, name] of names.entries()) {
				await expect(rows.nth(index)).toHaveAttribute(
					"data-path",
					folderPath(name),
				);
			}
		},
	},
	{
		name: "assert folder row metadata",
		match: /^the ([a-z0-9-]+) folder row shows "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				row(world.page, match[1] ?? "").getByText(match[2] ?? "", {
					exact: true,
				}),
			).toBeVisible();
		},
	},
	{
		name: "assert folder ghost completion suffix",
		match: /^the folder ghost suffix is "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				dialog(world.page)
					.getByTestId("folder-query-ghost")
					.locator("span")
					.last(),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "accept a project folder ghost completion",
		match: /^I accept the folder ghost with Tab$/,
		run: async ({ world }) => {
			await dialog(world.page)
				.getByRole("combobox", { name: "Add folder" })
				.press("Tab");
		},
	},
	{
		name: "open a folder using its browse button",
		match: /^I tap the ([a-z0-9-]+) folder browse button$/,
		run: async ({ world, match }) => {
			await tapFolderControl(
				world.page,
				dialog(world.page).locator(
					`[data-testid="folder-picker-open"][data-path="${folderPath(match[1] ?? "")}"]`,
				),
			);
		},
	},
	{
		name: "navigate a folder breadcrumb",
		match: /^I (click|tap) the (.+) folder breadcrumb$/,
		run: async ({ world, match }) => {
			const crumb = dialog(world.page)
				.getByRole("navigation", { name: "Folder breadcrumbs" })
				.getByRole("button", { name: match[2] ?? "", exact: true });
			if (match[1] === "tap") await tapFolderControl(world.page, crumb);
			else await crumb.click();
		},
	},
	{
		name: "assert folder keyboard hint visibility",
		match: /^the folder keyboard hints are (visible|hidden)$/,
		run: async ({ world, match }) => {
			const hints = dialog(world.page).locator(
				'[aria-label="Folder keyboard shortcuts"]',
			);
			if (match[1] === "visible") await expect(hints).toBeVisible();
			else await expect(hints).toHaveCount(0);
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
