import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

import { ProcessHarness } from "../../helpers/process-harness.js";
import { AppPage } from "../page-objects/app.page.js";

const CURRENT_PIN = "1234";
const NEW_PIN = "482615";
const PIN_PLACEHOLDER = "PIN (4-8 digits)";

const test = base.extend<{
	harness: ProcessHarness;
	initialPin: string | null;
}>({
	initialPin: [CURRENT_PIN, { option: true }],
	harness: [
		async ({ initialPin }, use, testInfo) => {
			const harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			});
			try {
				await harness.restart({ startupTimeoutMs: 60_000 });
				await harness.requestRpc({
					_tag: "RemoveProject",
					slug: "process-test",
				});
				if (initialPin !== null)
					await harness.requestRpc({ _tag: "SetPin", pin: initialPin });
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

async function unlock(page: Page, pin: string): Promise<void> {
	const input = page.getByPlaceholder(PIN_PLACEHOLDER, { exact: true });
	await expect(input).toBeVisible();
	await input.fill(pin);
	await input.press("Enter");
	await expect(input).toHaveCount(0);
	const app = new AppPage(page);
	await expect(app.layout).toBeAttached();
	await expect(app.connectOverlay).toHaveCount(0, { timeout: 30_000 });
}

async function openServerSettings(page: Page): Promise<void> {
	const listOverflow = page.getByTestId("list-bar-overflow");
	const titleMenu = page.getByTestId("session-bar-title-menu");
	const sessionOverflow = page.getByTestId("session-bar-overflow");
	await expect(
		listOverflow.or(titleMenu).or(sessionOverflow).first(),
	).toBeVisible();
	if (await listOverflow.isVisible()) {
		await listOverflow.click();
		await page.getByTestId("list-overflow-settings").click();
	} else if (await titleMenu.isVisible()) {
		await titleMenu.click();
		await page.getByTestId("session-title-settings").click();
	} else {
		await sessionOverflow.click();
		await page.getByTestId("overflow-settings").click();
	}
	await page.getByTestId("settings-tab-server").click();
	await expect(page.getByTestId("server-status-version")).toBeVisible();
	await expect(page.getByTestId("server-security-settings")).toBeVisible();
}

async function screenshot(page: Page, name: string): Promise<void> {
	const artifacts = resolve("test-results/settings-pin");
	mkdirSync(artifacts, { recursive: true });
	await page.screenshot({
		path: resolve(artifacts, name),
		animations: "disabled",
	});
}

test("changing the PIN proves the current PIN and signs out both open tabs", async ({
	page,
	context,
	harness,
}, testInfo) => {
	await page.goto(harness.baseUrl);
	await unlock(page, CURRENT_PIN);
	await openServerSettings(page);
	const security = page.getByTestId("server-security-settings");
	await expect(security).toContainText("On · asked once on each new device");

	const second = await context.newPage();
	await new AppPage(second).goto(harness.baseUrl);
	await openServerSettings(second);
	// The second tab must have a live browser socket before the mutation.
	await expect(second.getByTestId("server-status-browsers")).toHaveText(
		"· 2 browsers connected",
	);

	// PIN editors, instance forms and Stop all share one open form.
	await page.getByTestId("add-instance-btn").click();
	await page.getByTestId("server-pin-change-btn").click();
	await expect(page.getByTestId("instance-form")).toBeHidden();
	const current = page.getByTestId("server-pin-current");
	await expect(current).toBeFocused();
	await page.getByTestId("server-shutdown-btn").click();
	await expect(page.getByTestId("server-pin-form")).toBeHidden();
	await page.getByTestId("server-pin-remove-btn").click();
	await expect(page.getByTestId("server-shutdown-confirmation")).toBeHidden();
	await expect(current).toBeFocused();
	await expect(security).toContainText(
		"Without a PIN, anyone who can reach this address can open conduit.",
	);
	await page.getByTestId("server-pin-change-btn").click();
	await page.getByTestId("server-pin-change-btn").click();
	await expect(page.getByTestId("server-pin-form")).toBeHidden();
	await page.getByTestId("server-pin-change-btn").click();
	await expect(current).toBeFocused();
	await expect(security).toContainText(
		"Every browser, including this one, will ask for the new PIN.",
	);

	const next = page.getByTestId("server-pin-new");
	const confirm = page.getByTestId("server-pin-confirm");
	const error = page.getByTestId("server-pin-error");
	await current.fill(CURRENT_PIN);
	for (const invalid of ["12", "abcd"]) {
		await next.fill(invalid);
		await confirm.fill(invalid);
		await page.getByTestId("server-pin-save").click();
		await expect(error).toHaveText("PIN must be 4 to 8 digits.");
	}
	await next.fill(NEW_PIN);
	await confirm.fill("482616");
	await page.getByTestId("server-pin-save").click();
	await expect(error).toHaveText("PINs don't match.");
	await expect(current).toHaveValue(CURRENT_PIN);
	await screenshot(page, `${testInfo.project.name}-mismatch.png`);

	await current.fill("9999");
	await confirm.fill(NEW_PIN);
	await page.getByTestId("server-pin-save").click();
	await expect(error).toHaveText("Wrong PIN. Try again.");
	await expect(current).toHaveValue("");
	await expect(current).toBeFocused();
	await expect(next).toHaveValue(NEW_PIN);
	await expect(confirm).toHaveValue(NEW_PIN);
	await screenshot(page, `${testInfo.project.name}-wrong-current.png`);

	await current.fill(CURRENT_PIN);
	await page.getByTestId("server-pin-save").click();
	await expect(page.getByPlaceholder(PIN_PLACEHOLDER)).toBeVisible({
		timeout: 30_000,
	});
	await expect(second.getByPlaceholder(PIN_PLACEHOLDER)).toBeVisible({
		timeout: 30_000,
	});
	await screenshot(page, `${testInfo.project.name}-this-tab-signed-out.png`);
	await screenshot(
		second,
		`${testInfo.project.name}-second-tab-signed-out.png`,
	);

	// The previous PIN no longer opens conduit; the replacement does.
	await page.getByPlaceholder(PIN_PLACEHOLDER).fill(CURRENT_PIN);
	await page.getByPlaceholder(PIN_PLACEHOLDER).press("Enter");
	await expect(page.getByText(/^Wrong PIN/)).toBeVisible();
	await unlock(page, NEW_PIN);
	await openServerSettings(page);
	await expect(security).toContainText("On · asked once on each new device");
	await screenshot(page, `${testInfo.project.name}-new-pin-unlocked.png`);
	await unlock(second, NEW_PIN);
});

test("PIN lockout reports the daemon retry time inline", async ({
	page,
	harness,
}, testInfo) => {
	await page.goto(harness.baseUrl);
	await unlock(page, CURRENT_PIN);
	await openServerSettings(page);
	await page.getByTestId("server-pin-remove-btn").click();
	const current = page.getByTestId("server-pin-current");
	const error = page.getByTestId("server-pin-error");
	for (let attempt = 1; attempt <= 5; attempt++) {
		await current.fill("9999");
		await page.getByTestId("server-pin-save").click();
		await expect(error).toHaveText(
			attempt < 5
				? "Wrong PIN. Try again."
				: "Too many tries. Try again in 15 minutes.",
		);
		if (attempt < 5) await expect(current).toHaveValue("");
	}
	await current.fill(CURRENT_PIN);
	await page.getByTestId("server-pin-save").click();
	await expect(error).toHaveText("Too many tries. Try again in 15 minutes.");
	await screenshot(page, `${testInfo.project.name}-locked-out.png`);
});

test.describe("no PIN configured", () => {
	test.use({ initialPin: null });
	test("sets a PIN without a current PIN and requires it before removal", async ({
		page,
		browser,
		harness,
	}, testInfo) => {
		await new AppPage(page).goto(harness.baseUrl);
		await openServerSettings(page);
		const security = page.getByTestId("server-security-settings");
		await expect(security).toContainText(
			"Off · anyone who can reach this address can open conduit",
		);
		await screenshot(page, `${testInfo.project.name}-pin-off.png`);
		await page.getByTestId("server-pin-set-btn").click();
		await expect(page.getByTestId("server-pin-current")).toHaveCount(0);
		await expect(page.getByTestId("server-pin-new")).toBeFocused();
		await page.getByTestId("server-pin-new").fill(NEW_PIN);
		await page.getByTestId("server-pin-confirm").fill(NEW_PIN);
		await screenshot(page, `${testInfo.project.name}-set-pin.png`);
		await page.getByTestId("server-pin-save").click();
		await expect(page.getByPlaceholder(PIN_PLACEHOLDER)).toBeVisible({
			timeout: 30_000,
		});
		await unlock(page, NEW_PIN);
		await openServerSettings(page);
		await page.getByTestId("server-pin-remove-btn").click();
		await expect(page.getByTestId("server-pin-new")).toHaveCount(0);
		await expect(page.getByTestId("server-pin-confirm")).toHaveCount(0);
		const current = page.getByTestId("server-pin-current");
		await current.fill("9999");
		await page.getByTestId("server-pin-save").click();
		await expect(page.getByTestId("server-pin-error")).toHaveText(
			"Wrong PIN. Try again.",
		);
		await expect(current).toHaveValue("");
		await screenshot(page, `${testInfo.project.name}-remove-pin.png`);
		await current.fill(NEW_PIN);
		await page.getByTestId("server-pin-save").click();
		await expect(security).toContainText(
			"Off · anyone who can reach this address can open conduit",
		);
		await expect(page.getByTestId("server-pin-form")).toBeHidden();
		await screenshot(page, `${testInfo.project.name}-pin-removed.png`);
		// A new device also opens conduit without the old authentication cookie.
		const freshContext = await browser.newContext();
		try {
			const freshPage = await freshContext.newPage();
			await new AppPage(freshPage).goto(harness.baseUrl);
			await expect(freshPage.getByPlaceholder(PIN_PLACEHOLDER)).toHaveCount(0);
		} finally {
			await freshContext.close();
		}
	});
});
