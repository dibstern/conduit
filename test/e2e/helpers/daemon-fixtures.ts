// ─── Daemon Playwright Fixtures ──────────────────────────────────────────────
// Custom test fixtures providing a real Daemon E2E harness to specs.
// Each test gets a daemon. Keeping the fixture test-scoped lets Playwright mark
// tests skipped when the optional live OpenCode dependency is unavailable.
//
// Auto-skips when OpenCode is not running or OPENCODE_SERVER_PASSWORD is unset.
// Tests using these fixtures connect directly to the daemon's HTTP server —
// no vite preview or WS mocks involved.

import { test as base } from "@playwright/test";
import {
	createDaemonHarness,
	type DaemonHarness,
	isOpenCodeReachable,
} from "./daemon-harness.js";

const OPENCODE_URL = process.env["OPENCODE_URL"] ?? "http://localhost:4096";

export const test = base.extend<{
	isNarrow: boolean;
	daemonHarness: DaemonHarness;
	daemonBaseUrl: string;
	daemonProjectUrl: string;
	daemonProjectPath: string;
}>({
	daemonHarness: async ({ browserName: _browserName }, use, testInfo) => {
		const available = await isOpenCodeReachable(OPENCODE_URL);
		if (!available) {
			testInfo.skip(true, `OpenCode is not running at ${OPENCODE_URL}`);
			return;
		}
		if (!process.env["OPENCODE_SERVER_PASSWORD"]) {
			testInfo.skip(true, "OPENCODE_SERVER_PASSWORD is not set");
			return;
		}
		const harness = await createDaemonHarness({ opencodeUrl: OPENCODE_URL });
		try {
			await use(harness);
		} finally {
			await harness.stop();
		}
	},

	daemonBaseUrl: async ({ daemonHarness }, use) => {
		await use(daemonHarness.baseUrl);
	},

	daemonProjectUrl: async ({ daemonHarness }, use) => {
		await use(daemonHarness.projectUrl);
	},

	daemonProjectPath: async ({ daemonHarness }, use) => {
		await use(daemonHarness.projectPath);
	},

	// Test-scoped: whether current viewport is narrow (mobile-like)
	isNarrow: async ({ page }, use) => {
		const viewport = page.viewportSize();
		await use(viewport ? viewport.width < 769 : false);
	},
});

export { expect } from "@playwright/test";
