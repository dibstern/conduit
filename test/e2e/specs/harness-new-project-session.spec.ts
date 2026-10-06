import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

// Failure cases: saving a new project must show no error, and New session
// right after must draft into that project, not the one the tab started in.
test.afterEach(async ({ harness }, testInfo) => {
	writeFileSync(testInfo.outputPath("daemon.log"), harness.logTail);
});

test.use({ harnessOptions: { opencodeRecording: "chat-simple" } });

test("a just-added project is where New session drafts, with no error", async ({
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
	await app.goto(harness.baseUrl);
	// Start inside a session of the original project, as the report did.
	await page.locator("#new-session-btn:visible").click();
	await app.sendMessage("Hello, reply with just the word pong");
	await expect(page).toHaveURL(/\/s\/[^/?]+/);
	await expect(page.locator(".md-content").last()).toContainText("done(");
	const back = page.getByTestId("session-bar-back");
	if (await back.isVisible()) await back.click();
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
	writeFileSync(testInfo.outputPath("console-errors.txt"), errors.join("\n"));
	await expect(page.getByRole("alert")).toHaveCount(0);
	expect(errors).toEqual([]);

	await page.locator("#new-session-btn:visible").click();
	await expect(page).toHaveURL(/\/new\?/);
	await page.screenshot({ path: testInfo.outputPath("new-session.png") });
	expect(new URL(page.url()).searchParams.get("project")).toBe("t3code");
});
