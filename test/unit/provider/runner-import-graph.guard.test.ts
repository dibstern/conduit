import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const directory = join(process.cwd(), "src/lib/provider/runner");

describe("runner import graph", () => {
	it("has no runtime import cycle between runner modules", () => {
		const graph = new Map(
			readdirSync(directory)
				.filter((name) => name.endsWith(".ts"))
				.map((name) => {
					const parsed = ts.createSourceFile(
						name,
						readFileSync(join(directory, name), "utf8"),
						ts.ScriptTarget.Latest,
					);
					// Type-only imports are erased, so only runtime edges can cycle.
					const targets = parsed.statements.flatMap((statement) => {
						const runtime = ts.isImportDeclaration(statement)
							? !statement.importClause ||
								(!statement.importClause.isTypeOnly &&
									(statement.importClause.name !== undefined ||
										!statement.importClause.namedBindings ||
										ts.isNamespaceImport(
											statement.importClause.namedBindings,
										) ||
										statement.importClause.namedBindings.elements.some(
											(element) => !element.isTypeOnly,
										)))
							: ts.isExportDeclaration(statement) && !statement.isTypeOnly;
						const specifier =
							(ts.isImportDeclaration(statement) ||
								ts.isExportDeclaration(statement)) &&
							statement.moduleSpecifier &&
							ts.isStringLiteral(statement.moduleSpecifier)
								? statement.moduleSpecifier.text
								: "";
						return runtime && specifier.startsWith("./")
							? [specifier.slice(2).replace(/\.js$/, ".ts")]
							: [];
					});
					return [name, targets] as const;
				}),
		);
		const cycles: string[] = [];
		const finished = new Set<string>();
		const visit = (name: string, trail: readonly string[]): void => {
			if (trail.includes(name)) {
				cycles.push([...trail.slice(trail.indexOf(name)), name].join(" -> "));
				return;
			}
			if (finished.has(name)) return;
			for (const target of graph.get(name) ?? [])
				visit(target, [...trail, name]);
			finished.add(name);
		};
		for (const name of [...graph.keys()].sort()) visit(name, []);
		expect(cycles).toEqual([]);
	});
});
