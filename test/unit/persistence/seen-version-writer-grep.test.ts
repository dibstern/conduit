import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, "src");

// The single writer of per-viewer read state (ADR-0004, scope amendment).
const SESSION_ATTENTION = "src/lib/domain/relay/Services/session-attention.ts";

// An assignment (`seen_version = ...`, `seen_version=...`) or an INSERT that
// names the column. Reads (`seen_version` in a SELECT or a generated-column
// expression) do not match.
const SEEN_VERSION_WRITE =
	/\bseen_version\s*=(?!=)|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+sessions\s*\([^)]*\bseen_version\b/gi;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(?:ts|svelte|sql)$/.test(path) ? [path] : [];
	});
}

describe("seen_version single writer", () => {
	it("confines seen_version writes to SessionAttention", () => {
		const outside = sourceFiles(SRC_ROOT)
			.map((file) => ({ file, path: relative(REPO_ROOT, file) }))
			.filter(({ path }) => path !== SESSION_ATTENTION)
			.flatMap(({ file, path }) =>
				[...readFileSync(file, "utf8").matchAll(SEEN_VERSION_WRITE)].map(
					(match) => ({ path, source: match[0] }),
				),
			);

		const rule = `seen_version is durable per-viewer read state. It is not rebuilt from events, so no projector, recovery, import or migration may write it: a second writer can lower it or reset it, and a reply the user never saw would lose its dot.

Write it through SessionAttention (${SESSION_ATTENTION}), which caps at last_turn_end_version, never lowers it except for an explicit mark-unread, and stamps the row so every client sees the change.

See docs/adr/0004-session-mutations-are-canonical-events.md (Scope, amended 2026-09-26).`;

		expect(outside, rule).toEqual([]);
	});

	it("keeps the writer honest: SessionAttention still writes seen_version", () => {
		// Without this, moving the writer would make the rule above pass
		// vacuously.
		const writer = readFileSync(join(REPO_ROOT, SESSION_ATTENTION), "utf8");
		expect(writer.match(SEEN_VERSION_WRITE)?.length ?? 0).toBeGreaterThan(0);
	});
});
