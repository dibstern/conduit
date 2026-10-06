import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

// Failure cases: saving a new project must show no error; a draft must
// prefill the project this device last created a session in, never the one
// the open session or the list scope belongs to; and that memory must survive
// a reload.
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

test("a draft prefills the project the last new session was created in", async ({
	page,
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
	const original = (await draftChip.textContent())?.trim() ?? "";
	await createSession(page, app);

	await toList(page);
	await page.getByTestId("session-scope-chip").click();
	await page.getByRole("menuitem", { name: "Add a project…" }).click();
	const dialog = page.getByRole("dialog", { name: "Add project", exact: true });
	await dialog.getByRole("combobox", { name: "Add folder" }).fill(folder);
	await dialog.getByRole("option", { name: folder, exact: true }).click();
	await dialog.getByRole("button", { name: /^Add project/ }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId("session-scope-chip")).toHaveText("t3code");
	await page.waitForTimeout(1500);
	await page.screenshot({ path: testInfo.outputPath("after-save.png") });
	await expect(page.getByRole("alert")).toHaveCount(0);

	// Scoped to t3code, but the last session was created in the original.
	await newSession(page);
	await expect(draftChip).toHaveText(original);
	await page.screenshot({ path: testInfo.outputPath("prefill-original.png") });

	await app.chooseDraftProject("t3code");
	await createSession(page, app);

	await newSession(page);
	await expect(draftChip).toHaveText(/t3code\s*$/);
	await page.reload();
	await expect(draftChip).toHaveText(/t3code\s*$/);
	await page.screenshot({ path: testInfo.outputPath("prefill-t3code.png") });
	writeFileSync(testInfo.outputPath("console-errors.txt"), errors.join("\n"));
	expect(errors).toEqual([]);
});
