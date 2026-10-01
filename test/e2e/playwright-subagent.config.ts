// Tests subagent session toggle and navigation via WS mock.
// No real OpenCode or relay needed — serves built frontend via Vite preview.

import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	testMatch: "subagent-sessions.spec.ts",
	fullyParallel: true,
	forbidOnly: !!process.env["CI"],
	retries: 1,
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
		baseURL: "http://localhost:4173",
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
		command: "pnpm exec vite preview --port 4173 --strictPort",
		cwd: "../../",
		port: 4173,
		// Never reuse: a busy 4173 is usually another worktree's build, and reuse
		// would test it silently. Busy port fails the run (conduit-test-g49a).
		reuseExistingServer: false,
		timeout: 15_000,
	},
});
