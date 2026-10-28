#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";

const adapter = resolve("src/lib/provider/cursor/sdk-real.ts");
// Named real-SDK contract references only. Production imports stay in the port.
const testSdkImportAllowances = {
	"stored-login-wire-reference":
		"test/helpers/cursor-credentials-sdk-reference.mjs",
	"installed-error-contract":
		"test/e2e/provider/cursor-errors-real-sdk.test.ts",
};
const allowedTests = new Set(
	Object.entries(testSdkImportAllowances).map(([name, file]) => {
		const path = resolve(file);
		if (!path.startsWith(`${resolve("test")}${sep}`))
			throw new Error(`Cursor SDK allowance ${name} must be under test/**`);
		return path;
	}),
);
let violations = 0;

function check(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			if (!["node_modules", "generated"].includes(entry.name)) check(path);
			continue;
		}
		if (
			path === adapter ||
			allowedTests.has(path) ||
			!/\.(?:[cm]?[jt]s|svelte)$/.test(entry.name)
		) {
			continue;
		}
		const source = ts.createSourceFile(
			path,
			readFileSync(path, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		function visit(node) {
			const module =
				ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
					? node.moduleSpecifier
					: ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
						? node.argument.literal
						: ts.isCallExpression(node) &&
								(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
									(ts.isIdentifier(node.expression) &&
										node.expression.text === "require"))
							? node.arguments[0]
							: undefined;
			if (
				module &&
				ts.isStringLiteralLike(module) &&
				(module.text === "@cursor/sdk" ||
					module.text.startsWith("@cursor/sdk/"))
			) {
				const line =
					source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
				console.error(
					`${relative(process.cwd(), path)}:${line}: Cursor SDK imports belong only in sdk-real.ts.`,
				);
				violations++;
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
}

for (const root of ["src", "test", "scripts", "acceptance"])
	check(resolve(root));
console.log(`Cursor SDK boundary: ${violations} violation(s).`);
process.exitCode = violations ? 1 : 0;
