import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test as base, expect } from "@playwright/test";

import { ProcessHarness } from "../../helpers/process-harness.js";
import { AppPage } from "../page-objects/app.page.js";

const test = base.extend<{ harness: ProcessHarness }>({
	harness: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
		async ({}, use, testInfo) => {
			const harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			});
			try {
				await harness.restart({ startupTimeoutMs: 60_000 });
				await harness.requestRpc({
					_tag: "RemoveProject",
					slug: "process-test",
				});
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

test.setTimeout(180_000);
test.use({ actionTimeout: 30_000 });

if (process.env["CONDUIT_E2E_SINGLE_PROCESS"] === "1") {
	test.use({
		launchOptions: { args: ["--single-process", "--in-process-gpu"] },
	});
}

test("OpenCode instances can be added, edited and removed with no project open", async ({
	page,
	harness,
}, testInfo) => {
	expect((await harness.requestRpc({ _tag: "GetProjects" })).projects).toEqual(
		[],
	);
	// The harness seeds a default OpenCode instance; the empty state needs none.
	for (const instance of (await harness.requestRpc({ _tag: "GetInstances" }))
		.instances)
		if (instance.driver !== "claude")
			await harness.requestRpc({
				_tag: "RemoveInstance",
				instanceId: instance.id,
			});
	const proxy = await harness.requestRpc({ _tag: "DetectProxy" });
	await new AppPage(page).goto(harness.baseUrl);
	const listSettings = page.getByTestId("list-bar-settings");
	const sessionOverflow = page
		.getByTestId("session-bar-overflow")
		.or(page.getByTestId("session-bar-island-overflow"));
	await expect(listSettings.or(sessionOverflow).first()).toBeVisible();
	if (await listSettings.isVisible()) {
		await listSettings.click();
	} else {
		await sessionOverflow.click();
		await page.getByTestId("overflow-settings").click();
	}
	await page.getByTestId("settings-tab-server").click();
	const instances = page.locator("#instances-settings");
	const empty = page.getByTestId("opencode-empty-state");
	await expect(empty).toBeVisible();
	await expect(empty).toContainText("No OpenCode servers yet.");
	await expect(empty).toContainText("opencode serve --port 4098");
	await expect(empty.getByTestId("scan-now-link")).toBeVisible();
	const guides = empty.getByTestId("opencode-setup-guides");
	await expect(guides.getByRole("button").first()).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	await expect(guides).not.toContainText("detecting...");
	if (proxy.found) await expect(guides).toContainText("CCS ✓");
	await guides.getByRole("button").first().click();
	for (const name of ["Direct key", "CCS", "Custom"]) {
		await expect(
			guides.getByRole("button", { name: new RegExp(`^${name}`) }),
		).toHaveAttribute("aria-expanded", "false");
	}
	await guides.getByRole("button", { name: "Direct key", exact: true }).click();
	await expect(
		guides.getByRole("button", { name: "Copy", exact: true }),
	).toHaveCount(2);
	await guides.getByRole("button").first().click();

	const artifacts = resolve("test-results/settings-opencode-instances");
	mkdirSync(artifacts, { recursive: true });
	await instances.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: resolve(artifacts, `${testInfo.project.name}-empty.png`),
	});
	await page.getByTestId("add-instance-btn").click();
	await expect(page.getByTestId("instance-form-name")).toBeFocused();
	await page.getByTestId("instance-form-driver-opencode").click();
	await expect(page.getByTestId("instance-form-managed")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(page.getByTestId("instance-form-env")).toBeHidden();
	await page.getByTestId("instance-form-managed").click();
	await page.getByTestId("instance-form-name").fill("Staging OC");
	await page.getByTestId("instance-form-url").fill(harness.baseUrl);
	await page.getByTestId("instance-form-save").click();
	await expect(page.getByTestId("instance-form")).toBeHidden();
	const row = instances
		.locator('[data-driver="opencode"]')
		.filter({ hasText: "Staging OC" });
	await expect(row).toBeVisible();
	await row.getByRole("button", { name: /Staging OC/ }).click();
	await expect(row).toContainText("discovered");
	await expect(row).toContainText(`:${new URL(harness.baseUrl).port}`);
	await expect(row.getByText("Address", { exact: true })).toBeVisible();
	await expect(row.getByText(harness.baseUrl, { exact: true })).toBeVisible();
	await expect(
		row.getByText("You (found by scan)", { exact: true }),
	).toBeVisible();
	await expect(
		row.getByRole("button", { name: /^(Start|Stop|Rename)$/ }),
	).toHaveCount(0);
	await row.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: resolve(artifacts, `${testInfo.project.name}-added.png`),
	});
	await row.getByTestId("edit-instance-btn").click();
	await expect(page.getByTestId("instance-form-name")).toBeFocused();
	await expect(page.getByTestId("instance-form-url")).toHaveValue(
		harness.baseUrl,
	);
	await expect(page.getByTestId("instance-form-driver-opencode")).toHaveCount(
		0,
	);
	await page.getByTestId("instance-form-name").fill("Prod OC");
	await page.getByTestId("instance-form-save").click();
	await expect(page.getByTestId("instance-form")).toBeHidden();
	const edited = instances
		.locator('[data-driver="opencode"]')
		.filter({ hasText: "Prod OC" });
	await expect(edited).toBeVisible();
	await expect(row).toHaveCount(0);
	await edited.getByRole("button", { name: /Prod OC/ }).click();
	await edited.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: resolve(artifacts, `${testInfo.project.name}-edited.png`),
	});
	await edited.getByTestId("remove-instance-btn").click();
	await expect(page.locator("#confirm-modal")).toContainText(
		'Remove instance "Prod OC"? This cannot be undone.',
	);
	await page.getByTestId("confirm-modal-action").click();
	await expect(edited).toHaveCount(0);
	await expect(empty).toBeVisible();
	await instances.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: resolve(artifacts, `${testInfo.project.name}-removed.png`),
	});
	expect((await harness.requestRpc({ _tag: "GetProjects" })).projects).toEqual(
		[],
	);
});
