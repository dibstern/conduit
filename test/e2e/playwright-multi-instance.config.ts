// ─── Playwright Config: Multi-Instance Tests ────────────────────────────────
// Tests all multi-instance UI features via WS mock.
// No real OpenCode or relay needed — serves built frontend via Vite preview.

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	testMatch: "multi-instance.spec.ts",
	fullyParallel: true,
	forbidOnly: !!process.env["CI"],
	retries: 1,
	workers: "100%",
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
		{
			name: "mobile",
			use: {
				viewport: { width: 393, height: 852 },
				isMobile: true,
				hasTouch: true,
			},
		},
	],

	webServer: {
		command: "pnpm exec vite preview --port 4173 --strictPort",
		cwd: "../../",
		port: 4173,
		reuseExistingServer: !process.env["CI"],
		timeout: 15_000,
	},
});
