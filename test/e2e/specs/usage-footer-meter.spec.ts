import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Schema } from "effect";
import { usageForecastTime } from "../../../src/lib/frontend/utils/continuation.js";
import { openPickerRoot } from "../helpers/model-picker.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({ harnessOptions: { restartProof: true } });
test.skip(
	({ isMobile }) => isMobile,
	"The footer belongs to the desktop sidebar",
);

// Failures: the daemon reads the wrong account directory, the subscription does
// not reach the browser, a later account replaces the first, or the current
// account ignores the account picked for a new session draft.
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

	await test.step("a fresh quota read warns above the project's composer", async () => {
		const response = {
			subscription_type: "max",
			rate_limits_available: true,
			rate_limits: {
				five_hour: { utilization: 88, resets_at: null },
				seven_day: { utilization: personal.week, resets_at: null },
			},
		} satisfies Pick<
			SDKControlGetUsageResponse,
			"subscription_type" | "rate_limits_available" | "rate_limits"
		>;
		writeFileSync(
			join(personal.configDir, "conduit-test-usage-response.json"),
			JSON.stringify(response),
		);
		// This existing RPC refreshes the shared Usage service and publishes its
		// readings to SubscribeUsage. Poll past any overlapping initial probe.
		await expect
			.poll(async () => {
				const readings = await Effect.runPromise(
					browser.rpc.QuotaForAccounts({
						projectSlug: savedSlug,
						originId: browser.originId,
					}),
				);
				return readings
					.find((reading) => reading.accountId === personal.id)
					?.windows.find((window) => window.kind === "five_hour")?.utilization;
			})
			.toBe(88);
		await expect(
			page.getByTestId(`usage-footer-value-${personal.id}-five_hour`),
		).toHaveText("88%");
		await new AppPage(page).goto(
			`${harness.baseUrl}/new?p=${encodeURIComponent(savedSlug)}&project=${encodeURIComponent(savedSlug)}`,
		);
		await expect(page.locator("#input")).toBeVisible();
		const picker = page.locator(
			'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
		);
		await openPickerRoot(page, picker);
		await page.getByTestId("picker-harness-claude").click();
		await page.getByTestId(`picker-account-${personal.id}`).click();
		await page.keyboard.press("Escape");
		await expect(picker).toHaveAttribute("data-instance-id", personal.id);
		await expect(
			page.getByTestId(`usage-footer-row-${personal.id}`),
		).toHaveAttribute("title", "Current account");
		await expect(page.getByTestId("usage-warning-strip")).toBeVisible();
		await expect(page.getByTestId("usage-warning-strip")).toHaveAttribute(
			"data-window",
			"five_hour",
		);
		await expect(page.getByTestId("usage-warning-title")).toHaveText(
			"Personal: 5h limit 88% used.",
		);
		const warningScreenshot = join(artifacts, "usage-warning.png");
		await page.locator("#input-area").screenshot({ path: warningScreenshot });
		await testInfo.attach("usage-warning", {
			path: warningScreenshot,
			contentType: "image/png",
		});
	});
});

test.describe("send at an account's reset", () => {
	test.use({
		harnessOptions: {
			restartProof: true,
			continuationSweepIntervalMs: 1000,
		},
	});

	// Failures: a never-cut-off session dispatches a limited send, no reset is
	// scheduled, the tray loses its release caption, or stale usage holds it
	// beyond the reset. Provider marks prove the input reaches the fake SDK.
	test("an idle session queues a limited account's input and dispatches it after reset", async ({
		page,
		harness,
	}, testInfo) => {
		test.setTimeout(120_000);
		const artifacts = resolve(
			"test-results/composer-send-at-reset",
			`${testInfo.project.name}-${testInfo.retry}`,
		);
		mkdirSync(artifacts, { recursive: true });
		const browser = await harness.connect();
		const configDir = mkdtempSync(join(harness.root, "reset-account-"));
		const writeUsage = (utilization: number, resetsAt: string | null) => {
			const response = {
				subscription_type: "max",
				rate_limits_available: true,
				rate_limits: {
					five_hour: { utilization, resets_at: resetsAt },
					seven_day: { utilization: 22, resets_at: null },
				},
			} satisfies Pick<
				SDKControlGetUsageResponse,
				"subscription_type" | "rate_limits_available" | "rate_limits"
			>;
			writeFileSync(
				join(configDir, "conduit-test-usage-response.json"),
				JSON.stringify(response),
			);
		};
		writeUsage(41, null);
		const { addedInstanceId } = await Effect.runPromise(
			browser.rpc.AddInstance({
				name: "Reset account",
				driver: "claude",
				configDir,
			}),
		);
		if (!addedInstanceId) throw new Error("No reset account ID");
		await Effect.runPromise(
			browser.rpc.SetUsageLimitsSetting({
				usageLimits: {
					autoResume: false,
					autoSwitch: false,
					warnAt: 80,
					order: [addedInstanceId],
				},
			}),
		);
		const { savedSlug: projectSlug } = await Effect.runPromise(
			browser.rpc.SaveProject({
				folders: [mkdtempSync(join(harness.root, "reset-project-"))],
			}),
		);
		if (!projectSlug) throw new Error("No reset project slug");
		const { sessionId } = await Effect.runPromise(
			browser.rpc.CreateSession({
				permissionMode: "ask",
				projectSlug,
				instanceId: Schema.decodeUnknownSync(
					Schema.String.pipe(Schema.brand("ProviderInstanceId")),
				)(addedInstanceId),
				model: { modelId: "harness", providerId: "claude" },
				originId: browser.originId,
			}),
		);
		const app = new AppPage(page);
		await app.goto(
			`${harness.baseUrl}/s/${encodeURIComponent(sessionId)}?p=${encodeURIComponent(projectSlug)}`,
		);
		await expect(app.input).toBeVisible();
		const resetAt = Date.now() + 8_000;
		const resetAtMonotonic =
			process.hrtime.bigint() + BigInt(resetAt - Date.now()) * 1_000_000n;
		writeUsage(100, new Date(resetAt).toISOString());
		// QuotaForAccounts refreshes the same shared feed used by the warning
		// strip. No provider error or cut-off is needed to queue this input.
		await expect
			.poll(async () => {
				const readings = await Effect.runPromise(
					browser.rpc.QuotaForAccounts({
						projectSlug,
						originId: browser.originId,
					}),
				);
				return readings
					.find((reading) => reading.accountId === addedInstanceId)
					?.windows.find((window) => window.kind === "five_hour")?.utilization;
			})
			.toBe(100);
		await expect(app.sendBtn).toHaveAttribute("data-send-mode", "at-reset");
		await expect(page.getByTestId("cut-off-tag")).toHaveCount(0);
		const prompt = "send-at-reset-without-a-cut-off";
		await app.sendMessage(prompt);
		const row = page.getByTestId("pending-input-row");
		await expect(row).toHaveCount(1);
		await expect(row.getByTestId("pending-input-text")).toHaveText(prompt);
		await expect(row.getByTestId("pending-input-state")).toHaveText("Queued");
		const caption = `Sends at ${usageForecastTime(resetAt, Date.now())}`;
		await expect(row.getByTestId("pending-input-sends-at")).toHaveText(caption);
		await expect(row.getByTestId("pending-input-edit")).toBeVisible();
		await expect(row.getByTestId("pending-input-remove")).toBeVisible();
		const heldAt = Date.now();
		expect(heldAt).toBeLessThan(resetAt);
		expect(harness.claudeOptions().find((call) => call.prompt === prompt)).toBe(
			undefined,
		);
		expect(
			harness.marks.some(
				(mark) => mark.kind === "enqueue" && mark.prompt === prompt,
			),
		).toBe(false);
		const heldHistory = await Effect.runPromise(
			browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
		);
		expect(JSON.stringify(heldHistory.messages)).not.toContain(prompt);
		const heldScreenshot = join(artifacts, "queued-at-reset.png");
		await page.locator("#input-area").screenshot({ path: heldScreenshot });
		await testInfo.attach("queued-at-reset", {
			path: heldScreenshot,
			contentType: "image/png",
		});

		// The reset expires even while the cached reading remains limited.
		await expect
			.poll(() => Date.now(), { timeout: 15_000 })
			.toBeGreaterThan(resetAt);
		writeUsage(1, null);
		await expect
			.poll(async () => {
				const readings = await Effect.runPromise(
					browser.rpc.QuotaForAccounts({
						projectSlug,
						originId: browser.originId,
					}),
				);
				return readings
					.find((reading) => reading.accountId === addedInstanceId)
					?.windows.find((window) => window.kind === "five_hour")?.utilization;
			})
			.toBe(1);
		await expect
			.poll(
				() =>
					harness.marks.find(
						(mark) => mark.kind === "enqueue" && mark.prompt === prompt,
					),
				{ timeout: 20_000 },
			)
			.toBeTruthy();
		const dispatched = harness.marks.find(
			(mark) => mark.kind === "enqueue" && mark.prompt === prompt,
		);
		if (dispatched?.kind !== "enqueue")
			throw new Error("The reset input never reached the provider");
		expect(BigInt(dispatched.at)).toBeGreaterThanOrEqual(resetAtMonotonic);
		expect(
			harness.claudeOptions().find((call) => call.prompt === prompt),
		).toMatchObject({
			configDir,
		});
		await expect(page.getByTestId("pending-input-tray")).toHaveCount(0);
		await expect(page.locator("#messages")).toContainText(`done(${prompt})`);
		const dispatchedScreenshot = join(artifacts, "dispatched-after-reset.png");
		await page.screenshot({ path: dispatchedScreenshot });
		await testInfo.attach("dispatched-after-reset", {
			path: dispatchedScreenshot,
			contentType: "image/png",
		});
		const evidence = {
			accountId: addedInstanceId,
			configDir,
			projectSlug,
			sessionId,
			resetAt,
			resetAtMonotonic: resetAtMonotonic.toString(),
			heldAt,
			caption,
			heldHistory,
			providerMarks: harness.marks.filter(
				(mark) => "prompt" in mark && mark.prompt === prompt,
			),
			history: await Effect.runPromise(
				browser.rpc.LoadMoreHistory({ projectSlug, sessionId }),
			),
		};
		writeFileSync(
			join(artifacts, "reset.json"),
			JSON.stringify(evidence, null, 2),
		);
		await testInfo.attach("send-at-reset-evidence", {
			body: JSON.stringify(evidence),
			contentType: "application/json",
		});
	});
});
