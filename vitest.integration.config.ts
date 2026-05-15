import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		setupFiles: ["test/setup.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// Run all files sequentially — integration tests spin up real servers
		// and must not compete for resources.
		fileParallelism: false,
		include: [
			"test/integration/**/*.integration.ts",
			"test/integration/**/*.test.ts",
		],
		exclude: ["**/node_modules/**", "**/dist/**"],
		pool: "threads",
	},
});
