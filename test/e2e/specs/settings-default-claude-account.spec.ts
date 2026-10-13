import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { Either } from "effect";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import {
	GetInstances,
	GetStatus,
	RemoveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
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
				const { configVersion: _version, ...legacy } = seed;
				const configDir = testInfo.outputPath("initial-claude-account");
				mkdirSync(configDir, { recursive: true });
				// Existing installs store the implicit account's folder at the top level.
				writeFileSync(
					join(harness.configDir, "daemon.json"),
					JSON.stringify({
						...legacy,
						claudeConfigDir: configDir,
					}),
				);
				await harness.restart({ startupTimeoutMs: 60_000, serviceEnvironment });
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

async function openServer(page: Page, baseUrl: string): Promise<void> {
	await new AppPage(page).goto(baseUrl);
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
	await expect(page.getByTestId(`instance-row-${defaultId}`)).toBeVisible();
}

test("the default Claude name applies live and its folder survives a login-service restart", async ({
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
		(await harness.requestRpc(new GetInstances({}))).instances.find(
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
		expect((await harness.requestRpc(new GetStatus({}))).supervised).toBe(true);
		record("initial", {
			instance: initial,
			pid: initialPid,
			serviceEnvironment,
		});
		await openServer(page, harness.baseUrl);
		const row = page.getByTestId(`instance-row-${defaultId}`);
		await row.getByRole("button").first().click();
		await expect(row.getByTestId("remove-instance-btn")).toHaveCount(0);
		await expect(row).toContainText("The default account can't be removed");
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
		expect((await harness.requestRpc(new GetStatus({}))).supervised).toBe(true);
		expect(await readDefault()).toMatchObject({
			name: "Personal Claude",
			configDir,
		});
		await openServer(page, harness.baseUrl);
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
