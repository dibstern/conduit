import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({ harnessOptions: { restartProof: true } });
test.skip(
	({ isMobile }) => isMobile,
	"The footer belongs to the desktop sidebar",
);

// Failures: the daemon reads the wrong account directory, the subscription does
// not reach the browser, a later account replaces the first, or the project
// default follows the open session instead of the project's bound instance.
test("real daemon usage controls reach the desktop sidebar footer per account", async ({
	page,
	harness,
}, testInfo) => {
	const artifacts = resolve(
		"test-results/usage-footer-meter",
		`${testInfo.project.name}-${testInfo.retry}`,
	);
	mkdirSync(artifacts, { recursive: true });
	const browser = await harness.connect();
	const accounts: {
		id: string;
		name: string;
		configDir: string;
		fiveHour: number;
		week: number;
	}[] = [];
	for (const [name, fiveHour, week] of [
		["Personal", 41, 22],
		["Work", 86, 58],
	] as const) {
		const configDir = mkdtempSync(join(harness.root, "usage-account-"));
		const response = {
			subscription_type: "max",
			rate_limits_available: true,
			rate_limits: {
				five_hour: { utilization: fiveHour, resets_at: null },
				seven_day: { utilization: week, resets_at: null },
			},
		} satisfies Pick<
			SDKControlGetUsageResponse,
			"subscription_type" | "rate_limits_available" | "rate_limits"
		>;
		writeFileSync(
			join(configDir, "conduit-test-usage-response.json"),
			JSON.stringify(response),
		);
		const { addedInstanceId } = await Effect.runPromise(
			browser.rpc.AddInstance({ name, driver: "claude", configDir }),
		);
		if (!addedInstanceId) throw new Error(`No usage account ID for ${name}`);
		accounts.push({ id: addedInstanceId, name, configDir, fiveHour, week });
	}
	const [personal, work] = accounts;
	if (!personal || !work)
		throw new Error("The usage footer needs both test accounts");
	await Effect.runPromise(
		browser.rpc.SetUsageLimitsSetting({
			usageLimits: {
				autoResume: false,
				warnAt: 80,
				autoSwitch: false,
				order: accounts.map((account) => account.id),
			},
		}),
	);
	const { savedSlug } = await Effect.runPromise(
		browser.rpc.SaveProject({
			folders: [mkdtempSync(join(harness.root, "usage-project-"))],
			instanceId: personal.id,
		}),
	);
	if (!savedSlug) throw new Error("No usage project slug");
	await new AppPage(page).goto(
		`${harness.baseUrl}/?p=${encodeURIComponent(savedSlug)}`,
	);
	await expect(page.getByTestId("usage-footer-meter")).toBeVisible();
	for (const account of accounts) {
		await expect(
			page.getByTestId(`usage-footer-name-${account.id}`),
		).toHaveText(account.name);
		await expect(
			page.getByTestId(`usage-footer-value-${account.id}-five_hour`),
		).toHaveText(`${account.fiveHour}%`);
		await expect(
			page.getByTestId(`usage-footer-value-${account.id}-seven_day`),
		).toHaveText(`${account.week}%`);
		await expect
			.poll(() =>
				harness.marks.some(
					(mark) =>
						mark.kind === "usage-probe" && mark.configDir === account.configDir,
				),
			)
			.toBe(true);
	}
	await expect(
		page.getByTestId(`usage-footer-row-${personal.id}`),
	).toHaveAttribute("title", "Default for this project");
	await expect(
		page.getByTestId(`usage-footer-cell-${work.id}-five_hour`),
	).toHaveAttribute("data-level", "warning");
	const footerScreenshot = join(artifacts, "footer.png");
	const screenScreenshot = join(artifacts, "desktop.png");
	await page
		.getByTestId("usage-footer-meter")
		.screenshot({ path: footerScreenshot });
	await page.screenshot({ path: screenScreenshot });
	const evidence = {
		projectSlug: savedSlug,
		defaultAccountId: personal.id,
		accounts,
		values: await page
			.getByTestId("usage-footer-meter")
			.locator('[data-testid^="usage-footer-value-"]')
			.allTextContents(),
		probes: harness.marks.filter((mark) => mark.kind === "usage-probe"),
	};
	writeFileSync(
		join(artifacts, "usage.json"),
		JSON.stringify(evidence, null, 2),
	);
	await testInfo.attach("usage-footer", {
		path: footerScreenshot,
		contentType: "image/png",
	});
	await testInfo.attach("usage-footer-desktop", {
		path: screenScreenshot,
		contentType: "image/png",
	});
	await testInfo.attach("usage-footer-evidence", {
		body: JSON.stringify(evidence),
		contentType: "application/json",
	});
});
