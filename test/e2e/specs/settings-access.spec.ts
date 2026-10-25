import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";

import { ProcessHarness } from "../../helpers/process-harness.js";
import { closeSettings } from "../helpers/settings.js";
import { AppPage } from "../page-objects/app.page.js";

// A stand-in for the tailscale CLI, so the test never changes the real
// tailnet. It answers the four commands conduit runs and keeps the Serve
// mapping in a file beside itself, so it survives a daemon restart.
const FAKE_TAILSCALE = `#!/bin/sh
state="$0.json"
case "$*" in
"status --json") echo '{"BackendState":"Running","Self":{"DNSName":"fake.tailnet.ts.net."},"CertDomains":["fake.tailnet.ts.net"]}' ;;
"serve status --json") cat "$state" 2>/dev/null || echo '{}' ;;
"serve --bg "*) printf '{"Web":{"fake.tailnet.ts.net:%s":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "\${3#--https=}" "$5" >"$state" ;;
"serve --https="*) rm -f "$state" ;;
*) exit 1 ;;
esac
`;

const test = base.extend<{
	harness: ProcessHarness;
	serviceEnvironment: {
		CONDUIT_SERVICE: string;
		CONDUIT_TAILSCALE_BIN: string;
	};
}>({
	serviceEnvironment: async ({ browserName: _browserName }, use, testInfo) => {
		const bin = testInfo.outputPath("tailscale");
		writeFileSync(bin, FAKE_TAILSCALE);
		chmodSync(bin, 0o755);
		await use({ CONDUIT_SERVICE: "1", CONDUIT_TAILSCALE_BIN: bin });
	},
	harness: [
		async ({ serviceEnvironment }, use, testInfo) => {
			const harness = ProcessHarness.create({
				dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			});
			try {
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

async function openServerSettings(page: Page): Promise<void> {
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
	await expect(page.getByTestId("server-access-settings")).toBeVisible();
}

test("Access toggles Tailscale Serve, keeps it across a restart, and shows read-only startup settings", async ({
	page,
	harness,
	serviceEnvironment,
}, testInfo) => {
	const initial = await harness.requestRpc({ _tag: "GetStatus" });
	expect(initial.tailscaleServeAvailable).toBe(true);
	expect(initial.tailscaleServeEnabled ?? false).toBe(false);
	await new AppPage(page).mountWithoutProjects(harness);
	await openServerSettings(page);
	const toggle = page
		.getByTestId("server-access-settings")
		.getByRole("switch", { name: "Toggle Tailscale Serve" });
	await expect(toggle).toHaveAttribute("aria-checked", "false");

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(toggle).toBeEnabled();
	await expect(page.getByTestId("server-tailscale-error")).toHaveCount(0);
	const url = `https://fake.tailnet.ts.net:${initial.port}`;
	await expect(toggle).toContainText(url);
	const saved = await harness.requestRpc({ _tag: "GetStatus" });
	expect(saved.projects).toEqual([]);
	expect(saved.tailscaleServeEnabled).toBe(true);
	expect(saved.tailscaleServe).toEqual({ url });

	// Restart checks the stored choice; reload discards the browser snapshot.
	await closeSettings(page);
	await harness.shutdown();
	await harness.restart({
		keepPort: true,
		startupTimeoutMs: 60_000,
		serviceEnvironment,
		// The fixture removed the default project, so there is no relay to probe.
		skipBrowserProbe: true,
	});
	expect((await harness.requestRpc({ _tag: "GetStatus" })).projects).toEqual(
		[],
	);
	await new AppPage(page).mountWithoutProjects(harness, async () => {
		await page.reload();
	});
	await openServerSettings(page);
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(toggle).toContainText(url);

	const startup = page.getByTestId("server-startup-settings");
	const disclosure = startup.getByRole("button", {
		name: "Set when conduit starts Port · host · HTTPS · more",
	});
	await expect(disclosure).toHaveAttribute("aria-expanded", "false");
	await expect(page.getByTestId("server-startup-port")).toHaveCount(0);
	await disclosure.click();
	await expect(disclosure).toHaveAttribute("aria-expanded", "true");
	await expect(startup).toContainText(
		"Change these from the terminal, then restart.",
	);
	for (const [id, label, flag, value] of [
		["port", "Port", "--port", String(initial.port)],
		["host", "Host", "--host", initial.host],
		["https", "HTTPS", "--no-https", initial.tlsEnabled ? "On" : "Off"],
		[
			"login",
			"Start at login",
			"conduit service install",
			initial.supervised ? "Installed" : "Not installed",
		],
	] as const) {
		const row = page.getByTestId(`server-startup-${id}`);
		await expect(row).toContainText(label);
		await expect(row).toContainText(flag);
		await expect(row).toContainText(value);
		await expect(row.locator("input, select, textarea, button")).toHaveCount(0);
	}
	await expect(startup).not.toContainText("skip-permissions");
	await disclosure.evaluate((element) => element.blur());
	await startup.scrollIntoViewIfNeeded();
	const artifacts = resolve("test-results/settings-access");
	mkdirSync(artifacts, { recursive: true });
	const screenshot = await page.screenshot({
		path: resolve(artifacts, `${testInfo.project.name}-access.png`),
		animations: "disabled",
	});
	await testInfo.attach("settings-access", {
		body: screenshot,
		contentType: "image/png",
	});
});
