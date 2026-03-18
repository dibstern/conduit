// ─── Daemon Playwright Fixtures ──────────────────────────────────────────────
// Custom test fixtures providing a real Daemon E2E harness to specs.
// Worker-scoped: one daemon per test file.
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

export const test = base.extend<
	{ isNarrow: boolean },
	{
		daemonHarness: DaemonHarness;
		daemonBaseUrl: string;
		daemonProjectUrl: string;
		daemonProjectPath: string;
	}
>({
	// Worker-scoped: one daemon per test file
	daemonHarness: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature requires destructured first arg
		async ({}, use) => {
			const available = await isOpenCodeReachable();
			if (!available) {
				throw new Error(
					"OpenCode is not running at http://localhost:4096. Start it with: opencode serve",
				);
			}
			if (!process.env["OPENCODE_SERVER_PASSWORD"]) {
				throw new Error(
					"OPENCODE_SERVER_PASSWORD is not set. Required for daemon health checks.",
				);
			}
			const harness = await createDaemonHarness();
			await use(harness);
			await harness.stop();
		},
		{ scope: "worker", timeout: 30_000 },
	],

	// Convenience: daemon base URL
	daemonBaseUrl: [
		async ({ daemonHarness }, use) => {
			await use(daemonHarness.baseUrl);
		},
		{ scope: "worker" },
	],

	// Convenience: full project URL
	daemonProjectUrl: [
		async ({ daemonHarness }, use) => {
			await use(daemonHarness.projectUrl);
		},
		{ scope: "worker" },
	],

	// Convenience: project URL path (for page.goto with baseURL)
	daemonProjectPath: [
		async ({ daemonHarness }, use) => {
			await use(daemonHarness.projectPath);
		},
		{ scope: "worker" },
	],

	// Test-scoped: whether current viewport is narrow (mobile-like)
	isNarrow: async ({ page }, use) => {
		const viewport = page.viewportSize();
		await use(viewport ? viewport.width < 769 : false);
	},
});

export { expect } from "@playwright/test";
