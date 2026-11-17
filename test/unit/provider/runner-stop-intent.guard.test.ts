import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it("runner receipts cannot import process reads or accept an observation hook", () => {
	const source = ts.createSourceFile(
		"runner-receipts.ts",
		readFileSync("src/lib/provider/runner/runner-receipts.ts", "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const violations: string[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			if (/process-table|node:child_process/.test(node.moduleSpecifier.text))
				violations.push(node.moduleSpecifier.text);
			const bindings = node.importClause?.namedBindings;
			if (bindings && ts.isNamedImports(bindings))
				for (const binding of bindings.elements)
					if (
						/runnerProcessTable|runnerPidAlive/.test(
							(binding.propertyName ?? binding.name).text,
						)
					)
						violations.push(binding.getText(source));
		}
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require"))
		) {
			const specifier = node.arguments[0];
			if (
				specifier &&
				ts.isStringLiteral(specifier) &&
				/process-table|node:child_process/.test(specifier.text)
			)
				violations.push(specifier.text);
		}
		if (
			ts.isParameter(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === "observe"
		)
			violations.push("observation hook");
		ts.forEachChild(node, visit);
	};
	visit(source);
	expect(violations).toEqual([]);
});
