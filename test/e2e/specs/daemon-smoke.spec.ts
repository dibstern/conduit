// ─── Daemon Smoke E2E Tests ──────────────────────────────────────────────────
// Full integration tests using a real Daemon pointed at a real OpenCode server.
// Verifies: SPA loading, WS connection, instance_list delivery, health auth,
// and that the "No healthy OpenCode instances" banner does not appear.
//
// Uses the daemon-fixtures.ts harness (worker-scoped Daemon).
// No WS mocks — everything is real.

import { expect, test } from "../helpers/daemon-fixtures.js";

test.describe("Daemon Smoke", () => {
	test("browser connects via WS and receives instance_list", async ({
		page,
		daemonProjectUrl,
	}) => {
		await page.goto(daemonProjectUrl);

		// SPA should load
		await expect(page).toHaveTitle("OpenCode Relay", { timeout: 10_000 });

		// Connect overlay should disappear once WS connects and initClient runs.
		// initClient sends instance_list, session_list, etc. The overlay fades
		// out over 600ms once connected=true, then sets display:none.
		await page.locator(".connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		// The "No healthy OpenCode instances" banner must NOT appear.
		// This proves the daemon's auth-aware health checker works: it sends
		// OPENCODE_SERVER_PASSWORD in the health poll, gets 200 (not 401),
		// and reports the instance as healthy.
		//
		// We target .banner-text specifically (not getByText) because the
		// rendered chat content may contain text mentioning the banner string,
		// causing a strict-mode violation with getByText.
		const banner = page.locator(".banner-text", {
			hasText: "No healthy OpenCode instances",
		});
		await expect(banner).not.toBeVisible({ timeout: 5_000 });

		// Chat input should be visible — full pipeline is working
		await expect(page.locator("#input")).toBeVisible({ timeout: 5_000 });
	});

	test("instance badge is hidden with single instance", async ({
		page,
		daemonProjectUrl,
	}) => {
		// With only one instance ("Default"), the header intentionally hides
		// the instance badge (Header.svelte: instances.length <= 1 → undefined).
		// This is correct UX — no badge clutter for single-instance setups.
		await page.goto(daemonProjectUrl);

		// Wait for page to fully load
		await page.locator(".connect-overlay").waitFor({
			state: "hidden",
			timeout: 15_000,
		});

		const badge = page.locator("[data-testid='instance-badge']");
		await expect(badge).not.toBeVisible();
	});
});
