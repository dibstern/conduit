import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { claudeModels, pickClaudeModel } from "../helpers/draft-model.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

// No-project sessions (m379.10). Failure cases: two sessions writing the same
// file name share a folder; a draft switched to No project and back loses its
// text or lands in the wrong project; the sidebar shows no "No project" group;
// delete removes the folder without asking, or Keep removes it anyway.
test.use({ harnessOptions: { capabilityModels: claudeModels } });

test.afterEach(async ({ harness }, testInfo) => {
	writeFileSync(testInfo.outputPath("daemon.log"), harness.logTail);
});

async function newDraft(page: Page): Promise<void> {
	const back = page.getByTestId("session-bar-back");
	if (await back.isVisible()) await back.click();
	await page.locator("#new-session-btn:visible").click();
	await expect(page).toHaveURL(/\/draft\/[^/?]+(\?|$)/);
}

const sessionIdOf = (page: Page) =>
	new URL(page.url()).pathname.split("/")[2] ?? "";

test("No-project sessions get their own folders, a draft moves to a real project, and delete asks keep or remove", async ({
	page,
	harness,
}, testInfo) => {
	const app = new AppPage(page);
	const phone = await app.isMobileViewport();
	const chip = page.getByTestId("draft-project-chip");
	const scratchRoot = join(realpathSync(harness.configDir), "scratch");
	const shot = (name: string) =>
		page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
	const listing = (folder: string) =>
		Object.fromEntries(
			readdirSync(folder).map((name) => [
				name,
				readFileSync(join(folder, name), "utf8"),
			]),
		);

	await app.goto(harness.baseUrl);
	await newDraft(page);
	await expect(chip).not.toHaveText("Choose a project");
	const original =
		(await chip.locator(".truncate").textContent())?.trim() ?? "";
	const originalSlug = new URL(page.url()).searchParams.get("project");
	expect(originalSlug).toBeTruthy();

	// A draft keeps its text as it moves to No project and back to a real one.
	await app.input.fill("workspace-isolation-write real");
	await app.chooseDraftProject("No project");
	await expect(page).toHaveURL(/[?&]project=_scratch(&|$)/);
	await expect(page.getByTestId("draft-scratch-folder")).toBeVisible();
	await expect(page.getByTestId("draft-start-chip")).toHaveCount(0);
	await expect(app.input).toHaveValue("workspace-isolation-write real");
	await shot("1-draft-in-no-project");
	await app.chooseDraftProject(original);
	await expect
		.poll(() => new URL(page.url()).searchParams.get("project"))
		.toBe(originalSlug);
	await expect(page.getByTestId("draft-start-chip")).toBeVisible();
	await expect(app.input).toHaveValue("workspace-isolation-write real");
	await pickClaudeModel(page);
	await app.sendBtn.click();
	await expect(page).toHaveURL(/\/s\/[^/?]+/);
	await expect
		.poll(() => existsSync(join(harness.projectDir, "session-only.txt")))
		.toBe(true);
	expect(readdirSync(scratchRoot)).toEqual([]);
	await shot("2-draft-switched-to-real-project");

	// Two No-project sessions write the same file name, each in its own folder.
	const sessions: Record<string, string> = {};
	for (const label of ["alpha", "beta"]) {
		await newDraft(page);
		await app.chooseDraftProject("No project");
		await pickClaudeModel(page);
		await app.sendMessage(`workspace-isolation-write ${label}`);
		await expect(page).toHaveURL(/\/s\/[^/?]+/);
		const id = sessionIdOf(page);
		sessions[label] = id;
		await expect
			.poll(() => existsSync(join(scratchRoot, id, "session-only.txt")))
			.toBe(true);
	}
	const alpha = join(scratchRoot, sessions["alpha"] ?? "");
	const beta = join(scratchRoot, sessions["beta"] ?? "");
	const folders = { alpha: listing(alpha), beta: listing(beta) };
	expect(folders).toEqual({
		alpha: { "session-only.txt": "workspace-isolation-write alpha" },
		beta: { "session-only.txt": "workspace-isolation-write beta" },
	});
	writeFileSync(
		testInfo.outputPath("scratch-folders.json"),
		`${JSON.stringify(
			{
				scratchRoot: readdirSync(scratchRoot)
					.map((name) => (name === sessions["alpha"] ? "<alpha>" : "<beta>"))
					.sort(),
				...folders,
			},
			null,
			2,
		)}\n`,
	);

	// The sidebar groups them under "No project".
	await app.goto(`${harness.baseUrl}/?group=project`);
	const group = page.locator(
		'[data-testid="project-tree-header"][data-project="_scratch"]',
	);
	await expect(group.getByTestId("project-tree-title")).toHaveText(
		"No project",
	);
	await expect(
		page.locator('[id="project-tree-rows-_scratch"] [data-session-id]'),
	).toHaveCount(2);
	await shot("3-sidebar-no-project-group");

	// Delete asks keep or remove; a folder with files defaults to Keep.
	const openDelete = async (id: string) => {
		const row = page.locator(`#session-list [data-session-id="${id}"]`);
		if (phone) {
			await page.getByTestId("list-bar-select").click();
			await row.getByRole("checkbox").click();
			await page.getByTestId("select-bar-delete").click();
		} else {
			await row.click({ button: "right" });
			await page.getByTestId("session-ctx-delete").click();
		}
		const prompt = page.locator("#confirm-modal");
		await expect(prompt).toBeVisible();
		return prompt;
	};
	const keep = await openDelete(sessions["alpha"] ?? "");
	await expect(keep).toContainText(alpha);
	await expect(
		keep.getByRole("radio", { name: "Keep worktrees", exact: true }),
	).toBeChecked();
	await shot("4-delete-asks-keep-or-remove");
	await page.getByTestId("confirm-modal-action").click();
	await expect(
		page.locator(`#session-list [data-session-id="${sessions["alpha"]}"]`),
	).toHaveCount(0);
	expect(listing(alpha)).toEqual(folders.alpha);

	const remove = await openDelete(sessions["beta"] ?? "");
	await remove
		.getByRole("radio", { name: "Remove worktrees", exact: true })
		.click();
	await page.getByTestId("confirm-modal-action").click();
	await expect.poll(() => existsSync(beta)).toBe(false);
	expect(existsSync(alpha)).toBe(true);
	await shot("5-after-keep-and-remove");
});
