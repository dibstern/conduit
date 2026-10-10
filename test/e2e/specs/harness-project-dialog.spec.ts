import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { Effect, Option, Stream } from "effect";
import type { ProcessHarness } from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

// Failure cases: a new folder must be created only on save, main promotion
// must persist its order and name, scope must survive reload, keyboard focus
// must remain usable, and a disk rejection must keep the draft for correction.
async function openDialog(
	page: Page,
	harness: ProcessHarness,
): Promise<Locator> {
	await new AppPage(page).goto(harness.baseUrl);
	await page.getByTestId("session-scope-chip").click();
	await page.getByRole("menuitem", { name: "Add a project…" }).click();
	const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function tabTo(page: Page, target: Locator): Promise<void> {
	for (let count = 0; count < 40; count++) {
		if (await target.evaluate((element) => document.activeElement === element))
			return;
		await page.keyboard.press("Tab");
	}
	await expect(target).toBeFocused();
}

test.afterEach(async ({ harness }, testInfo) => {
	writeFileSync(testInfo.outputPath("daemon.log"), harness.logTail);
});

test("reports provider folder and worktree capabilities through instance info", async ({
	harness,
}, testInfo) => {
	const browser = await harness.connect();
	const reported = await Effect.runPromise(browser.rpc.GetInstances({}));
	const subscribed = await Effect.runPromise(
		Stream.runHead(browser.rpc.SubscribeInstances({})),
	);
	if (Option.isNone(subscribed))
		throw new Error("No instance subscription snapshot");
	expect(subscribed.value.providerCapabilities).toEqual(
		reported.providerCapabilities,
	);
	const capabilities = Object.entries(reported.providerCapabilities ?? {})
		.map(([provider, capabilities]) => ({ provider, capabilities }))
		.sort((a, b) => a.provider.localeCompare(b.provider));
	// Normalised daemon output, without ephemeral ports, paths, IDs or timestamps.
	writeFileSync(
		testInfo.outputPath("provider-capabilities.json"),
		JSON.stringify(capabilities, null, 2),
	);
	expect(capabilities).toEqual([
		{
			provider: "claude",
			capabilities: { supportsMultiFolder: true, supportsWorktree: true },
		},
		{
			provider: "opencode",
			capabilities: { supportsMultiFolder: true, supportsWorktree: false },
		},
	]);
	for (const instance of reported.instances) {
		expect(instance.capabilities).toEqual(
			reported.providerCapabilities?.[instance.driver ?? "opencode"],
		);
	}
});

test("adds new and existing folders, promotes main, and reloads the persisted scope", async ({
	page,
	harness,
}, testInfo) => {
	const root = realpathSync(harness.root);
	const created = join(root, "new-notes");
	const existing = join(root, "existing-app");
	const matching = join(root, "new-notes-reference");
	mkdirSync(existing);
	mkdirSync(matching);
	const dialog = await openDialog(page, harness);
	const input = dialog.getByRole("combobox", { name: "Add folder" });
	await input.fill(created);
	await expect(
		dialog.getByRole("checkbox", { name: "git init" }),
	).toBeChecked();
	if (testInfo.project.name === "mobile") {
		// Model the visual viewport left above a phone's software keyboard.
		await page.evaluate(() => {
			const viewport = window.visualViewport;
			if (!viewport) throw new Error("Visual viewport is unavailable");
			Object.defineProperty(viewport, "height", {
				configurable: true,
				value: 440,
			});
			Object.defineProperty(viewport, "offsetTop", {
				configurable: true,
				value: 0,
			});
			viewport.dispatchEvent(new Event("resize"));
		});
		await expect
			.poll(async () => {
				const button = await dialog
					.getByRole("button", { name: /^Add project/ })
					.boundingBox();
				const option = await dialog
					.getByRole("option", { name: /New folder/ })
					.boundingBox();
				const match = await dialog
					.getByRole("option", { name: matching, exact: true })
					.boundingBox();
				return Boolean(
					button &&
						option &&
						match &&
						button.y + button.height <= 440 &&
						option.y + option.height <= 440 &&
						option.y >= 0 &&
						match.y + match.height <= 440 &&
						match.y >= 0,
				);
			})
			.toBe(true);
		await page.screenshot({
			path: testInfo.outputPath("keyboard-visible-matches.png"),
		});
		await page.evaluate(() => {
			const viewport = window.visualViewport;
			if (!viewport) return;
			Reflect.deleteProperty(viewport, "height");
			Reflect.deleteProperty(viewport, "offsetTop");
			viewport.dispatchEvent(new Event("resize"));
		});
	}
	await dialog.getByRole("option", { name: /New folder/ }).click();
	expect(existsSync(created)).toBe(false);
	await expect(dialog.getByLabel("Project name")).toHaveValue("new-notes");
	await input.fill(existing);
	await dialog.getByRole("option", { name: existing, exact: true }).click();
	await expect(dialog.getByTestId("project-provider-capabilities")).toHaveCount(
		0,
	);
	await expect(
		dialog.getByText("Folders · Sessions run in main and can edit all", {
			exact: true,
		}),
	).toBeVisible();
	await dialog.getByRole("button", { name: `Make main: ${existing}` }).click();
	await expect(dialog.getByLabel("Project name")).toHaveValue("existing-app");
	await expect(
		dialog.getByTestId("project-folder-row").first(),
	).toHaveAttribute("aria-label", `Main folder: ${existing}`);
	await dialog.getByLabel("Project name").fill("App and notes");
	await page.screenshot({
		path: testInfo.outputPath("add-project-dialog.png"),
	});
	await dialog.getByRole("button", { name: /^Add project/ }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId("session-scope-chip")).toHaveText(
		"App and notes",
	);
	const slug = new URL(page.url()).searchParams.get("p");
	expect(slug).toBe("existing-app");
	expect(existsSync(join(created, ".git"))).toBe(true);
	expect(existsSync(join(created, ".conduit"))).toBe(false);
	expect(existsSync(join(existing, ".conduit"))).toBe(false);
	await expect
		.poll(() => {
			const config: {
				projects: { slug: string; title?: string; folders: string[] }[];
			} = JSON.parse(
				readFileSync(join(harness.configDir, "daemon.json"), "utf8"),
			);
			return config.projects.find((project) => project.slug === slug);
		})
		.toMatchObject({ title: "App and notes", folders: [existing, created] });
	await page.reload();
	await expect(page.getByTestId("session-scope-chip")).toHaveText(
		"App and notes",
	);
	expect(new URL(page.url()).searchParams.get("p")).toBe(slug);
	const browser = await harness.connect();
	const persisted = await Effect.runPromise(browser.rpc.GetProjects({}));
	expect(persisted.projects).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				slug,
				title: "App and notes",
				folders: [existing, created],
			}),
		]),
	);
	writeFileSync(
		testInfo.outputPath("persisted-projects.json"),
		JSON.stringify(persisted, null, 2),
	);
	await page.screenshot({
		path: testInfo.outputPath("project-current-scope.png"),
	});
});

test("adds with the keyboard alone and cancels without creating a folder", async ({
	page,
	harness,
}, testInfo) => {
	const root = realpathSync(harness.root);
	const created = join(root, "keyboard-notes");
	const existing = join(root, "keyboard-app");
	mkdirSync(existing);
	await new AppPage(page).goto(harness.baseUrl);
	await tabTo(page, page.getByTestId("session-scope-chip"));
	await page.keyboard.press("Enter");
	// The project list can re-render the open menu and drop the highlight.
	const addProject = page.getByRole("menuitem", { name: "Add a project…" });
	await expect(async () => {
		await page.keyboard.press("End");
		await expect(addProject).toHaveAttribute("data-highlighted", "", {
			timeout: 500,
		});
	}).toPass();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
	await expect(dialog).toBeVisible();
	const input = dialog.getByRole("combobox");
	await expect(input).toBeFocused();
	await page.keyboard.type(created);
	await expect(
		dialog.getByRole("option", { name: /New folder/ }),
	).toBeVisible();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(dialog.getByTestId("project-folder-row")).toHaveCount(1);
	await page.keyboard.type(existing);
	await expect(
		dialog.getByRole("option", { name: existing, exact: true }),
	).toBeVisible();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("Enter");
	await tabTo(
		page,
		dialog.getByRole("button", { name: `Make main: ${existing}` }),
	);
	await page.keyboard.press("Enter");
	await expect(dialog.getByLabel("Project name")).toHaveValue("keyboard-app");
	await page.screenshot({
		path: testInfo.outputPath("keyboard-project-dialog.png"),
	});
	await page.keyboard.press("Control+Enter");
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId("session-scope-chip")).toHaveText(
		"keyboard-app",
	);
	expect(existsSync(join(created, ".git"))).toBe(true);
	await page.reload();
	// The new project's relay needs a few seconds; keys sent while the page
	// is still reconnecting are lost.
	await page
		.locator("#connect-overlay")
		.waitFor({ state: "detached", timeout: 30_000 });
	// Adding opened a draft; on a phone the list is behind it.
	const back = page.getByTestId("session-bar-back");
	if (await back.isVisible()) await back.click();
	await expect(page.getByTestId("session-scope-chip")).toHaveText(
		"keyboard-app",
	);
	await tabTo(page, page.getByTestId("session-scope-chip"));
	await page.keyboard.press("Enter");
	await expect(async () => {
		await page.keyboard.press("End");
		await expect(addProject).toHaveAttribute("data-highlighted", "", {
			timeout: 500,
		});
	}).toPass();
	await page.keyboard.press("Enter");
	await expect(dialog).toBeVisible();
	await expect(input).toBeFocused();
	const cancelled = join(root, "cancelled-folder");
	await page.keyboard.type(cancelled);
	await expect(
		dialog.getByRole("option", { name: /New folder/ }),
	).toBeVisible();
	await page.keyboard.press("Enter");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	expect(existsSync(cancelled)).toBe(false);
	await page.screenshot({
		path: testInfo.outputPath("keyboard-current-scope.png"),
	});
});

test("keeps a failed creation inline and the draft correctable", async ({
	page,
	harness,
}, testInfo) => {
	const root = realpathSync(harness.root);
	const missingParent = join(root, "missing-parent", "notes");
	const dialog = await openDialog(page, harness);
	await dialog.getByRole("combobox").fill(missingParent);
	await dialog.getByRole("option", { name: /New folder/ }).click();
	await dialog.getByRole("button", { name: /^Add project/ }).click();
	await expect(dialog.getByRole("alert")).toContainText(missingParent);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel("Project name")).toHaveValue("notes");
	expect(existsSync(missingParent)).toBe(false);
	await page.screenshot({
		path: testInfo.outputPath("project-save-error.png"),
	});
	mkdirSync(join(root, "missing-parent"));
	await dialog.getByRole("button", { name: /^Add project/ }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId("session-scope-chip")).toHaveText("notes");
});

// Failure cases: suggestions could leak a missing recent folder, list a plain
// or hidden sibling, mislabel git, repeat a folder found both ways, ignore the
// text filter, or break path autocomplete; the dialog could hide them or fail
// to add a picked one.
function seedSuggestions(harness: ProcessHarness) {
	const elsewhere = join(harness.root, "elsewhere");
	const folder = (path: string, git: boolean) => {
		mkdirSync(git ? join(path, ".git") : path, { recursive: true });
		return path;
	};
	const recentRepo = folder(join(elsewhere, "Alpha-recent"), true);
	const recentPlain = folder(join(elsewhere, "beta-recent"), false);
	const both = folder(join(harness.root, "alpha-both"), true);
	const sibling = folder(join(harness.root, "alpha-sibling"), true);
	folder(join(harness.root, "alpha-plain"), false);
	folder(join(harness.root, ".alpha-hidden"), true);
	writeFileSync(
		join(harness.configDir, "recent.json"),
		JSON.stringify({
			recentProjects: [
				{ directory: recentRepo, slug: "alpha-recent", lastUsed: 4 },
				{ directory: recentPlain, slug: "beta-recent", lastUsed: 3 },
				{ directory: join(elsewhere, "alpha-gone"), slug: "gone", lastUsed: 2 },
				{ directory: both, slug: "alpha-both", lastUsed: 1 },
			],
		}),
	);
	return { recentRepo, recentPlain, both, sibling };
}

test("FindFolders suggests recent and sibling folders for text and matches paths", async ({
	harness,
}, testInfo) => {
	const { recentRepo, recentPlain, both, sibling } = seedSuggestions(harness);
	const browser = await harness.connect();
	const find = (query: string) =>
		Effect.runPromise(browser.rpc.FindFolders({ query }));
	const all = await find("");
	expect(all.entries).toEqual([
		{ path: recentRepo, isGitRepo: true, reason: "recent", exists: true },
		{ path: recentPlain, isGitRepo: false, reason: "recent", exists: true },
		{ path: both, isGitRepo: true, reason: "recent", exists: true },
		{ path: sibling, isGitRepo: true, reason: "sibling", exists: true },
	]);
	const alpha = await find("ALPHA");
	expect(alpha.entries.map((entry) => [entry.path, entry.reason])).toEqual([
		[recentRepo, "recent"],
		[both, "recent"],
		[sibling, "sibling"],
	]);
	const beta = await find(" beta ");
	expect(beta.entries).toEqual([
		{ path: recentPlain, isGitRepo: false, reason: "recent", exists: true },
	]);
	expect((await find("nothing-matches")).entries).toEqual([]);
	const path = await find(join(harness.root, "alpha-"));
	expect(path.entries).toEqual([
		{ path: both, isGitRepo: true, reason: "match", exists: true },
		{
			path: join(harness.root, "alpha-plain"),
			isGitRepo: false,
			reason: "match",
			exists: true,
		},
		{ path: sibling, isGitRepo: true, reason: "match", exists: true },
		{
			path: join(harness.root, "alpha-"),
			isGitRepo: false,
			reason: "match",
			exists: false,
		},
	]);
	// Removing a project is what makes its folders "recent", main first.
	const gamma = ["gamma-main", "gamma-extra"].map((name) => {
		mkdirSync(join(harness.root, "elsewhere", name));
		return realpathSync(join(harness.root, "elsewhere", name));
	});
	const saved = await Effect.runPromise(
		browser.rpc.SaveProject({ title: "Gamma", folders: gamma }),
	);
	const slug = saved.savedSlug;
	if (!slug) throw new Error("SaveProject did not return the new slug");
	expect((await find("gamma")).entries).toEqual([]);
	await Effect.runPromise(browser.rpc.RemoveProject({ slug }));
	const removed = await find("gamma");
	expect(removed.entries).toEqual(
		gamma.map((folder) => ({
			path: folder,
			isGitRepo: false,
			reason: "recent",
			exists: true,
		})),
	);
	writeFileSync(
		testInfo.outputPath("find-folders.json"),
		JSON.stringify({ all, alpha, beta, path, removed }, null, 2),
	);
});

test("opening the dialog shows suggestions and clicking one adds a folder row", async ({
	page,
	harness,
}, testInfo) => {
	const { recentRepo, recentPlain, sibling } = seedSuggestions(harness);
	const dialog = await openDialog(page, harness);
	const suggestions = dialog.getByRole("group", { name: "Suggestions" });
	const option = (path: string) =>
		suggestions.getByRole("option", { name: path, exact: true });
	await expect(option(recentRepo)).toContainText("recent · git");
	await expect(option(recentPlain)).toContainText("recent");
	await expect(option(sibling)).toContainText("git");
	await expect(suggestions.getByRole("option")).toHaveCount(4);
	await page.screenshot({ path: testInfo.outputPath("suggestions-open.png") });
	await option(sibling).click();
	await expect(dialog.getByTestId("project-folder-row")).toHaveAttribute(
		"aria-label",
		`Main folder: ${sibling}`,
	);
	await expect(dialog.getByLabel("Project name")).toHaveValue("alpha-sibling");
	await expect(option(sibling)).toHaveCount(0);
	await dialog.getByRole("combobox", { name: "Add folder" }).fill("beta");
	await expect(suggestions.getByRole("option")).toHaveCount(1);
	await expect(option(recentPlain)).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("suggestion-added.png"),
	});
});
