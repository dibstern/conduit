import { resolve } from "node:path";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [svelte(), tailwindcss()],
	test: {
		projects: [
			{
				extends: true,
				plugins: [
					storybookTest({ configDir: resolve(__dirname, ".storybook") }),
				],
				test: {
					name: "storybook",
					browser: {
						enabled: true,
						headless: true,
						provider: "playwright",
						instances: [{ browser: "chromium" }],
					},
					setupFiles: [resolve(__dirname, ".storybook/vitest.setup.ts")],
				},
			},
		],
	},
});
