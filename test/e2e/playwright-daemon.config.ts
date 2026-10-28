// Tests that require a real Daemon + real OpenCode instance.
// No vite preview — the Daemon serves the built frontend from dist/frontend/.
//
// Prerequisites:
//   - OpenCode running at localhost:4096
//   - OPENCODE_SERVER_PASSWORD set
//   - Project built (`pnpm run build`)

import { defineConfig } from "@playwright/test";

// CI has no codex binary. Missing it locally too keeps test daemons from
// cloning plugins off the network into the fixture root (conduit-test-lnm8.27).
process.env["CONDUIT_CODEX_BINARY"] ??= "/nonexistent/conduit-e2e/codex";

export default defineConfig({
	testDir: "./specs",
	testMatch: "daemon-*.spec.ts",
	fullyParallel: true,
	forbidOnly: !!process.env["CI"],
	// The retry only labels a failure flaky with a trace; CI still fails on it.
	retries: 1,
	failOnFlakyTests: !!process.env["CI"],
	workers: "100%",
	// require-tests-reporter fails a run where every test skipped (conduit-test-g49a).
	reporter: process.env["CI"]
		? [
				["github"],
				["html", { open: "never" }],
				["./helpers/require-tests-reporter.ts"],
			]
		: [["list"], ["./helpers/require-tests-reporter.ts"]],

	timeout: 30_000,
	expect: { timeout: 10_000 },

	use: {
		trace: "on-first-retry",
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
		{
			name: "mobile",
			use: {
				viewport: { width: 393, height: 852 },
				isMobile: true,
				hasTouch: true,
			},
		},
	],

	// No webServer — the daemon serves its own HTTP + static files
});
