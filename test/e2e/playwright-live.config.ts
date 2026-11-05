// Runs the live smoke test that spawns an ephemeral OpenCode instance.
// Much longer timeouts since we're waiting for real API responses.
// NO webServer block — the test manages its own daemon via createE2EHarness.

import { defineConfig } from "@playwright/test";

// The daemon adds a signed-in host Codex as an account; keep it out of live runs.
process.env["CONDUIT_CODEX_BINARY"] ??= "/nonexistent/conduit-e2e/codex";

export default defineConfig({
	testDir: "./specs",
	testMatch: [
		"live-smoke.spec.ts",
		"live-surfacing.spec.ts",
		"live-provider-checks.spec.ts",
	],
	fullyParallel: false,
	forbidOnly: !!process.env["CI"],
	retries: 0,
	workers: 1,
	// require-tests-reporter fails a run where every test skipped (conduit-test-g49a).
	reporter: process.env["CI"]
		? [
				["github"],
				["html", { open: "never" }],
				["./helpers/require-tests-reporter.ts"],
			]
		: [["list"], ["./helpers/require-tests-reporter.ts"]],

	timeout: 120_000,
	expect: { timeout: 60_000 },

	use: {
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "off",
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
