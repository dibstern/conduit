import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/integration/**/*.integration.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		// Sequential — tests share the OpenCode server and can interfere
		pool: "forks",
		poolOptions: { forks: { singleFork: true } },
	},
});
