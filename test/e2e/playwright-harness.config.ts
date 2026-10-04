import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./specs",
	testMatch: "harness-*.spec.ts",
	fullyParallel: true,
	forbidOnly: !!process.env["CI"],
	retries: 1,
	workers: "100%",
	reporter: process.env["CI"]
		? [
				["github"],
				["html", { open: "never" }],
				["./helpers/require-tests-reporter.ts"],
			]
		: [["list"], ["./helpers/require-tests-reporter.ts"]],
	timeout: 60_000,
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
	],
	// Each test's process harness serves the built frontend on its own port.
});
