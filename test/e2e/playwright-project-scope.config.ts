// Project scope: URL scoping, switching, the Add project dialog and removal.
// Uses WS mock — no real OpenCode or relay needed.

import { defineConfig } from "@playwright/test";

const port = Number(process.env["ACCEPTANCE_PORT"] ?? 4173);

export default defineConfig({
	testDir: "./specs",
	testMatch: "project-scope.spec.ts",
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
		// Never reuse: a busy 4173 is usually another worktree's build, and reuse
		// would test it silently. Busy port fails the run (conduit-test-g49a).
		reuseExistingServer: false,
		timeout: 15_000,
	},
});
