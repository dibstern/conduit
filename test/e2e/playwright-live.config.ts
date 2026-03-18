// ─── Playwright Config: Live Smoke Tests ──────────────────────────────────────
// Runs the live smoke test that spawns an ephemeral OpenCode instance.
// Much longer timeouts since we're waiting for real API responses.
// NO webServer block — the test manages its own relay via createE2EHarness.

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	testMatch: ["live-smoke.spec.ts"],
	fullyParallel: false,
	forbidOnly: !!process.env["CI"],
	retries: 0,
	workers: 1,
	reporter: process.env["CI"]
		? [["github"], ["html", { open: "never" }]]
		: "list",

	timeout: 120_000,
	expect: { timeout: 60_000 },

	use: {
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},

	projects: [
		{
			name: "desktop",
			use: {
				viewport: { width: 1440, height: 900 },
				isMobile: false,
			},
		},
	],
});
