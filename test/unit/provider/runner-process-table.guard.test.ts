import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory()
			? sources(path)
			: /\.(?:[cm]?[jt]s|[jt]sx|svelte)$/.test(path)
				? [path]
				: [];
	});
}

function violations(file: string, text: string, rule: "legacy" | "identity") {
	const relevant =
		rule === "legacy"
			? /processTable|inspectMany/i
			: /startTime|startKey|start_time|start_key/;
	if (!relevant.test(text)) return [];
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const found: string[] = [];
	const propertyName = (node: ts.Node): string | undefined => {
		if (ts.isParenthesizedExpression(node))
			return propertyName(node.expression);
		if (ts.isIdentifier(node)) return node.text;
		return ts.isPropertyAccessExpression(node)
			? node.name.text
			: ts.isElementAccessExpression(node) &&
					ts.isStringLiteralLike(node.argumentExpression)
				? node.argumentExpression.text
				: undefined;
	};
	const start = (node: ts.Expression) =>
		/^(?:startTime|startKey|start_time|start_key|reaper_start_time|reaper_start_key)$/.test(
			propertyName(node) ?? "",
		);
	const missing = (node: ts.Expression): boolean => {
		if (ts.isParenthesizedExpression(node)) return missing(node.expression);
		return (
			(ts.isIdentifier(node) && node.text === "undefined") ||
			node.kind === ts.SyntaxKind.NullKeyword ||
			(ts.isVoidExpression(node) &&
				ts.isNumericLiteral(node.expression) &&
				node.expression.text === "0")
		);
	};
	const visit = (node: ts.Node): void => {
		if (
			(rule === "legacy" &&
				((ts.isIdentifier(node) &&
					/^(?:runnerProcessTable|RunnerProcessTable|inspectMany)$/.test(
						node.text,
					)) ||
					((ts.isPropertyAccessExpression(node) ||
						ts.isElementAccessExpression(node)) &&
						(/^(?:runnerProcessTable|inspectMany)$/.test(
							propertyName(node) ?? "",
						) ||
							(/^(?:alive|members)$/.test(propertyName(node) ?? "") &&
								/processTable/i.test(node.expression.getText(source))))))) ||
			(rule === "identity" &&
				ts.isBinaryExpression(node) &&
				(node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
					node.operatorToken.kind ===
						ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
				((start(node.left) && !missing(node.right)) ||
					(start(node.right) && !missing(node.left))))
		) {
			const { line } = source.getLineAndCharacterOfPosition(node.getStart());
			found.push(`${file}:${line + 1}: ${node.getText(source)}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

for (const rule of ["legacy", "identity"] as const) {
	it(
		rule === "legacy"
			? "removes the legacy runner table and its optional methods from source and tests"
			: "keeps all raw start comparisons inside process-identity",
		() => {
			const found = (rule === "legacy" ? ["src", "test"] : ["src"])
				.flatMap(sources)
				.filter(
					(file) =>
						rule === "legacy" ||
						file !== "src/lib/provider/runner/process-identity.ts",
				)
				.flatMap((file) => {
					const text = readFileSync(file, "utf8");
					const script = file.endsWith(".svelte")
						? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
								.map((match) => match[1] ?? "")
								.join("\n")
						: text;
					return violations(file, script, rule);
				});
			mkdirSync("test-results/runner-process-table", { recursive: true });
			writeFileSync(
				`test-results/runner-process-table/${rule}.json`,
				JSON.stringify({ rule, violations: found }, null, 2),
			);
			expect(found).toEqual([]);
		},
	);
}

it.each([
	"a.startTime === b.startTime",
	"a['start_key'] !== key",
	"key === (a.reaper_start_time)",
	"a?.startKey === key",
	'a.startTime === "undefined"',
	"a.startTime !== void 1",
	"a.startKey === other.undefined",
	'startTime === "old"',
	"startKey !== key",
	"start_time === other",
	"key !== start_key",
	"(reaper_start_time) === other",
	"other !== reaper_start_key",
])("rejects raw identity comparison %s", (source) => {
	expect(violations("example.ts", source, "identity")).toHaveLength(1);
});

it.each(
	["undefined", "null", "void 0"].flatMap((missing) =>
		["===", "!=="].flatMap((operator) => [
			`a.startTime ${operator} ${missing}`,
			`${missing} ${operator} a['start_key']`,
			`startTime ${operator} ${missing}`,
			`${missing} ${operator} (reaper_start_time)`,
		]),
	),
)("allows presence comparison %s", (source) => {
	expect(violations("example.ts", source, "identity")).toEqual([]);
});

it.each([
	'import { runnerProcessTable as table } from "./runner-registry.js"',
	'registry["runnerProcessTable"]',
	"table.inspectMany([1])",
	"processTable.alive(1)",
	'processTable["members"]?.(1)',
])("rejects legacy process-table access %s", (source) => {
	expect(violations("example.ts", source, "legacy").length).toBeGreaterThan(0);
});
