// ─── Playwright Config: Notification Reducer Indicators Tests ─────────────────
// Tests notification reducer → sidebar dots + AttentionBanner via WS mock.
// No real OpenCode or relay needed — serves built frontend via Vite preview.

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	testMatch: "notification-reducer-indicators.spec.ts",
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
		baseURL: "http://localhost:4173",
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
	],

	webServer: {
		command: "npx vite preview --port 4173 --strictPort",
		cwd: "../../",
		port: 4173,
		reuseExistingServer: !process.env["CI"],
		timeout: 15_000,
	},
});
