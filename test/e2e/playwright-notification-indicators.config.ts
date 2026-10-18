// Tests server-derived session rows → sidebar dots + AttentionBanner via WS mock.
// No real OpenCode or relay needed — serves built frontend via Vite preview.

import { defineConfig } from "@playwright/test";

const port = Number(process.env["ACCEPTANCE_PORT"] ?? 4173);

export default defineConfig({
	testDir: "./specs",
	testMatch: "notification-indicators.spec.ts",
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
		baseURL: `http://localhost:${port}`,
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
	],

	webServer: {
		command: `pnpm exec vite preview --port ${port} --strictPort`,
		cwd: "../../",
		port,
		reuseExistingServer: false,
		timeout: 15_000,
	},
});
