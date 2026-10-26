import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { Result as Either } from "effect";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";

import {
	type DaemonConfig,
	loadDaemonConfigResult,
} from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { AppPage } from "../page-objects/app.page.js";

const defaultId = AccountIdSchema.make("claude");
const artifacts = resolve("test-results/settings-default-claude-account");
const test = base.extend<{
	harness: ProcessHarness;
	serviceEnvironment: Pick<NodeJS.ProcessEnv, "CONDUIT_SERVICE">;
}>({
	serviceEnvironment: [{ CONDUIT_SERVICE: "1" }, { option: true }],
	harness: [
		async ({ serviceEnvironment }, use, testInfo) => {
			const harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
				foregroundCli: true,
			});
			try {
				const seed = Either.getOrThrowWith(
					loadDaemonConfigResult(harness.configDir),
					(error) => error,
				);
				if (!seed) throw new Error("Missing process harness config");
				const configDir = testInfo.outputPath("initial-claude-account");
				mkdirSync(configDir, { recursive: true });
				writeFileSync(
					join(harness.configDir, "daemon.json"),
					JSON.stringify({
						...seed,
						instances: [
							...(seed.instances ?? []).filter(({ id }) => id !== defaultId),
							{
								id: defaultId,
								name: "Claude",
								driver: "claude",
								port: 0,
								managed: false,
								configDir,
							},
						],
						accountDefaults: { claude: defaultId },
					}),
				);
				await harness.restart({ startupTimeoutMs: 60_000, serviceEnvironment });
				await harness.requestRpc({
					_tag: "RemoveProject",
					slug: "process-test",
				});
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

async function openServer(
	page: Page,
	harness: ProcessHarness,
	accountId: string = defaultId,
): Promise<void> {
	await new AppPage(page).mountWithoutProjects(harness);
	const listSettings = page.getByTestId("list-bar-settings");
	const sessionOverflow = page
		.getByTestId("session-bar-overflow")
		.or(page.getByTestId("session-bar-island-overflow"));
	await expect(listSettings.or(sessionOverflow).first()).toBeVisible();
	if (await listSettings.isVisible()) {
		await listSettings.click();
	} else {
		await sessionOverflow.click();
		await page.getByTestId("overflow-settings").click();
	}
	await page.getByTestId("settings-tab-server").click();
	await expect(page.getByTestId(`instance-row-${accountId}`)).toBeVisible();
}

test("ordinary Claude accounts apply edits live, can be removed and stay deleted after restart", async ({
	page,
	harness,
	serviceEnvironment,
}, testInfo) => {
	mkdirSync(artifacts, { recursive: true });
	const runLog: string[] = [];
	const record = (step: string, value: unknown) => {
		runLog.push(`${new Date().toISOString()} ${step} ${JSON.stringify(value)}`);
		writeFileSync(
			resolve(artifacts, `${testInfo.project.name}-run.log`),
			`${runLog.join("\n")}\n`,
		);
	};
	const readDefault = async () =>
		(await harness.requestRpc({ _tag: "GetInstances" })).instances.find(
			({ id }) => id === defaultId,
		);
	const readStored = () =>
		JSON.parse(
			readFileSync(join(harness.configDir, "daemon.json"), "utf8"),
		) as DaemonConfig;
	try {
		const initial = await readDefault();
		const daemonPid = () => harness.generations.at(-1)?.pid;
		const initialPid = daemonPid();
		expect(initial).toBeDefined();
		expect(initial?.configDir).toBe(
			testInfo.outputPath("initial-claude-account"),
		);
		expect((await harness.requestRpc({ _tag: "GetStatus" })).supervised).toBe(
			true,
		);
		record("initial", {
			instance: initial,
			pid: initialPid,
			serviceEnvironment,
		});
		await openServer(page, harness);
		const row = page.getByTestId(`instance-row-${defaultId}`);
		await row.getByRole("button").first().click();
		await expect(row.getByTestId("remove-instance-btn")).toBeVisible();
		await row.getByTestId("edit-instance-btn").click();
		await expect(page.getByTestId("instance-form-name")).toBeFocused();
		await expect(page.getByTestId("instance-form-configdir")).toHaveValue(
			initial?.configDir ?? "",
		);
		await expect(page.getByRole("radiogroup", { name: "Type" })).toHaveCount(0);
		await expect(page.getByTestId("instance-form")).toContainText(
			"Folder changes apply on the next turn",
		);
		await page.screenshot({
			path: resolve(artifacts, `${testInfo.project.name}-edit.png`),
		});
		await page.getByTestId("instance-form-name").fill("Personal Claude");
		await page.getByTestId("instance-form-save").click();
		await expect(page.getByTestId("instance-form")).toBeHidden();
		await expect(row).toContainText("Personal Claude");
		expect(await readDefault()).toMatchObject({
			name: "Personal Claude",
			configDir: initial?.configDir,
		});
		expect(
			readStored().instances?.find(({ id }) => id === defaultId),
		).toHaveProperty("configDir", initial?.configDir);
		expect(daemonPid()).toBe(initialPid);
		record("renamed-without-restart", await readDefault());
		await page.screenshot({
			path: resolve(artifacts, `${testInfo.project.name}-renamed.png`),
		});

		const configDir = testInfo.outputPath("edited-claude-account");
		mkdirSync(configDir, { recursive: true });
		await row.getByRole("button").first().click();
		await row.getByTestId("edit-instance-btn").click();
		await page.getByTestId("instance-form-configdir").fill(configDir);
		await page.getByTestId("instance-form-save").click();
		await expect(page.getByTestId("instance-form")).toBeHidden();
		await expect(row).toContainText(configDir);
		await row.getByRole("button").first().click();
		await expect(row).not.toContainText("Applies after restart");
		const stored = readStored();
		expect(daemonPid()).toBe(initialPid);
		expect(stored).not.toHaveProperty("claudeConfigDir");
		expect(stored.instances?.find(({ id }) => id === defaultId)).toHaveProperty(
			"configDir",
			configDir,
		);
		record("folder-saved", stored);
		await page.screenshot({
			path: resolve(artifacts, `${testInfo.project.name}-folder-saved.png`),
		});
		record("before-restart-daemon-log", harness.logTail);
		const baseUrl = harness.baseUrl;
		await harness.shutdown();
		await harness.restart({
			keepPort: true,
			serviceEnvironment,
			startupTimeoutMs: 60_000,
			// The fixture removed the harness's seed project, so there is nothing to probe.
			skipBrowserProbe: true,
		});
		expect(harness.baseUrl).toBe(baseUrl);
		expect(daemonPid()).not.toBe(initialPid);
		expect((await harness.requestRpc({ _tag: "GetStatus" })).supervised).toBe(
			true,
		);
		expect(await readDefault()).toMatchObject({
			name: "Personal Claude",
			configDir,
		});
		await openServer(page, harness);
		await expect(row).toContainText("Personal Claude");
		await expect(row).toContainText(configDir);
		record("after-login-service-restart", {
			instance: await readDefault(),
			pid: daemonPid(),
			serviceEnvironment,
		});
		await page.screenshot({
			path: resolve(artifacts, `${testInfo.project.name}-restarted.png`),
		});

		await page.getByTestId("add-instance-btn").click();
		await page.getByTestId("instance-form-driver-claude").click();
		await page.getByTestId("instance-form-name").fill("Personal");
		await page.getByTestId("instance-form-configdir").fill(configDir);
		await page.getByTestId("instance-form-save").click();
		await expect(page.getByTestId("instance-form")).toBeHidden();
		const personalRow = page.getByTestId("instance-row-personal");
		await personalRow.getByRole("button", { expanded: false }).click();
		await personalRow.getByTestId("make-default-btn").click();
		await expect(
			personalRow.getByTestId("default-account-marker"),
		).toBeVisible();
		await expect(
			page
				.getByTestId("claude-accounts-list")
				.getByTestId("default-account-marker"),
		).toHaveCount(1);
		await row.getByRole("button", { expanded: false }).click();
		await row.getByTestId("remove-instance-btn").click();
		await page.getByTestId("confirm-modal-action").click();
		await expect(row).toHaveCount(0);
		expect(readStored().accountDefaults?.claude).toBe("personal");
		expect(readStored().deletedAccounts).toContainEqual({
			id: defaultId,
			driver: "claude",
		});
		record("former-built-in-removed", readStored());
		await harness.shutdown();
		await harness.restart({
			keepPort: true,
			serviceEnvironment,
			startupTimeoutMs: 60_000,
			skipBrowserProbe: true,
		});
		await openServer(page, harness, "personal");
		await expect(row).toHaveCount(0);
		expect(await readDefault()).toBeUndefined();
		expect(
			(await harness.requestRpc({ _tag: "GetInstances" })).instances.filter(
				({ driver, isDefault }) => driver === "claude" && isDefault,
			),
		).toMatchObject([{ id: "personal" }]);
		record("deletion-survives-restart", readStored());
		await page.screenshot({
			path: resolve(
				artifacts,
				`${testInfo.project.name}-former-built-in-removed.png`,
			),
		});
		await personalRow.getByRole("button", { expanded: false }).click();
		await personalRow.getByTestId("remove-instance-btn").click();
		await page.getByTestId("confirm-modal-action").click();
		const empty = page.getByTestId("claude-empty-state");
		await expect(empty).toContainText(/No.*accounts/);
		await expect(
			page
				.getByTestId("claude-accounts-list")
				.getByTestId("default-account-marker"),
		).toHaveCount(0);
		expect(readStored().accountDefaults?.claude).toBeUndefined();
		await page.screenshot({
			path: resolve(
				artifacts,
				`${testInfo.project.name}-no-claude-accounts.png`,
			),
		});
		await empty
			.getByRole("button", { name: "Add account", exact: true })
			.click();
		await page.getByTestId("instance-form-name").fill("Personal");
		await page.getByTestId("instance-form-save").click();
		await expect(
			page
				.getByTestId("instance-row-personal-2")
				.getByTestId("default-account-marker"),
		).toBeVisible();
		await expect(personalRow).toHaveCount(0);
		expect(readStored().accountDefaults?.claude).toBe("personal-2");
		expect(readStored().deletedAccounts).toEqual(
			expect.arrayContaining([
				{ id: defaultId, driver: "claude" },
				{ id: "personal", driver: "claude" },
			]),
		);
		record("same-name-account-restored-with-new-id", readStored());
		await page.screenshot({
			path: resolve(artifacts, `${testInfo.project.name}-account-restored.png`),
		});
		record("result", "passed");
	} catch (error) {
		record("result", { error: String(error) });
		await page
			.screenshot({
				path: resolve(artifacts, `${testInfo.project.name}-failure.png`),
			})
			.catch(() => {});
		throw error;
	} finally {
		record("daemon-log", harness.logTail);
		await testInfo.attach("default-Claude-account-run", {
			path: resolve(artifacts, `${testInfo.project.name}-run.log`),
			contentType: "text/plain",
		});
	}
});
