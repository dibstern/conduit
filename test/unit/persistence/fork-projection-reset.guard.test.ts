import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const projections = ["sessions", "messages", "turns"] as const;
const persistence = join(process.cwd(), "src/lib/persistence");

// Fork creation reads all three projections. Rebuilding only one would read
// either stale source rows or source rows that have not been replayed yet.
const partialReset = (source: string) => {
	const sql = source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/--[^\n]*/g, " ")
		.toLowerCase()
		.replace(/\s+/g, " ");
	const reset = new Set<string>();
	for (const statement of sql.split(";")) {
		for (const table of projections) {
			if (
				new RegExp(`\\bdrop table(?: if exists)? [\x60"\\[]?${table}\\b`).test(
					statement,
				) ||
				new RegExp(`\\balter table \\S+ rename to [\x60"\\[]?${table}\\b`).test(
					statement,
				) ||
				new RegExp(
					`\\bdelete from [\x60"\\[]?${table}[\x60"\\]]?(?:\\s+where (?:1\\s*=\\s*1|true))?\\s*$`,
				).test(statement)
			)
				reset.add(table);
		}
		if (
			/\bdelete from projector_cursors\b/.test(statement) ||
			/\bupdate projector_cursors set last_applied_seq\s*=\s*0\b/.test(
				statement,
			)
		) {
			for (const table of projections) {
				const projector = table.slice(0, -1);
				if (
					!statement.includes(" where ") ||
					new RegExp(`['"]${projector}['"]`).test(statement)
				)
					reset.add(table);
			}
		}
	}
	return reset.size > 0 && reset.size < projections.length
		? projections.filter((table) => reset.has(table))
		: [];
};

const sqlStrings = (node: ts.Node) => {
	const statements: string[] = [];
	const visit = (child: ts.Node) => {
		if (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child))
			statements.push(child.text);
		else if (ts.isTemplateExpression(child))
			statements.push(child.getText().slice(1, -1));
		else ts.forEachChild(child, visit);
	};
	visit(node);
	return statements.join(";");
};

// Inspect each declaration and registry entry separately, so a reset in another
// migration cannot accidentally satisfy the rule. SQL files are checked below.
const codeMigrations = (path: string) => {
	const source = ts.createSourceFile(
		path,
		readFileSync(path, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	return source.statements.flatMap((statement) => {
		if (ts.isFunctionDeclaration(statement))
			return [
				{
					name: statement.name?.text ?? "anonymous",
					sql: sqlStrings(statement),
				},
			];
		if (!ts.isVariableStatement(statement)) return [];
		return statement.declarationList.declarations.flatMap((declaration) => {
			if (declaration.name.getText() !== "effectMigrationEntries")
				return [
					{ name: declaration.name.getText(), sql: sqlStrings(declaration) },
				];
			let initializer = declaration.initializer;
			if (initializer && ts.isSatisfiesExpression(initializer))
				initializer = initializer.expression;
			if (!initializer || !ts.isObjectLiteralExpression(initializer)) return [];
			return initializer.properties.map((property) => ({
				name: property.name?.getText() ?? "unknown migration",
				sql: sqlStrings(property),
			}));
		});
	});
};

describe("fork projection reset boundary", () => {
	it("resets session, message and turn projections together in every migration", () => {
		const migrations = [
			...readdirSync(join(persistence, "migrations"))
				.filter((name) => name.endsWith(".sql"))
				.map((name) => ({
					name,
					sql: readFileSync(join(persistence, "migrations", name), "utf8"),
				})),
			...codeMigrations(join(persistence, "effect/migrations.ts")),
			...codeMigrations(join(persistence, "schema.ts")),
		];
		expect(
			migrations.flatMap(({ name, sql }) => {
				const reset = partialReset(sql);
				return reset.length > 0 ? [{ migration: name, reset }] : [];
			}),
			"History-inheriting session.created reads source messages and turns while replaying sessions. Reset all three projections together.",
		).toEqual([]);
	});

	it.each([
		"DELETE\nFROM messages;",
		"drop table if exists turns;",
		"ALTER TABLE sessions_next RENAME TO sessions;",
		"DELETE FROM sessions WHERE 1 = 1;",
		"DELETE FROM projector_cursors WHERE projector_name = 'message';",
		"UPDATE projector_cursors SET last_applied_seq = 0 WHERE projector_name IN ('session', 'turn');",
	])("rejects a partial reset: %s", (sql) => {
		expect(partialReset(sql).length).toBeGreaterThan(0);
	});

	it("permits coordinated resets and bounded session removal", () => {
		expect(
			partialReset(
				"DELETE FROM sessions; DELETE FROM messages; DELETE FROM turns;",
			),
		).toEqual([]);
		expect(partialReset("DELETE FROM projector_cursors;")).toEqual([]);
		expect(
			partialReset(
				"DELETE FROM sessions WHERE id = ?; DELETE FROM turns WHERE session_id = ?;",
			),
		).toEqual([]);
		expect(partialReset("-- DROP TABLE sessions;\nSELECT 1;")).toEqual([]);
	});
});
