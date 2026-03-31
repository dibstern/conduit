import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "**/*.spec.ts",
	timeout: 10_000,
	workers: 4,
	retries: 1,
	expect: {
		toHaveScreenshot: {
			maxDiffPixelRatio: 0.01,
		},
	},
	use: {
		baseURL: "http://localhost:6007",
		colorScheme: "dark",
	},
	webServer: {
		command: "pnpm exec http-server dist/storybook -p 6007 -s",
		port: 6007,
		reuseExistingServer: !process.env["CI"],
		cwd: process.cwd().replace(/\/test\/visual$/, ""),
	},
	projects: [
		{
			name: "desktop",
			use: { viewport: { width: 1440, height: 900 } },
		},
		{
			name: "mobile",
			use: { viewport: { width: 393, height: 852 } },
		},
	],
});
