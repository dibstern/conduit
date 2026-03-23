import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [svelte()],
	test: {
		// Component tests need jsdom + browser resolve condition so
		// Svelte resolves to its client bundle (which provides mount()).
		// All other tests run in the default node environment.
		projects: [
			{
				extends: true,
				test: {
					name: "components",
					include: ["test/unit/components/**/*.test.ts"],
					environment: "jsdom",
					testTimeout: 10_000,
					hookTimeout: 10_000,
				},
				resolve: {
					conditions: ["browser"],
				},
			},
			{
				extends: true,
				test: {
					name: "unit",
					include: ["test/unit/**/*.test.ts", "test/fixture/**/*.test.ts"],
					exclude: ["test/unit/components/**/*.test.ts"],
					testTimeout: 10_000,
					hookTimeout: 10_000,
				},
			},
			{
				extends: true,
				test: {
					name: "build",
					include: ["test/build/**/*.test.ts"],
					testTimeout: 10_000,
					hookTimeout: 10_000,
				},
			},
		],
		coverage: {
			provider: "v8",
			include: [
				"src/lib/instance-manager.ts",
				"src/lib/daemon.ts",
				"src/lib/daemon-ipc.ts",
				"src/lib/ipc-protocol.ts",
				"src/lib/client-init.ts",
				"src/lib/config-persistence.ts",
				"src/lib/frontend/stores/instance.svelte.ts",
				"src/bin/cli-utils.ts",
				"src/bin/cli-core.ts",
				"src/lib/shared-types.ts",
			],
			reporter: ["text", "json-summary"],
			thresholds: {
				lines: 70,
				branches: 60,
			},
		},
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
		},
	},
});
