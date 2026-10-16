import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, "src");

// The projector owns event-to-containment and event-to-lineage placement.
const SESSION_HANDLERS = "src/lib/persistence/projectors/session-handlers.ts";
// Migrations own schema changes and one-time placement upgrades.
const MIGRATIONS = "src/lib/persistence/migrations/";
const CONTAINMENT_SEEDERS = new Set([
	// seedClaudeSubagentSession seeds provider-discovered subagent containment.
	"src/lib/persistence/effect/claude-event-persist-effect.ts",
	// Provider import seeds existing subagent containment, never fork lineage.
	"src/lib/persistence/effect/session-seeder-effect.ts",
]);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const file = join(dir, entry);
		if (statSync(file).isDirectory()) return sourceFiles(file);
		return /\.(?:ts|svelte|sql)$/.test(file) ? [file] : [];
	});
}

// Restrict assignments to UPDATEs of sessions, so messages.parent_id and
// containment reads cannot be mistaken for placement writes.
const placementWrites = (source: string, column: string) =>
	[
		...source.matchAll(
			/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+sessions\s*\(([^)]*)\)|UPDATE\s+sessions\s+SET\b([^;`]*)/gi,
		),
	].filter((match) =>
		match[1] !== undefined
			? new RegExp(`\\b${column}\\b`, "i").test(match[1])
			: new RegExp(`\\b${column}\\s*=(?!=)`, "i").test(
					(match[2] ?? "").split(/\bWHERE\b/i)[0] ?? "",
				),
	);

describe("session placement writers", () => {
	it.each([
		"parent_id",
		"forked_from",
	])("confines sessions.%s writes to the placement owner", (column) => {
		const outside = sourceFiles(SRC_ROOT)
			.map((file) => ({ file, path: relative(REPO_ROOT, file) }))
			.filter(
				({ path }) =>
					path !== SESSION_HANDLERS &&
					!path.startsWith(MIGRATIONS) &&
					!(column === "parent_id" && CONTAINMENT_SEEDERS.has(path)),
			)
			.flatMap(({ file, path }) =>
				placementWrites(readFileSync(file, "utf8"), column).map((match) => ({
					path,
					source: match[0],
				})),
			);

		expect(
			outside,
			"Placement belongs to session-handlers.ts; containment seeders cannot write lineage (ADR-0006).",
		).toEqual([]);
	});

	it.each([
		"parent_id",
		"forked_from",
	])("keeps the owner honest: session-handlers.ts writes %s", (column) => {
		const writer = readFileSync(join(REPO_ROOT, SESSION_HANDLERS), "utf8");
		expect(placementWrites(writer, column).length).toBeGreaterThan(0);
	});

	it("recognizes session INSERTs and UPDATEs, excluding message parents and reads", () => {
		for (const column of ["parent_id", "forked_from"]) {
			expect(
				placementWrites(
					`INSERT INTO sessions (id, ${column}) VALUES (?, ?)`,
					column,
				),
			).toHaveLength(1);
			expect(
				placementWrites(
					`UPDATE sessions SET title = ?, ${column} = ? WHERE id = ?`,
					column,
				),
			).toHaveLength(1);
			expect(
				placementWrites(
					`INSERT INTO messages (id, ${column}) VALUES (?, ?); UPDATE messages SET ${column} = ?`,
					column,
				),
			).toHaveLength(0);
			expect(
				placementWrites(
					`SELECT ${column} FROM sessions; UPDATE sessions SET title = ? WHERE ${column} = ?`,
					column,
				),
			).toHaveLength(0);
		}
	});
});
