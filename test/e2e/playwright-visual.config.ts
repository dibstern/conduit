// ─── Playwright Config: Visual Tests ─────────────────────────────────────────
// Separate config for visual comparison tests (@visual).
// No real OpenCode or relay needed — serves built frontend via Vite preview,
// and WebSocket is mocked via page.routeWebSocket().

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	testMatch: "visual-mockup.spec.ts",
	fullyParallel: false,
	forbidOnly: !!process.env["CI"],
	retries: process.env["CI"] ? 1 : 0,
	workers: 1,
	reporter: process.env["CI"]
		? [["github"], ["html", { open: "never" }]]
		: "list",

	timeout: 30_000,
	expect: {
		timeout: 10_000,
		toHaveScreenshot: {
			// Allow up to 50 pixels of sub-pixel anti-aliasing noise
			// (50 / 1,296,000 = 0.004% — invisible to humans)
			maxDiffPixels: 50,
		},
	},

	use: {
		baseURL: "http://localhost:4173",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},

	// Desktop-only for visual tests (consistent viewport for comparison)
	projects: [
		{
			name: "desktop-visual",
			use: {
				viewport: { width: 1440, height: 900 },
				isMobile: false,
			},
		},
	],

	// Serve the built frontend with Vite preview (WS is mocked, no relay needed)
	webServer: {
		command: "npx vite preview --port 4173 --strictPort",
		cwd: "../../",
		port: 4173,
		reuseExistingServer: !process.env["CI"],
		timeout: 15_000,
	},
});
