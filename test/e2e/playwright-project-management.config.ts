// ─── Playwright Config: Project Management Tests ─────────────────────────────
// Tests directory autocomplete, project rename, and project delete flows.
// Uses WS mock — no real OpenCode or relay needed.

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	testMatch: "project-management.spec.ts",
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
	],

	webServer: {
		command: "pnpm exec vite preview --port 4173 --strictPort",
		cwd: "../../",
		port: 4173,
		reuseExistingServer: !process.env["CI"],
		timeout: 15_000,
	},
});
