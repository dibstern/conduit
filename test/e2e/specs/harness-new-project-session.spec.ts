import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { find } from "../helpers/detail-wire.js";
import { openPickerRoot } from "../helpers/model-picker.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

// Failure cases: saving a new project must show no error and must open a
// draft prefilled with it; with no session open and no list scope, a draft
// must prefill the project last added or given a session; and that memory
// lives on the daemon, so every client and a reload see it.
test.afterEach(async ({ harness }, testInfo) => {
	writeFileSync(testInfo.outputPath("daemon.log"), harness.logTail);
});

test.use({ harnessOptions: { opencodeRecording: "chat-simple" } });

// Only OpenCode is recorded here, and a draft may default to another harness
// with no model, which leaves Send disabled.
async function createSession(page: Page, app: AppPage): Promise<void> {
	const projectSlug = new URL(page.url()).searchParams.get("project");
	expect(projectSlug).toBeTruthy();
	// ChatLayout records the project after attachment is acknowledged.
	await expect
		.poll(() =>
			page.evaluate(() =>
				localStorage.getItem("conduit:last-attached-project"),
			),
		)
		.toBe(projectSlug);
	const picker = page.locator(
		'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
	);
	await openPickerRoot(page, picker);
	await page.getByTestId("picker-harness-opencode").click();
	await expect(picker).toHaveAttribute("data-instance-id", "opencode");
	await page.getByTestId("picker-row-model").click();
	await page
		.getByTestId("model-picker-list")
		.locator('[data-model-id="claude-opus-4-6"][data-provider-id="anthropic"]')
		.click();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("model-picker")).toBeHidden();
	await expect(picker).toHaveAttribute("data-instance-id", "opencode");
	await expect(picker).toHaveAttribute("data-shown-provider", "anthropic");
	await expect(picker).toHaveAttribute("data-shown-model", "claude-opus-4-6");
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
	await expect(page).toHaveURL(/\/draft\/[^/?]+(\?|$)/);
}

test("a draft prefills the project last added or given a session, on every client", async ({
	page,
	browser,
	harness,
}, testInfo) => {
	const folder = join(realpathSync(harness.root), "t3code");
	mkdirSync(folder);
	const errors: string[] = [];
	let modeResolved = false;
	page.on("websocket", (socket) => {
		const modeRequests = new Set<string>();
		socket.on("framesent", ({ payload }) => {
			for (const request of find(
				JSON.parse(String(payload)),
				(value) =>
					"tag" in value &&
					value.tag === "ResolveSessionMode" &&
					"payload" in value &&
					typeof value.payload === "object" &&
					value.payload !== null &&
					"projectSlug" in value.payload &&
					value.payload.projectSlug === "t3code",
			))
				if ("id" in request) modeRequests.add(String(request.id));
		});
		socket.on("framereceived", ({ payload }) => {
			if (
				find(
					JSON.parse(String(payload)),
					(value) =>
						"_tag" in value &&
						value._tag === "Exit" &&
						"requestId" in value &&
						modeRequests.has(String(value.requestId)),
				).length > 0
			)
				modeResolved = true;
		});
	});
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
	await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
	await expect(draftChip).toHaveText(/t3code\s*$/);
	await expect(page.getByTestId("session-scope-chip")).toHaveText("t3code");
	await expect.poll(() => modeResolved).toBe(true);
	// Let the reply's promise handlers and resulting toast render before asserting absence.
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
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

// ADR-0011 failure cases: "New project…" on the draft's chip must land the
// draft in the saved project, hand focus to the prompt, and leave the list
// scope alone; a draft opened while reading a session must start in that
// session's project even with the list scoped to another; and a pick in the
// chip must outlast a later default from another client and a reload. On a
// phone the list replaces the session, so no session is open when + is tapped
// and the scope decides.
test("a draft starts in the open session's project, keeps its pick, and lands in a New project", async ({
	page,
	browser,
	harness,
}, testInfo) => {
	const root = realpathSync(harness.root);
	const beta = join(root, "beta");
	const gamma = join(root, "gamma");
	mkdirSync(beta);
	mkdirSync(gamma);
	const app = new AppPage(page);
	const isPhone = await app.isMobileViewport();
	const draftChip = page.getByTestId("draft-project-chip");
	const shot = (name: string) =>
		page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
	const addFolder = async (target: Page, folder: string) => {
		const dialog = target.getByRole("dialog", {
			name: "Add project",
			exact: true,
		});
		await dialog.getByRole("combobox", { name: "Add folder" }).fill(folder);
		await dialog.getByRole("option", { name: folder, exact: true }).click();
		await dialog.getByRole("button", { name: /^Add project/ }).click();
		await expect(dialog).toBeHidden();
	};

	await app.goto(harness.baseUrl);
	await newSession(page);
	await expect(draftChip).not.toHaveText("Choose a project");
	const original =
		(await draftChip.locator(".truncate").textContent())?.trim() ?? "";
	const originalSlug = new URL(page.url()).searchParams.get("project");
	expect(originalSlug).toBeTruthy();

	if (isPhone) await draftChip.tap();
	else await draftChip.click();
	await page.getByRole("menuitem", { name: "New project…" }).click();
	await addFolder(page, beta);
	await expect(page).toHaveURL(/\/draft\/[^/?]+\?/);
	await expect(draftChip).toHaveText(/beta\s*$/);
	await expect(app.input).toBeFocused();
	expect(new URL(page.url()).searchParams.get("p")).toBeNull();
	await shot("1-new-project-lands-in-draft");
	await createSession(page, app);

	await toList(page);
	await page.getByTestId("session-scope-chip").click();
	await page
		.getByRole("menuitemradio")
		.filter({ hasText: `project:${originalSlug}` })
		.click();
	await expect
		.poll(() => new URL(page.url()).searchParams.get("p"))
		.toBe(originalSlug);
	if (!isPhone) await expect(page).toHaveURL(/\/s\/[^/?]+/);
	await newSession(page);
	const defaulted = isPhone ? original : "beta";
	await expect(draftChip.locator(".truncate")).toHaveText(defaulted);
	await shot(
		isPhone ? "2-phone-list-scope-decides" : "2-open-session-beats-list-scope",
	);

	const picked = isPhone ? "beta" : original;
	await app.chooseDraftProject(picked);

	// Another client adds gamma, which moves the daemon's default to it.
	const other = await browser.newContext({
		viewport: page.viewportSize(),
		hasTouch: testInfo.project.use.hasTouch ?? false,
	});
	const otherPage = await other.newPage();
	await new AppPage(otherPage).goto(harness.baseUrl);
	await toList(otherPage);
	await otherPage.getByTestId("session-scope-chip").click();
	await otherPage.getByRole("menuitem", { name: "Add a project…" }).click();
	await addFolder(otherPage, gamma);
	await expect(otherPage.getByTestId("draft-project-chip")).toHaveText(
		/gamma\s*$/,
	);
	await other.close();

	// gamma in this client's menu proves the later default reached it.
	if (isPhone) await draftChip.tap();
	else await draftChip.click();
	await expect(
		page.getByRole("menuitemradio", { name: /gamma/ }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(draftChip.locator(".truncate")).toHaveText(picked);
	await page.reload();
	await expect(draftChip.locator(".truncate")).toHaveText(picked);
	await shot("3-pick-outlasts-later-default");
});
