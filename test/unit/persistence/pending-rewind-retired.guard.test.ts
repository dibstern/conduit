// 82tn.51 (lane 51 audit, failure mode 19): the pending rewind is retired. A head move lands at
// once and the next send tells the provider, so no reader of the old pending cut may come back.
// Only the migrations that add and then drop its column still name it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("has no pending rewind reader, column use or screen", () => {
	const root = join(process.cwd(), "src");
	expect(
		existsSync(join(root, "lib/persistence/effect/pending-rewind.ts")),
	).toBe(false);
	const hits = readdirSync(root, { recursive: true })
		.filter(
			(path): path is string =>
				typeof path === "string" && /\.(ts|svelte)$/.test(path),
		)
		.filter((path) =>
			/pending_rewind|pendingRewind|PendingRewind|pending-rewind|rewind-pending/.test(
				readFileSync(join(root, path), "utf8"),
			),
		)
		.sort();
	expect(hits).toEqual([
		"lib/persistence/effect/migrations.ts",
		"lib/persistence/schema.ts",
	]);
});
