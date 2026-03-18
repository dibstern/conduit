// ─── Playwright Config: Daemon E2E Tests ─────────────────────────────────────
// Tests that require a real Daemon + real OpenCode instance.
// No vite preview — the Daemon serves the built frontend from dist/frontend/.
//
// Prerequisites:
//   - OpenCode running at localhost:4096
//   - OPENCODE_SERVER_PASSWORD set
//   - Project built (`pnpm run build`)

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	testMatch: "daemon-*.spec.ts",
	fullyParallel: false,
	forbidOnly: !!process.env["CI"],
	retries: process.env["CI"] ? 1 : 0,
	workers: 1,
	reporter: process.env["CI"]
		? [["github"], ["html", { open: "never" }]]
		: "list",

	timeout: 30_000,
	expect: { timeout: 10_000 },

	use: {
		trace: "on-first-retry",
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
