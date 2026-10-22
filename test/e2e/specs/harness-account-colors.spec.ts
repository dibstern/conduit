import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { openPickerRoot } from "../helpers/model-picker.js";
import { expect, test } from "../helpers/process-harness-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({ startHarness: false, harnessOptions: { restartProof: true } });

// Failures: config migration is not durable, browsers infer colours from their
// usage ordering, or removing a neighbour recolours a surviving account.
test("account colours agree across browsers and controls after removal and restart", async ({
	page,
	browser,
	harness,
	isMobile,
}, testInfo) => {
	const configPath = join(harness.configDir, "daemon.json");
	const seed = JSON.parse(readFileSync(configPath, "utf8")) as Record<
		string,
		unknown
	>;
	const accounts = ["personal", "work", "lab"].map((id) => {
		const configDir = join(harness.root, `colour-${id}`);
		mkdirSync(configDir);
		writeFileSync(
			join(configDir, "conduit-test-usage-response.json"),
			JSON.stringify({
				subscription_type: "max",
				rate_limits_available: true,
				rate_limits: {
					five_hour: { utilization: 20, resets_at: null },
					seven_day: { utilization: 10, resets_at: null },
				},
			}),
		);
		return {
			id,
			name: id,
			driver: "claude",
			port: 0,
			managed: false,
			configDir,
		};
	});
	writeFileSync(
		configPath,
		JSON.stringify({
			...seed,
			configVersion: 2,
			instances: accounts,
			accountDefaults: { claude: "work" },
		}),
	);
	await harness.restart();
	const control = await harness.connect();
	const stored = () =>
		JSON.parse(readFileSync(configPath, "utf8")) as {
			instances: { id: string; colorSlot: number }[];
		};
	expect(
		stored()
			.instances.filter(({ id }) => id !== "opencode")
			.map(({ colorSlot }) => colorSlot),
	).toEqual([0, 1, 2]);
	const url = `${harness.baseUrl}/new?p=process-test&project=process-test`;
	const second = await browser.newContext({
		viewport: { width: 1440, height: 900 },
	});
	const other = await second.newPage();
	const observed: Record<string, string> = {};
	try {
		for (const client of [page, other]) {
			await new AppPage(client).goto(url);
			await expect(client.locator("#input")).toBeVisible();
			const trigger = client.locator(
				'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible, [data-testid="composer-words-sheet-trigger"]:visible',
			);
			await openPickerRoot(client, trigger);
			await client.getByTestId("picker-harness-claude").click();
			const dot = client
				.getByTestId("picker-account-work")
				.getByTestId("account-dot");
			await expect(dot).toHaveCSS("background-color", "rgb(62, 207, 142)");
			await client.getByTestId("picker-account-work").click();
			await client.keyboard.press("Escape");
			const badge = client.locator(
				'#input-area [data-testid="harness-logo-badge"][data-account="work"]',
			);
			await expect(badge).toHaveCSS("background-color", "rgb(62, 207, 142)");
		}
		const footer = other.getByTestId("usage-footer-dot-work");
		await expect(footer).toHaveCSS("background-color", "rgb(62, 207, 142)");
		const before = await footer.evaluate(
			(dot) => getComputedStyle(dot).backgroundColor,
		);
		observed["before"] = before;
		await Effect.runPromise(
			control.rpc.RemoveInstance({ instanceId: "personal" }),
		);
		for (const client of [page, other]) {
			const trigger = client.locator(
				'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible, [data-testid="composer-words-sheet-trigger"]:visible',
			);
			await openPickerRoot(client, trigger);
			await client.getByTestId("picker-harness-claude").click();
			await expect(client.getByTestId("picker-account-personal")).toHaveCount(
				0,
			);
			await expect(
				client.getByTestId("picker-account-work").getByTestId("account-dot"),
			).toHaveCSS("background-color", before);
			await client.keyboard.press("Escape");
			await expect(
				client.locator(
					'#input-area [data-testid="harness-logo-badge"][data-account="work"]',
				),
			).toHaveCSS("background-color", before);
		}
		await expect(other.getByTestId("usage-footer-row-personal")).toHaveCount(0);
		await expect(footer).toHaveCSS("background-color", before);
		// Put Work first to distinguish its persisted slot from its row index.
		await Effect.runPromise(
			control.rpc.SetUsageLimitsSetting({
				usageLimits: {
					autoResume: false,
					autoSwitch: false,
					warnAt: 80,
					order: ["work", "lab"],
				},
			}),
		);
		await new AppPage(other).goto(url);
		await expect(other.getByTestId("usage-footer-row-lab")).toBeVisible();
		expect(
			await other
				.getByTestId("usage-footer-meter")
				.locator('[data-testid^="usage-footer-row-"]')
				.evaluateAll((rows) =>
					rows.map((row) => row.getAttribute("data-testid")),
				),
		).toEqual(["usage-footer-row-work", "usage-footer-row-lab"]);
		await expect(footer).toHaveCSS("background-color", before);
		const added = await Effect.runPromise(
			control.rpc.AddInstance({ name: "Replacement", driver: "claude" }),
		);
		expect(
			added.instances.find(({ id }) => id === added.addedInstanceId)?.colorSlot,
		).toBe(0);
		expect(stored().instances.find(({ id }) => id === "work")?.colorSlot).toBe(
			1,
		);
		await harness.terminate();
		await harness.restart({ keepPort: true });
		expect(
			stored().instances.find(({ id }) => id === added.addedInstanceId)
				?.colorSlot,
		).toBe(0);
		await new AppPage(other).goto(url);
		await expect(other.getByTestId("usage-footer-dot-work")).toHaveCSS(
			"background-color",
			before,
		);
		observed["afterRestart"] = await other
			.getByTestId("usage-footer-dot-work")
			.evaluate((dot) => getComputedStyle(dot).backgroundColor);
		await other
			.getByTestId("usage-footer-meter")
			.screenshot({ path: testInfo.outputPath("stable-account-colours.png") });
		await testInfo.attach("account-colours", {
			body: JSON.stringify(
				{
					isMobile,
					observed,
					slots: stored().instances.map(({ id, colorSlot }) => ({
						id,
						colorSlot,
					})),
				},
				null,
				2,
			),
			contentType: "application/json",
		});
	} finally {
		await second.close();
	}
});
