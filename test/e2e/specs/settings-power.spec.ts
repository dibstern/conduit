import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { Result as Either } from "effect";

import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";
import { AppPage } from "../page-objects/app.page.js";

const test = base.extend<{ harness: ProcessHarness }>({
	harness: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture parameters.
		async ({}, use, testInfo) => {
			const harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
				foregroundCli: true,
			});
			try {
				await harness.restart({ startupTimeoutMs: 60_000 });
				await harness.requestRpc({
					_tag: "RemoveProject",
					slug: "process-test",
				});
				// The editor is available only while on. Seed a harmless command so
				// the first UI edit works even without a platform power utility.
				await harness.requestRpc({
					_tag: "SetKeepAwakeCommand",
					command: "sleep",
					args: ["900"],
				});
				await harness.requestRpc({ _tag: "SetKeepAwake", enabled: true });
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

function sleepChildren(
	daemonPid: number,
): Array<{ pid: number; command: string }> {
	const result = spawnSync("pgrep", ["-P", String(daemonPid)], {
		encoding: "utf8",
		timeout: 2000,
		maxBuffer: 4096,
	});
	if (result.error) throw result.error;
	if (result.status === 1) return [];
	if (result.status !== 0) throw new Error(`pgrep failed: ${result.stderr}`);
	const table = execFileSync(
		"ps",
		["-o", "pid=,command=", "-p", result.stdout.trim().split(/\s+/).join(",")],
		{ encoding: "utf8", timeout: 2000, maxBuffer: 16_384 },
	);
	return table
		.trim()
		.split("\n")
		.flatMap((line) => {
			const match = /^\s*(\d+)\s+((?:\S*\/)?sleep (?:600|601|900))$/.exec(line);
			return match ? [{ pid: Number(match[1]), command: match[2] ?? "" }] : [];
		});
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
	await expect(page.getByTestId("server-power-settings")).toBeVisible();
}

test("Power runs its command, shares the inline editor, persists edits and stops its child", async ({
	page,
	harness,
}, testInfo) => {
	const daemonPid = harness.generations.at(-1)?.pid;
	if (!daemonPid) throw new Error("No daemon generation");
	await new AppPage(page).goto(harness.baseUrl);
	await openServer(page);
	const power = page.getByTestId("server-power-settings");
	const toggle = power.getByRole("switch", {
		name: "Toggle keep computer awake",
	});
	const editor = page.getByTestId("server-power-form");
	const command = page.getByTestId("server-power-command");
	const args = page.getByTestId("server-power-args");
	const displayedCommand = page.getByTestId("server-power-command-value");
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(displayedCommand).toHaveText("sleep 900");

	await page.getByTestId("add-instance-btn").click();
	await page.getByTestId("server-power-edit").click();
	await expect(page.getByTestId("instance-form")).toBeHidden();
	await expect(command).toBeFocused();
	await expect(command).toHaveValue("sleep");
	await expect(args).toHaveValue("900");
	await command.fill("discarded");
	await page.getByTestId("server-power-cancel").click();
	await expect(editor).toBeHidden();
	await expect(displayedCommand).toHaveText("sleep 900");
	await page.getByTestId("server-power-edit").click();
	await expect(command).toHaveValue("sleep");
	await page.getByTestId("server-pin-set-btn").click();
	await expect(editor).toBeHidden();
	await page.getByTestId("server-power-edit").click();
	await expect(page.getByTestId("server-pin-form")).toBeHidden();
	await expect(command).toBeFocused();
	await page.getByTestId("server-power-edit").click();
	await expect(editor).toBeHidden();
	await page.getByTestId("server-power-edit").click();
	await command.fill("   ");
	await page.getByTestId("server-power-save").click();
	await expect(page.getByTestId("server-power-error")).toHaveText(
		"Enter a command.",
	);
	await expect(displayedCommand).toHaveText("sleep 900");

	// Set the command through the UI before exercising the off/on toggle.
	await command.fill("/bin/sleep");
	await args.fill("600");
	await page.getByTestId("server-power-save").click();
	await expect(editor).toBeHidden();
	await expect(displayedCommand).toHaveText("/bin/sleep 600");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(displayedCommand).toBeHidden();
	await expect.poll(() => sleepChildren(daemonPid)).toEqual([]);
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(displayedCommand).toHaveText("/bin/sleep 600");
	await expect
		.poll(() => sleepChildren(daemonPid).map((child) => child.command))
		.toEqual(["/bin/sleep 600"]);
	const original = sleepChildren(daemonPid)[0];
	if (!original) throw new Error("No keep-awake child");

	await page.getByTestId("server-power-edit").click();
	await command.fill("sleep");
	await args.fill("601");
	await page.getByTestId("server-power-save").click();
	await expect(editor).toBeHidden();
	await expect(displayedCommand).toHaveText("sleep 601");
	await expect
		.poll(() => sleepChildren(daemonPid).map((child) => child.command))
		.toEqual(["sleep 601"]);
	const replacement = sleepChildren(daemonPid)[0];
	if (!replacement) throw new Error("No replacement keep-awake child");
	expect(replacement.pid).not.toBe(original.pid);
	await expect
		.poll(() =>
			Either.getOrThrowWith(
				loadDaemonConfigResult(harness.configDir),
				(error) => error,
			),
		)
		.toMatchObject({
			keepAwake: true,
			keepAwakeCommand: "sleep",
			keepAwakeArgs: ["601"],
		});

	await page.reload();
	await expect(new AppPage(page).connectOverlay).toHaveCount(0);
	await openServer(page);
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(displayedCommand).toHaveText("sleep 601");
	await page.getByTestId("server-power-edit").click();
	await expect(command).toHaveValue("sleep");
	await expect(args).toHaveValue("601");
	expect(sleepChildren(daemonPid)).toEqual([replacement]);

	const artifacts = resolve("test-results/settings-power");
	mkdirSync(artifacts, { recursive: true });
	await power.screenshot({
		path: resolve(artifacts, `${testInfo.project.name}-power.png`),
		animations: "disabled",
	});
	// Turning off also closes the editor that belongs to the hidden Command row.
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(displayedCommand).toBeHidden();
	await expect(editor).toBeHidden();
	await expect.poll(() => sleepChildren(daemonPid)).toEqual([]);
	const status = await harness.requestRpc({ _tag: "GetStatus" });
	expect(status).toMatchObject({
		keepAwake: false,
		keepAwakeCommand: "sleep 601",
	});
	await expect
		.poll(
			() =>
				Either.getOrThrowWith(
					loadDaemonConfigResult(harness.configDir),
					(error) => error,
				)?.keepAwake,
		)
		.toBe(false);
	writeFileSync(
		resolve(artifacts, `${testInfo.project.name}-processes.json`),
		JSON.stringify(
			{
				daemonPid,
				original,
				replacement,
				stopped: sleepChildren(daemonPid),
				status,
			},
			null,
			2,
		),
	);
});

test("an argument containing spaces survives Edit and Save", async ({
	page,
	harness,
}) => {
	// The isolated daemon puts this bin directory first on PATH. A controlled
	// stand-in keeps this test independent of the host's systemd installation.
	const executable = resolve(harness.root, "bin/systemd-inhibit");
	writeFileSync(
		executable,
		"#!/usr/bin/env node\nsetInterval(() => {}, 60_000);\n",
	);
	chmodSync(executable, 0o755);
	const args = [
		"--what=idle",
		"--who=conduit",
		"--why=Conduit relay running",
		"sleep",
		"infinity",
	];
	await harness.requestRpc({
		_tag: "SetKeepAwakeCommand",
		command: "systemd-inhibit",
		args,
	});
	await new AppPage(page).goto(harness.baseUrl);
	await openServer(page);
	await expect(page.getByTestId("server-power-command-value")).toHaveText(
		"systemd-inhibit --what=idle --who=conduit '--why=Conduit relay running' sleep infinity",
	);
	await page.getByTestId("server-power-edit").click();
	await expect(page.getByTestId("server-power-command")).toHaveValue(
		"systemd-inhibit",
	);
	await expect(page.getByTestId("server-power-args")).toHaveValue(
		"--what=idle --who=conduit '--why=Conduit relay running' sleep infinity",
	);
	await page.getByTestId("server-power-save").click();
	await expect(page.getByTestId("server-power-form")).toBeHidden();
	await expect
		.poll(() =>
			Either.getOrThrowWith(
				loadDaemonConfigResult(harness.configDir),
				(error) => error,
			),
		)
		.toMatchObject({
			keepAwakeCommand: "systemd-inhibit",
			keepAwakeArgs: args,
		});
});
