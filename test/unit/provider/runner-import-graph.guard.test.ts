import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const directory = join(process.cwd(), "src/lib/provider/runner");

const imports = new Map(
	readdirSync(directory)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => {
			const parsed = ts.createSourceFile(
				name,
				readFileSync(join(directory, name), "utf8"),
				ts.ScriptTarget.Latest,
			);
			const targets = parsed.statements.flatMap((statement) => {
				const runtime = ts.isImportDeclaration(statement)
					? !statement.importClause ||
						(!statement.importClause.isTypeOnly &&
							(statement.importClause.name !== undefined ||
								!statement.importClause.namedBindings ||
								ts.isNamespaceImport(statement.importClause.namedBindings) ||
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
				return specifier.startsWith("./")
					? [{ target: specifier.slice(2).replace(/\.js$/, ".ts"), runtime }]
					: [];
			});
			return [name, targets] as const;
		}),
);
// Type-only imports are erased, so only runtime edges can cycle or load a module.
const runtimeEdges = (name: string) =>
	(imports.get(name) ?? []).flatMap(({ target, runtime }) =>
		runtime ? [target] : [],
	);

describe("runner import graph", () => {
	it("has no runtime import cycle between runner modules", () => {
		const cycles: string[] = [];
		const finished = new Set<string>();
		const visit = (name: string, trail: readonly string[]): void => {
			if (trail.includes(name)) {
				cycles.push([...trail.slice(trail.indexOf(name)), name].join(" -> "));
				return;
			}
			if (finished.has(name)) return;
			for (const target of runtimeEdges(name)) visit(target, [...trail, name]);
			finished.add(name);
		};
		for (const name of [...imports.keys()].sort()) visit(name, []);
		expect(cycles).toEqual([]);
	});

	it("keeps Dispatch off the feeder", () => {
		// Dispatch names no feeder type, and loads no module that loads the feeder.
		const loaded = new Set<string>();
		const load = (name: string): void => {
			if (loaded.has(name)) return;
			loaded.add(name);
			for (const target of runtimeEdges(name)) load(target);
		};
		load("runner-dispatch.ts");
		expect({
			present: imports.has("runner-dispatch.ts"),
			direct: (imports.get("runner-dispatch.ts") ?? []).some(
				({ target }) => target === "runner-send-feeder.ts",
			),
			loaded: loaded.has("runner-send-feeder.ts"),
		}).toEqual({ present: true, direct: false, loaded: false });
	});
});
