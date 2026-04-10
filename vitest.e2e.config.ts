import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		setupFiles: ["test/setup.ts"],
		include: ["test/e2e/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		pool: "threads",
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
		},
	},
});
