import { expect, type Locator, type Page } from "@playwright/test";
import {
	type FindFoldersResponse,
	ProjectSaveRejected,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { ProjectInfo } from "../../../src/lib/shared-types.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const home = "/Users/dev";
const pathFor = (name: string) =>
	name === "personal-site" ? `${home}/${name}` : `${home}/src/${name}`;
const namesIn = (value: string) => value.split(", ");
const screen = (page: Page) => page.getByTestId("first-run-projects");
const rows = (page: Page) =>
	screen(page).getByTestId("first-run-repos").getByTestId("first-run-repo");
const row = (page: Page, name: string) =>
	rows(page).filter({ has: page.getByRole("checkbox", { name, exact: true }) });
const addButton = (page: Page) =>
	screen(page).getByRole("button", { name: /^(Add \d+ projects?|Continue)$/ });

const fixtures = new WeakMap<
	Page,
	{
		projects: ProjectInfo[];
		rejected?: string;
		pause?: boolean;
		release?: () => void;
	}
>();

async function tap(page: Page, target: Locator): Promise<void> {
	await target.scrollIntoViewIfNeeded();
	const bounds = await target.boundingBox();
	if (!bounds) throw new Error("First-run control has no tap target");
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
}

export const firstRunProjectsHandlers: StepHandler[] = [
	{
		name: "seed first-run recent repositories",
		match: /^first-run project suggestions are available$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const fixture = { projects: [] as ProjectInfo[] };
			fixtures.set(world.page, fixture);
			// The page's Date is pinned, so ages are measured from the same instant.
			const now = PINNED_CLOCK_MS;
			const recent: FindFoldersResponse["entries"] = [
				["conduit", 2 * 60 * 60 * 1000],
				["api", 24 * 60 * 60 * 1000],
				["notes", 3 * 24 * 60 * 60 * 1000],
				["docs", 5 * 24 * 60 * 60 * 1000],
			].map(([name, age]) => ({
				path: pathFor(String(name)),
				reason: "recent",
				lastUsed: now - Number(age),
				isGitRepo: true,
				exists: true,
			}));
			rpc.setProjects({ projects: [] });
			rpc.setStubs({
				GetProjects: () => ({ projects: fixture.projects }),
				AttachProject: () => ({ projectSlug: null, sessionSlug: null }),
				FindFolders: ({ query }) => ({
					home,
					entries:
						query === ""
							? fixtures.get(world.page)?.rejected
								? recent.slice(0, 3)
								: recent
							: [
									{
										path: home,
										reason: "match" as const,
										isGitRepo: false,
										exists: true,
									},
									{
										path: pathFor("personal-site"),
										reason: "match" as const,
										isGitRepo: true,
										exists: true,
									},
								],
				}),
				SaveProject: async ({ folders, title }) => {
					const state = fixtures.get(world.page);
					if (!state) throw new Error("First-run fixture is absent");
					if (state.pause && state.projects.length === 1) {
						await new Promise<void>((resolve) => {
							state.release = resolve;
						});
					}
					const folder = folders[0];
					if (typeof folder !== "string")
						throw new Error("First run must save one existing folder");
					if (title === state.rejected)
						throw new ProjectSaveRejected({
							issues: [{ kind: "missing", path: folder }],
						});
					const slug = title ?? "new-project";
					state.projects.push({ slug, title: slug, folders: [folder] });
					const frame = { projects: [...state.projects], current: slug };
					rpc.setProjects(frame);
					return { ...frame, savedSlug: slug, warnings: [] };
				},
			});
		},
	},
	{
		name: "open app with zero projects",
		match: /^I open the app without projects$/,
		run: async ({ world }) => {
			await world.page.goto(new URL("/", world.page.url()).toString());
			await expect(screen(world.page)).toBeVisible();
			await expect(rows(world.page)).toHaveCount(
				fixtures.get(world.page)?.rejected ? 3 : 4,
			);
		},
	},
	{
		name: "assert first-run repository order",
		match: /^the first-run repositories are (.+) in that order$/,
		run: async ({ world, match }) => {
			const names = namesIn(match[1] ?? "");
			await expect(rows(world.page)).toHaveCount(names.length);
			for (const [index, name] of names.entries())
				await expect(rows(world.page).nth(index)).toHaveAttribute(
					"data-path",
					pathFor(name),
				);
		},
	},
	{
		name: "assert first-run repository metadata",
		match: /^the first-run ([a-z0-9-]+) repository shows "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(row(world.page, match[1] ?? "")).toContainText(
				match[2] ?? "",
			);
		},
	},
	{
		name: "assert first-run selected repositories",
		match: /^the first-run ticked repositories are (.+)$/,
		run: async ({ world, match }) => {
			const names = match[1] === "empty" ? [] : namesIn(match[1] ?? "");
			await expect(
				rows(world.page).getByRole("checkbox", { checked: true }),
			).toHaveCount(names.length);
			for (const name of names)
				await expect(row(world.page, name).getByRole("checkbox")).toBeChecked();
		},
	},
	{
		name: "assert first-run Add label and availability",
		match:
			/^the first-run Add button says "([^"]+)" and is (enabled|disabled)$/,
		run: async ({ world, match }) => {
			const button = addButton(world.page);
			await expect(button).toHaveText(match[1] ?? "");
			if (match[2] === "enabled") await expect(button).toBeEnabled();
			else await expect(button).toBeDisabled();
		},
	},
	{
		name: "toggle a first-run repository",
		match: /^I toggle the first-run ([a-z0-9-]+) repository$/,
		run: async ({ world, match }) => {
			await row(world.page, match[1] ?? "")
				.getByRole("checkbox")
				.click();
		},
	},
	{
		name: "add selected first-run projects",
		match: /^I (click|tap) the first-run Add button$/,
		run: async ({ world, match }) => {
			if (match[1] === "tap") await tap(world.page, addButton(world.page));
			else await addButton(world.page).click();
		},
	},
	{
		name: "hold the second first-run save",
		match: /^first-run project saves pause after the first project$/,
		run: ({ world }) => {
			const fixture = fixtures.get(world.page);
			if (!fixture) throw new Error("First-run fixture is absent");
			fixture.pause = true;
		},
	},
	{
		name: "assert first-run latch survives project publication",
		match: /^first run remains open while the remaining projects wait$/,
		run: async ({ world }) => {
			await expect.poll(() => fixtures.get(world.page)?.release).toBeTruthy();
			await expect(screen(world.page)).toBeVisible();
			await expect(rows(world.page)).toHaveCount(3);
			await expect(row(world.page, "conduit")).toHaveCount(0);
		},
	},
	{
		name: "release the remaining first-run saves",
		match: /^the remaining first-run project saves complete$/,
		run: ({ world }) => {
			const fixture = fixtures.get(world.page);
			if (!fixture?.release) throw new Error("No first-run save is waiting");
			fixture.pause = false;
			fixture.release();
		},
	},
	{
		name: "assert ordered first-run SaveProject calls",
		match: /^first-run projects were saved as (.+) in that order$/,
		run: async ({ world, match }) => {
			const expected = namesIn(match[1] ?? "").map((name) => ({
				title: name,
				folders: [pathFor(name)],
			}));
			await expect
				.poll(() =>
					requireRpcControl(world.page)
						.getRequests()
						.filter(({ tag }) => tag === "SaveProject")
						.map(({ payload }) => ({
							title: payload["title"],
							folders: payload["folders"],
						})),
				)
				.toEqual(expected);
		},
	},
	{
		name: "assert completed first-run shows the app",
		match: /^the normal app replaces first run$/,
		run: async ({ world }) => {
			await expect(screen(world.page)).toHaveCount(0);
			await expect(world.page.locator("#layout")).toBeVisible();
		},
	},
	{
		name: "publish an empty project list after first run",
		match: /^all first-run projects are removed later$/,
		run: ({ world }) => {
			const fixture = fixtures.get(world.page);
			if (!fixture) throw new Error("First-run fixture is absent");
			fixture.projects.length = 0;
			requireRpcControl(world.page).setProjects({ projects: [] });
		},
	},
	{
		name: "open inline first-run folder picker",
		match: /^I find another first-run folder$/,
		run: async ({ world }) => {
			await screen(world.page)
				.getByRole("button", {
					name: /Find (?:or browse for )?another folder…/,
				})
				.click();
		},
	},
	{
		name: "assert first-run browsing defaults and no creation",
		match:
			/^the first-run folder search starts at home without new-folder actions$/,
		run: async ({ world }) => {
			await expect(
				screen(world.page).getByRole("combobox", { name: "Add folder" }),
			).toHaveValue("~/");
			await expect(
				screen(world.page).getByRole("option", { name: /New folder/ }),
			).toHaveCount(0);
			await expect(world.page.getByRole("dialog")).toHaveCount(0);
		},
	},
	{
		name: "pick a folder into first-run selection",
		match: /^I pick personal-site for first run$/,
		run: async ({ world }) => {
			await screen(world.page)
				.locator(
					`[data-testid="folder-picker-row"][data-path="${pathFor("personal-site")}"]`,
				)
				.click();
		},
	},
	{
		name: "assert browsing has not saved first-run projects",
		match: /^no first-run project has been saved$/,
		run: ({ world }) => {
			expect(
				requireRpcControl(world.page)
					.getRequests()
					.filter(({ tag }) => tag === "SaveProject"),
			).toHaveLength(0);
		},
	},
	{
		name: "reject one first-run repository",
		match: /^saving the first-run api repository is rejected$/,
		run: ({ world }) => {
			const fixture = fixtures.get(world.page);
			if (!fixture) throw new Error("First-run fixture is absent");
			fixture.rejected = "api";
		},
	},
	{
		name: "assert first-run phone sizing and action placement",
		match: /^first-run phone rows and actions match the approved layout$/,
		run: async ({ world }) => {
			for (const item of await rows(world.page).all())
				await expect(item).toHaveCSS("height", "54px");
			const button = addButton(world.page);
			const browse = screen(world.page).getByRole("button", {
				name: "Find another folder…",
				exact: true,
			});
			const buttonBounds = await button.boundingBox();
			const listBounds = await screen(world.page)
				.getByTestId("first-run-repos")
				.boundingBox();
			const browseBounds = await browse.boundingBox();
			expect(buttonBounds).not.toBeNull();
			expect(listBounds).not.toBeNull();
			expect(browseBounds).not.toBeNull();
			expect(buttonBounds?.width).toBeCloseTo(listBounds?.width ?? 0, 0);
			expect(buttonBounds?.height).toBe(46);
			expect(browseBounds?.y).toBeGreaterThanOrEqual(
				(buttonBounds?.y ?? 0) + (buttonBounds?.height ?? 0),
			);
		},
	},
];
