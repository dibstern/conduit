// New session is a draft (design 2, t3code-inspired): + opens an empty
// composer with a project chip and a "where it starts" chip, and nothing is
// created until the first send. Screenshots of each state are attached to the
// report and written to the test output dir as the repeatable artifact.

import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { SidebarPage } from "../page-objects/sidebar.page.js";

test.use({ recording: "chat-simple" });

async function capture(page: Page, testInfo: TestInfo, name: string) {
	const path = testInfo.outputPath(`${name}.png`);
	await page.screenshot({ path });
	await testInfo.attach(name, { path, contentType: "image/png" });
}

async function openDraft(page: Page, relayUrl: string) {
	const app = new AppPage(page);
	const sidebar = new SidebarPage(page);
	await app.goto(relayUrl);
	await sidebar.waitForSessions();
	const countBefore = await sidebar.getSessionCount();
	await sidebar.newSessionBtn.click();
	await expect(page).toHaveURL(/\/new\?(?:.*&)?project=[^&]+/);
	return { app, sidebar, countBefore };
}

test.describe("New session draft", () => {
	test("+ opens an empty draft and creates nothing", async ({
		page,
		relayUrl,
	}, testInfo) => {
		const { app, sidebar, countBefore } = await openDraft(page, relayUrl);

		await expect(app.input).toBeFocused();
		await expect(page.getByTestId("draft-project-chip")).toBeVisible();
		await expect(page.getByTestId("draft-project-chip")).not.toBeEmpty();
		await expect(page.getByTestId("draft-start-chip")).toBeVisible();
		await capture(page, testInfo, "desktop-draft");

		// Give a would-be eager create time to land, then prove it did not.
		await page.waitForTimeout(1_000);
		expect(await sidebar.getSessionCount()).toBe(countBefore);
	});

	test("first send creates the session and opens it", async ({
		page,
		relayUrl,
	}) => {
		const { app, sidebar, countBefore } = await openDraft(page, relayUrl);

		await app.input.fill("Hello from a draft");
		await app.sendBtn.click();

		await expect(page).toHaveURL(/\/s\/[^/?]+(?:\?.*)?$/);
		await expect
			.poll(() => sidebar.getSessionCount(), { timeout: 10_000 })
			.toBeGreaterThan(countBefore);
	});

	test("start chip shows the current checkout; worktrees come later", async ({
		page,
		relayUrl,
	}, testInfo) => {
		await openDraft(page, relayUrl);

		await page.getByTestId("draft-start-chip").click();
		await expect(
			page.getByRole("menuitemradio", { name: /Current checkout/ }),
		).toHaveAttribute("aria-checked", "true");
		await expect(
			page.getByRole("menuitem", { name: /New worktree/ }),
		).toHaveAttribute("aria-disabled", "true");
		await capture(page, testInfo, "desktop-start-menu");
	});

	test("project chip lists projects and keeps the typed prompt", async ({
		page,
		relayUrl,
	}, testInfo) => {
		const { app } = await openDraft(page, relayUrl);
		await app.input.fill("Keep me");

		await page.getByTestId("draft-project-chip").click();
		const projects = page.getByRole("menuitemradio");
		await expect(projects.first()).toBeVisible();
		await expect(projects.first()).toHaveAttribute("aria-checked", "true");
		await capture(page, testInfo, "desktop-project-menu");
		await projects.first().click();

		await expect(app.input).toHaveValue("Keep me");
	});

	test("a reload keeps the half-typed prompt", async ({ page, relayUrl }) => {
		const { app } = await openDraft(page, relayUrl);
		await app.input.fill("Survive a reload");
		await page.waitForTimeout(500);

		await page.reload();

		await expect(page).toHaveURL(/\/new\?(?:.*&)?project=/);
		await expect(app.input).toHaveValue("Survive a reload");
	});

	test.describe("phone", () => {
		test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

		test("+ opens the draft full screen, not the list", async ({
			page,
			relayUrl,
		}, testInfo) => {
			const app = new AppPage(page);
			const sidebar = new SidebarPage(page);
			await app.goto(relayUrl);
			// The harness lands in a session; a phone shows the list only after back.
			await app.sessionBarBack.click();
			await sidebar.waitForSessions();
			await sidebar.newSessionBtn.click();
			await expect(page).toHaveURL(/\/new\?(?:.*&)?project=[^&]+/);

			await expect(app.input).toBeVisible();
			await expect(page.getByTestId("draft-project-chip")).toBeVisible();
			await expect(page.locator("#session-list")).toBeHidden();
			await capture(page, testInfo, "phone-draft");
		});
	});
});
