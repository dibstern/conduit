import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("has no runtime fork sidecar reader, cache, or subscription join", () => {
	const root = join(process.cwd(), "src");
	const hits = readdirSync(root, { recursive: true })
		.filter(
			(path): path is string =>
				typeof path === "string" && path.endsWith(".ts"),
		)
		.filter((path) =>
			/loadForkMetadata|saveForkMetadata|\bforkMeta\b|withForkLineage/.test(
				readFileSync(join(root, path), "utf8"),
			),
		);
	expect(hits).toEqual([]);
	const sidecarReaders = readdirSync(root, { recursive: true })
		.filter(
			(path): path is string =>
				typeof path === "string" && path.endsWith(".ts"),
		)
		.filter((path) =>
			readFileSync(join(root, path), "utf8").includes("fork-metadata.json"),
		);
	expect(sidecarReaders).toEqual([
		"lib/persistence/migrations/0017_fork_lineage.ts",
	]);
});
