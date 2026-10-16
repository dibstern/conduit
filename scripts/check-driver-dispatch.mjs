#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parse } from "svelte/compiler";
import ts from "typescript";

function unwrapTs(node) {
	while (
		node &&
		(ts.isParenthesizedExpression(node) ||
			ts.isAsExpression(node) ||
			ts.isTypeAssertionExpression(node) ||
			ts.isNonNullExpression(node) ||
			ts.isSatisfiesExpression(node))
	) {
		node = node.expression;
	}
	return node;
}

const contractPath = resolve("src/lib/contracts/provider-instance.ts");
const contract = ts.createSourceFile(
	contractPath,
	readFileSync(contractPath, "utf8"),
	ts.ScriptTarget.Latest,
	true,
);
const record = unwrapTs(
	contract.statements
		.filter(ts.isVariableStatement)
		.flatMap((statement) => statement.declarationList.declarations)
		.find(
			(declaration) =>
				declaration.name.getText(contract) === "PROVIDER_DRIVERS",
		)?.initializer,
);
if (!record || !ts.isObjectLiteralExpression(record)) {
	console.error("Driver dispatch: cannot read PROVIDER_DRIVERS.");
	process.exit(1);
}
const driverKinds = new Set(
	record.properties.map((property) => property.name?.text).filter(Boolean),
);

function collectSourceFiles(path) {
	if (statSync(path).isFile()) return [path];
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
		const child = resolve(path, entry.name);
		if (entry.isDirectory()) {
			return ["generated", "node_modules"].includes(entry.name)
				? []
				: collectSourceFiles(child);
		}
		return entry.isFile() && /\.(?:[cm]?[jt]s|svelte)$/.test(entry.name)
			? [child]
			: [];
	});
}

// A comparison that narrows a non-driver union whose members share a driver name
// (a usage reading's harness, a Claude-only table) is waived by a reasoned
// `driver-dispatch-ok: <reason>` comment on its line or the line above.
const WAIVER = /driver-dispatch-ok:\s*\S/;
let violationCount = 0;
function report(file, source, position) {
	const lines = source.split("\n");
	const line = source.slice(0, position).split("\n").length;
	if (WAIVER.test(lines[line - 1]) || WAIVER.test(lines[line - 2] ?? ""))
		return;
	violationCount++;
	const path = relative(process.cwd(), file).split(sep).join("/");
	console.error(
		`${path}:${line}: Negative driver-kind comparison; ask the driver record for the required trait.`,
	);
}

function checkTs(file, source) {
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const isDriverLiteral = (node) => {
		node = unwrapTs(node);
		return ts.isStringLiteralLike(node) && driverKinds.has(node.text);
	};
	const comparesDriver = (node, operators) =>
		ts.isBinaryExpression(node) &&
		operators.includes(node.operatorToken.kind) &&
		(isDriverLiteral(node.left) || isDriverLiteral(node.right));
	function visit(node) {
		if (
			comparesDriver(node, [
				ts.SyntaxKind.ExclamationEqualsToken,
				ts.SyntaxKind.ExclamationEqualsEqualsToken,
			]) ||
			// `!(driver === "claude")` is the same negative check.
			(ts.isPrefixUnaryExpression(node) &&
				node.operator === ts.SyntaxKind.ExclamationToken &&
				comparesDriver(unwrapTs(node.operand), [
					ts.SyntaxKind.EqualsEqualsToken,
					ts.SyntaxKind.EqualsEqualsEqualsToken,
				]))
		) {
			report(file, source, node.getStart(ast));
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
}

function checkSvelte(file, source) {
	let ast;
	try {
		ast = parse(source, { filename: file, modern: true });
	} catch (error) {
		violationCount++;
		console.error(
			`${file}: Cannot parse Svelte for driver dispatch: ${error.message}`,
		);
		return;
	}
	const unwrap = (node) => {
		while (
			node &&
			[
				"ChainExpression",
				"TSAsExpression",
				"TSNonNullExpression",
				"TSTypeAssertion",
				"TSSatisfiesExpression",
				"ParenthesizedExpression",
			].includes(node.type)
		) {
			node = node.expression;
		}
		return node;
	};
	const isDriverLiteral = (node) => {
		node = unwrap(node);
		const value =
			node?.type === "Literal"
				? node.value
				: node?.type === "TemplateLiteral" && node.expressions.length === 0
					? node.quasis[0].value.cooked
					: undefined;
		return driverKinds.has(value);
	};
	const visited = new WeakSet();
	function visit(node) {
		if (!node || typeof node !== "object" || visited.has(node)) return;
		visited.add(node);
		if (["Comment", "Line", "Block", "Text"].includes(node.type)) return;
		const comparesDriver = (candidate, operators) =>
			candidate?.type === "BinaryExpression" &&
			operators.includes(candidate.operator) &&
			(isDriverLiteral(candidate.left) || isDriverLiteral(candidate.right));
		if (
			comparesDriver(node, ["!=", "!=="]) ||
			(node.type === "UnaryExpression" &&
				node.operator === "!" &&
				comparesDriver(unwrap(node.argument), ["==", "==="]))
		) {
			report(file, source, node.start);
		}
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) child.forEach(visit);
			else visit(child);
		}
	}
	visit(ast);
}

const paths = process.argv.slice(2);
const files = (paths.length ? paths : ["src"])
	.flatMap((path) => collectSourceFiles(resolve(path)))
	.sort();
for (const file of files) {
	const source = readFileSync(file, "utf8");
	if (file.endsWith(".svelte")) checkSvelte(file, source);
	else checkTs(file, source);
}
console.log(
	`Driver dispatch: ${violationCount} violation(s), ${files.length} source file(s) checked.`,
);
process.exit(violationCount > 0 ? 1 : 0);
