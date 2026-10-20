import type { Page } from "@playwright/test";
import {
	ClaudeSettingsResolveError,
	ClaudeSettingsTrustBoundaryError,
} from "../../../src/lib/contracts/claude-settings.js";
import {
	AccountUnroutable,
	type UsageLimitsSetting,
} from "../../../src/lib/contracts/limit-recovery.js";
import {
	SetPinRejected,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { MOCK_SERVER_STATUS, mockWsRpc } from "../helpers/rpc-mock.js";
import { chooseSettingsOption } from "../helpers/settings.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ viewport: { width: 1440, height: 900 } });

// A refused save must restore the confirmed setting and show the server's
// declared reason. PIN rejection must also clear only the wrong current PIN.
async function openSettings(page: Page, baseUrl: string, stubs: StubTable) {
	const projectSlug = "e2e-replay";
	const rpc = await mockWsRpc(page, {
		stubs: {
			GetAutoSettleSetting: () => ({ autoSettleAfterDays: 3 }),
			GetStatus: () => ({ ...MOCK_SERVER_STATUS, pinEnabled: true }),
			GetClaudeSettings: () => ({ projectSlug, overrides: {} }),
			ResolveClaudeSettings: () => ({
				projectSlug,
				instanceId: "claude",
				resolved: {
					attribution: {},
					autoCompactEnabled: { value: true, source: "user" },
					autoCompactWindow: {},
					cleanupPeriodDays: {},
					disableAllHooks: {},
					alwaysThinkingEnabled: {},
				},
			}),
			...stubs,
		},
	});
	await mockRelayWebSocket(page, {
		initMessages: [
			{
				type: "project_list",
				projects: [
					{
						slug: projectSlug,
						title: projectSlug,
						folders: ["/tmp/e2e-replay"],
					},
				],
				current: projectSlug,
			},
			{
				type: "shell_snapshot",
				roots: true,
				sessions: [
					{
						id: "settings-errors",
						title: "Settings",
						status: "idle",
						accountId: "claude",
						projectSlug,
					},
				],
			},
		],
		responses: new Map(),
	});
	rpc.setDaemonList("SubscribeInstances", {
		instances: [
			{
				id: "claude",
				name: "Claude",
				driver: "claude",
				isDefault: true,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
			},
		],
	});
	await page.goto(`${baseUrl}/s/settings-errors`);
	await expect(page.locator("#input")).toBeVisible();
	await page.getByTestId("session-bar-overflow").click();
	await page.getByTestId("overflow-settings").click();
	return rpc;
}

test("Claude settings trust rejection restores the value and shows its declared reason", async ({
	page,
	harness,
}, testInfo) => {
	const message = "This setting is managed by your organisation.";
	const rpc = await openSettings(page, harness.relayBaseUrl, {
		SetClaudeSettings: () => {
			throw new ClaudeSettingsTrustBoundaryError({
				key: "autoCompactEnabled",
				message,
			});
		},
	});
	await page.getByTestId("settings-tab-claude").click();
	const toggle = page
		.getByTestId("claude-setting-autoCompactEnabled")
		.getByRole("switch");
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await toggle.click();
	const request = await rpc.waitForRequest(
		({ tag }) => tag === "SetClaudeSettings",
	);
	expect(request.payload).toMatchObject({
		projectSlug: "e2e-replay",
		overrides: { autoCompactEnabled: false },
	});
	const toast = page
		.getByTestId("toast")
		.filter({ hasText: "Failed to save Claude settings" });
	await expect(toast).toContainText(message);
	await expect(toast).toHaveAttribute("data-variant", "warn");
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await page.screenshot({
		path: testInfo.outputPath("claude-settings-rejection.png"),
	});
});

for (const failure of [
	new ClaudeSettingsResolveError({
		reason: "timeout",
		message: "Settings resolution timed out.",
	}),
	new AccountUnroutable({ ref: { _tag: "Id", id: "claude" } }),
]) {
	test(`${failure._tag} keeps Claude settings resolution unavailable`, async ({
		page,
		harness,
	}, testInfo) => {
		const rpc = await openSettings(page, harness.relayBaseUrl, {
			ResolveClaudeSettings: () => {
				throw failure;
			},
		});
		await page.getByTestId("settings-tab-claude").click();
		const request = await rpc.waitForRequest(
			({ tag }) => tag === "ResolveClaudeSettings",
		);
		expect(request.payload).toMatchObject({
			sessionId: "settings-errors",
			instanceId: "claude",
		});
		expect(request.payload).not.toHaveProperty("projectSlug");
		await expect(
			page.getByTestId("claude-setting-autoCompactEnabled-provenance"),
		).toContainText("Couldn't read settings files");
		await expect(page.getByTestId("toast")).toHaveCount(0);
		await page.screenshot({
			path: testInfo.outputPath("claude-settings-unavailable.png"),
		});
	});
}

for (const reason of ["wrong_pin", "locked_out"] as const) {
	test(`PIN ${reason} uses shared copy and preserves the editor`, async ({
		page,
		harness,
	}, testInfo) => {
		await openSettings(page, harness.relayBaseUrl, {
			SetPin: () => {
				throw new SetPinRejected({ reason, retryAfterSeconds: 125 });
			},
		});
		await page.getByTestId("settings-tab-server").click();
		await page.getByTestId("server-pin-change-btn").click();
		const current = page.getByTestId("server-pin-current");
		await current.fill("9999");
		await page.getByTestId("server-pin-new").fill("482615");
		await page.getByTestId("server-pin-confirm").fill("482615");
		await page.getByTestId("server-pin-save").click();
		await expect(page.getByTestId("server-pin-error")).toHaveText(
			reason === "wrong_pin"
				? "Wrong PIN. Try again."
				: "Too many tries. Try again in 3 minutes.",
		);
		await expect(current).toHaveValue(reason === "wrong_pin" ? "" : "9999");
		if (reason === "wrong_pin") await expect(current).toBeFocused();
		await expect(page.getByTestId("server-pin-new")).toHaveValue("482615");
		await expect(page.getByTestId("server-pin-confirm")).toHaveValue("482615");
		await page.screenshot({ path: testInfo.outputPath(`pin-${reason}.png`) });
	});
}

test("refused log-level change restores the selected level and shows the server reason", async ({
	page,
	harness,
}, testInfo) => {
	await openSettings(page, harness.relayBaseUrl, {
		SetLogLevel: () => {
			throw new WsRpcError({ message: "The server refused this log level." });
		},
	});
	await page.getByTestId("settings-tab-server").click();
	const logs = page.getByTestId("server-logs-group");
	await logs.getByRole("button", { name: /^Logs\b/ }).click();
	const select = logs.getByRole("button", { name: /^Log level\b/ });
	await chooseSettingsOption(page, select, "debug");
	await expect(page.locator("#server-log-level-error")).toHaveText(
		"The server refused this log level.",
	);
	await expect(select).toHaveAttribute("data-value", "info");
	await page.screenshot({
		path: testInfo.outputPath("log-level-rejection.png"),
	});
});

for (const failFirst of [false, true]) {
	test(`usage saves stay ordered across mounts after ${failFirst ? "rejection" : "success"}`, async ({
		page,
		harness,
	}, testInfo) => {
		let saved: UsageLimitsSetting = {
			autoResume: false,
			autoSwitch: false,
			warnAt: 80,
			order: [],
		};
		let release: (() => void) | undefined;
		const writes: boolean[] = [];
		const rpc = await openSettings(page, harness.relayBaseUrl, {
			GetUsageLimitsSetting: () => ({ usageLimits: saved }),
			SetUsageLimitsSetting: ({ usageLimits }) => {
				writes.push(usageLimits.autoResume);
				if (writes.length === 1)
					return new Promise<{ usageLimits: UsageLimitsSetting }>(
						(resolve, reject) => {
							release = () => {
								if (failFirst)
									reject(
										new WsRpcError({ message: "The first save was refused." }),
									);
								else resolve({ usageLimits: (saved = usageLimits) });
							};
						},
					);
				saved = usageLimits;
				return { usageLimits };
			},
		});
		await page.getByTestId("settings-tab-usage").click();
		const toggle = page.locator("#usage-limit-settings").getByRole("switch", {
			name: "Toggle auto-resume limited sessions",
			exact: true,
		});
		await expect(toggle).toBeEnabled();
		await toggle.click();
		await rpc.waitForRequest(({ tag }) => tag === "SetUsageLimitsSetting");
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await page.getByTestId("settings-tab-general").click();
		await page.getByTestId("settings-tab-usage").click();
		await expect(toggle).toBeDisabled();
		expect(writes).toEqual([true]);
		if (!release) throw new Error("The first usage save was not captured");
		release();
		await expect(toggle).toBeEnabled();
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		expect(writes).toEqual([true, false]);
		if (failFirst)
			await expect(
				page
					.getByTestId("toast")
					.filter({ hasText: "Couldn't save usage limit settings" }),
			).toContainText("The first save was refused.");
		await toggle.click();
		await expect.poll(() => writes).toEqual([true, false, true]);
		await page.getByTestId("settings-tab-general").click();
		await page.getByTestId("settings-tab-usage").click();
		await expect(toggle).toBeEnabled();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await page.screenshot({
			path: testInfo.outputPath("ordered-usage-saves.png"),
		});
	});
}
