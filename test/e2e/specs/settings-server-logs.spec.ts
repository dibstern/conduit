import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { Schema } from "effect";
import {
	GetStatus,
	type GetStatusResponse,
	GetStatusResponseSchema,
	RemoveProject,
	RpcLogLevelSchema,
} from "../../../src/lib/contracts/ws-rpc.js";
import { isRecord } from "../../../src/lib/utils.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { chooseSettingsOption } from "../helpers/settings.js";
import { AppPage } from "../page-objects/app.page.js";

const test = base.extend<{ harness: ProcessHarness }>({
	harness: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructuring for fixtures with no dependencies.
		async ({}, use, testInfo) => {
			const harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			});
			try {
				await harness.restart({ startupTimeoutMs: 60_000 });
				await harness.requestRpc(new RemoveProject({ slug: "process-test" }));
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

function observeStatus(page: Page): GetStatusResponse[] {
	const reads: GetStatusResponse[] = [];
	page.on("websocket", (socket) => {
		if (new URL(socket.url()).pathname !== "/rpc") return;
		const requests = new Map<string, string>();
		socket.on("framesent", ({ payload }) => {
			const parsed: unknown = JSON.parse(String(payload));
			for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
				if (
					isRecord(message) &&
					message["_tag"] === "Request" &&
					typeof message["id"] === "string" &&
					typeof message["tag"] === "string"
				)
					requests.set(message["id"], message["tag"]);
			}
		});
		socket.on("framereceived", ({ payload }) => {
			const parsed: unknown = JSON.parse(String(payload));
			for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
				if (
					!isRecord(message) ||
					message["_tag"] !== "Exit" ||
					typeof message["requestId"] !== "string" ||
					requests.get(message["requestId"]) !== "GetStatus"
				)
					continue;
				const exit = message["exit"];
				if (isRecord(exit) && exit["_tag"] === "Success")
					reads.push(
						Schema.decodeUnknownSync(GetStatusResponseSchema)(exit["value"]),
					);
			}
		});
	});
	return reads;
}

async function openServer(page: Page): Promise<void> {
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
	const logs = page.getByTestId("server-logs-group");
	await expect(logs).toBeVisible();
	await logs.getByRole("button", { name: /^Logs\b/ }).click();
	await expect(
		logs.getByRole("button", { name: /^Log level\b/ }),
	).toBeVisible();
}

test("Log level updates daemon status and survives reopening Settings", async ({
	page,
	harness,
}, testInfo) => {
	const reads = observeStatus(page);
	await new AppPage(page).goto(harness.baseUrl);
	await openServer(page);
	const logs = page.getByTestId("server-logs-group");
	const select = logs.getByRole("button", { name: /^Log level\b/ });
	await expect(select).toBeEnabled();
	await expect.poll(() => reads.length).toBeGreaterThan(0);
	await expect(select).toHaveAttribute(
		"data-value",
		reads.at(-1)?.logLevel ?? "missing",
	);
	await select.click();
	await expect(page.getByRole("menuitemradio")).toHaveText([
		...RpcLogLevelSchema.literals,
	]);
	await page.keyboard.press("Escape");
	await expect(logs).toContainText(
		"Whole daemon · resets when conduit restarts",
	);

	const nextLevel = reads.at(-1)?.logLevel === "debug" ? "warn" : "debug";
	const readsBefore = reads.length;
	await chooseSettingsOption(page, select, nextLevel);
	await expect.poll(() => reads.length).toBeGreaterThan(readsBefore);
	await expect.poll(() => reads.at(-1)?.logLevel).toBe(nextLevel);
	await expect(select).toBeEnabled();
	await expect(select).toHaveAttribute("data-value", nextLevel);
	expect((await harness.requestRpc(new GetStatus({}))).logLevel).toBe(
		nextLevel,
	);
	await expect(logs.getByRole("alert")).toHaveCount(0);

	await page.getByTestId("settings-close-btn").click();
	await expect(page.locator("#settings-panel")).toBeHidden();
	await openServer(page);
	await expect(select).toHaveAttribute("data-value", nextLevel);

	// A new page must read the same level from the daemon, without a cached store.
	const readsBeforeReload = reads.length;
	await new AppPage(page).goto(harness.baseUrl);
	await openServer(page);
	await expect.poll(() => reads.length).toBeGreaterThan(readsBeforeReload);
	await expect.poll(() => reads.at(-1)?.logLevel).toBe(nextLevel);
	await expect(select).toBeEnabled();
	await expect(select).toHaveAttribute("data-value", nextLevel);
	await select.evaluate((element) => element.blur());

	const artifacts = resolve("test-results/settings-server-logs");
	mkdirSync(artifacts, { recursive: true });
	await logs.screenshot({
		path: resolve(artifacts, `${testInfo.project.name}-logs.png`),
		animations: "disabled",
	});
});
