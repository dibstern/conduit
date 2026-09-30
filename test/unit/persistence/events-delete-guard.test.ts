import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, "src");
const EVENTS_DELETE = /\bdelete\s+from\s+events\b/gi;

// Failure modes: catch case and whitespace changes, including multiline SQL in
// template literals; reject a second delete even in an allowed file; reject a
// stale exception if its reviewed call site disappears. Only actual source
// sites belong here, each with a reason for destroying event history.
const ALLOWED_DELETES = [
	{
		path: "src/lib/persistence/effect/migrations.ts",
		statement: /^delete\s+from\s+events\s+where\s+session_id\s*=\s*\$\{id\}`;/i,
		reason:
			"Migration 0010 removes only pre-2026-07-15 OpenCode sessions with no messages; the 25-session limit and message FK backstop protect real conversations while clearing broken legacy skeletons.",
	},
];

interface Source {
	path: string;
	text: string;
}

function sourceFiles(dir: string): Source[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(file);
		if (
			!/\.(?:ts|tsx|js|mjs|cjs|svelte|sql|mdx|css|json|html|svg|webmanifest)$/.test(
				entry.name,
			)
		)
			return [];
		return [
			{ path: relative(REPO_ROOT, file), text: readFileSync(file, "utf8") },
		];
	});
}

function scan(sources: Source[]) {
	const seen = new Map<string, number>();
	const violations: string[] = [];
	for (const { path, text } of sources) {
		for (const match of text.matchAll(EVENTS_DELETE)) {
			const offset = match.index ?? 0;
			const line = text.slice(0, offset).split("\n").length;
			const allowed = ALLOWED_DELETES.find(
				(entry) =>
					entry.path === path && entry.statement.test(text.slice(offset)),
			);
			if (allowed) {
				seen.set(path, (seen.get(path) ?? 0) + 1);
			} else {
				violations.push(`${path}:${line}`);
			}
		}
	}
	for (const { path, reason } of ALLOWED_DELETES) {
		if (seen.get(path) !== 1) {
			violations.push(
				`${path}: allowed delete must have one live site (${reason})`,
			);
		}
	}
	return violations;
}

describe("permanent event log", () => {
	it("rejects events-table deletes outside reviewed migration cleanup", () => {
		expect(scan(sourceFiles(SRC_ROOT))).toEqual([]);
	});

	it("detects mixed-case, multiline template SQL and cannot pass vacuously", () => {
		expect(
			scan([
				{
					path: "src/lib/persistence/effect/migrations.ts",
					text: `yield* sql\`DELETE FROM events WHERE session_id = \${id}\`;`,
				},
				{
					path: "src/lib/persistence/new-cleanup.ts",
					text: `sql\`dElEtE\n  FrOm\tEvEnTs WHERE created_at < \${cutoff}\``,
				},
			]),
		).toEqual(["src/lib/persistence/new-cleanup.ts:1"]);
		expect(scan([])[0]).toContain("allowed delete must have one live site");
		expect(
			scan([
				{
					path: "src/lib/persistence/effect/migrations.ts",
					text: `yield* sql\`DELETE FROM events WHERE session_id = \${id}\`;\nsql\`DELETE FROM events WHERE created_at < 1\`;`,
				},
			]),
		).toEqual(["src/lib/persistence/effect/migrations.ts:2"]);
	});
});
