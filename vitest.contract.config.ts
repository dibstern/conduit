import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/contract/**/*.contract.ts"],
		testTimeout: 30_000,
		hookTimeout: 15_000,
		// Contract tests run sequentially since they share a real server
		pool: "forks",
		poolOptions: { forks: { singleFork: true } },
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
		},
	},
});
