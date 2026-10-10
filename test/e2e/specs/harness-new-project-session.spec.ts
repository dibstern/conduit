import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

// Failure cases: saving a new project must show no error and must open a
// draft prefilled with it; a draft must prefill the project last added or given
// a session, never the one the open session or the list scope belongs to; and
// that memory lives on the daemon, so every client and a reload see it.
test.afterEach(async ({ harness }, testInfo) => {
	writeFileSync(testInfo.outputPath("daemon.log"), harness.logTail);
});

test.use({ harnessOptions: { opencodeRecording: "chat-simple" } });

async function createSession(page: Page, app: AppPage): Promise<void> {
	await app.sendMessage("Hello, reply with just the word pong");
	await expect(page).toHaveURL(/\/s\/[^/?]+/);
	await expect(page.locator(".md-content").last()).toContainText(/pong|done\(/);
}

async function toList(page: Page): Promise<void> {
	const back = page.getByTestId("session-bar-back");
	if (await back.isVisible()) await back.click();
}

async function newSession(page: Page): Promise<void> {
	await toList(page);
	await page.locator("#new-session-btn:visible").click();
	await expect(page).toHaveURL(/\/new(\?|$)/);
}

test("a draft prefills the project last added or given a session, on every client", async ({
	page,
	browser,
	harness,
}, testInfo) => {
	const folder = join(realpathSync(harness.root), "t3code");
	mkdirSync(folder);
	const errors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	const app = new AppPage(page);
	const draftChip = page.getByTestId("draft-project-chip");
	await app.goto(harness.baseUrl);
	await newSession(page);
	await expect(draftChip).not.toHaveText("Choose a project");
	const original =
		(await draftChip.locator(".truncate").textContent())?.trim() ?? "";
	await createSession(page, app);

	await toList(page);
	await page.getByTestId("session-scope-chip").click();
	await page.getByRole("menuitem", { name: "Add a project…" }).click();
	const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
	await dialog.getByRole("combobox", { name: "Add folder" }).fill(folder);
	await dialog.getByRole("option", { name: folder, exact: true }).click();
	await dialog.getByRole("button", { name: /^Add project/ }).click();
	await expect(dialog).toBeHidden();
	await expect(page).toHaveURL(/\/new\?/);
	await expect(draftChip).toHaveText(/t3code\s*$/);
	await expect(page.getByTestId("session-scope-chip")).toHaveText("t3code");
	await page.waitForTimeout(1500);
	await page.screenshot({ path: testInfo.outputPath("after-add.png") });
	await expect(page.getByRole("alert")).toHaveCount(0);

	// A separate browser shares no storage, so only the daemon can tell it
	// that t3code was just added.
	const other = await browser.newContext({
		viewport: page.viewportSize(),
		hasTouch: testInfo.project.use.hasTouch ?? false,
	});
	const otherPage = await other.newPage();
	const otherApp = new AppPage(otherPage);
	const otherChip = otherPage.getByTestId("draft-project-chip");
	await otherApp.goto(harness.baseUrl);
	await newSession(otherPage);
	await expect(otherChip).toHaveText(/t3code\s*$/);
	await otherPage.screenshot({
		path: testInfo.outputPath("other-client-prefill-t3code.png"),
	});

	await otherApp.chooseDraftProject(original);
	await createSession(otherPage, otherApp);
	await other.close();

	await app.goto(harness.baseUrl);
	await newSession(page);
	await expect(draftChip).toContainText(original);
	await page.reload();
	await expect(draftChip).toContainText(original);
	await page.screenshot({
		path: testInfo.outputPath("prefill-original-from-other-client.png"),
	});
	writeFileSync(testInfo.outputPath("console-errors.txt"), errors.join("\n"));
	expect(errors).toEqual([]);
});
