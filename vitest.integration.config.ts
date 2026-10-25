import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

const maxWorkers = Number(process.env.CONDUIT_INTEGRATION_WORKERS ?? 4);
if (!Number.isSafeInteger(maxWorkers) || maxWorkers <= 0) {
	throw new Error("CONDUIT_INTEGRATION_WORKERS must be a positive integer");
}

export default defineConfig({
	plugins: [svelte()],
	test: {
		setupFiles: ["test/setup.ts"],
		env: {
			CONDUIT_TEST_DIST: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		},
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// Each file owns its servers and temp dirs, so files can run in parallel.
		// Cap workers to bound machine load.
		fileParallelism: true,
		maxWorkers,
		include: [
			"test/integration/**/*.integration.ts",
			"test/integration/**/*.test.ts",
		],
		exclude: ["**/node_modules/**", "**/dist/**"],
		pool: "forks",
	},
});
