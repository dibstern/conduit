// Failure cases: isolated HOME discovery, activity ordering, default-project exclusion,
// first-run latch surviving the first save, batch creation, and daemon folder persistence.
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { ProcessHarness } from "../../helpers/process-harness.js";

const test = base.extend<{ harness: ProcessHarness }>({
	harness: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument.
		async ({}, use, testInfo) => {
			const harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			});
			try {
				await harness.restart({ startupTimeoutMs: 60_000 });
				await use(harness);
			} finally {
				writeFileSync(testInfo.outputPath("daemon.log"), harness.logTail);
				await harness.dispose();
				harness.assertNoRunners();
			}
		},
		{ timeout: 120_000 },
	],
});

test.setTimeout(120_000);
test.use({ actionTimeout: 30_000 });

if (process.env["CONDUIT_E2E_SINGLE_PROCESS"] === "1") {
	test.use({
		launchOptions: { args: ["--single-process", "--in-process-gpu"] },
	});
}

test("first run discovers local git activity and adds each repository as a project", async ({
	page,
	harness,
}, testInfo) => {
	const home = join(harness.root, "home");
	const now = Date.now();
	const folders = ["newest-repo", "older-repo"].map((name, index) => {
		const folder = join(home, "src", name);
		mkdirSync(folder, { recursive: true });
		execFileSync("git", ["init", "--quiet", "--initial-branch=main", folder]);
		const head = join(folder, ".git", "HEAD");
		const indexFile = join(folder, ".git", "index");
		writeFileSync(indexFile, "");
		const headTime = new Date(now - 4 * 24 * 60 * 60 * 1000);
		const indexTime = new Date(now - (index + 1) * 60 * 60 * 1000);
		utimesSync(head, headTime, headTime);
		utimesSync(indexFile, indexTime, indexTime);
		return folder;
	});
	// The harness startup probe registers this project outside isolated HOME.
	const removed = await harness.requestRpc({
		_tag: "RemoveProject",
		slug: "process-test",
	});
	expect(removed.projects).toEqual([]);
	await page.goto(harness.baseUrl);
	const firstRun = page.getByTestId("first-run-projects");
	const rows = firstRun.getByTestId("first-run-repo");
	await expect(firstRun).toBeVisible();
	await expect(rows).toHaveCount(2);
	for (const [index, folder] of folders.entries()) {
		await expect(rows.nth(index)).toHaveAttribute("data-path", folder);
		await expect(rows.nth(index).getByRole("checkbox")).toBeChecked();
	}
	await firstRun
		.getByRole("button", { name: "Add 2 projects", exact: true })
		.click();
	await expect(firstRun).toHaveCount(0);
	await expect(page.locator("#layout")).toBeVisible();
	await expect
		.poll(async () => {
			const result = await harness.requestRpc({ _tag: "GetProjects" });
			return result.projects.map((project) => [...project.folders]).sort();
		})
		.toEqual(folders.map((folder) => [folder]).sort());
	const projects = await harness.requestRpc({ _tag: "GetProjects" });
	expect(projects.projects).toHaveLength(2);
	writeFileSync(
		testInfo.outputPath("first-run-projects.json"),
		JSON.stringify({ home, expectedFolders: folders, projects }, null, 2),
	);
});
