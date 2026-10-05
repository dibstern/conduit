import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { Effect } from "effect";
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
	await expect(page.getByTestId("sidebar-projects-panel")).toBeHidden();
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
