#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parse } from "svelte/compiler";
import ts from "typescript";

const ROOT = resolve("src");
const DIRECTORY = resolve("src/lib/account-directory.ts");
const ENV_OWNERS = new Set([
	DIRECTORY,
	resolve("src/lib/provider/claude/claude-sdk-env.ts"),
]);
const DRIVER_LITERALS = new Set(["claude", "opencode"]);
const ACCOUNT_NAME = /^(?:accountId|instanceId)$|(?:AccountId|InstanceId)$/;

function collectSourceFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...collectSourceFiles(path));
		else if (entry.isFile() && /\.(ts|svelte)$/.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

// Like the other source gates, scan src rather than the separate test tree.
const files = collectSourceFiles(ROOT).sort();
const configPath = resolve("tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
	console.error(
		ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
	);
	process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(
	config.config,
	ts.sys,
	process.cwd(),
);
if (parsed.errors.length) {
	for (const error of parsed.errors) {
		console.error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
	}
	process.exit(1);
}
// Include frontend TS too, even though the server tsconfig excludes it.
const program = ts.createProgram(
	files.filter((file) => file.endsWith(".ts")),
	{ ...parsed.options, noEmit: true },
);
const checker = program.getTypeChecker();
const accountSource = program.getSourceFile(
	resolve("src/lib/contracts/account.ts"),
);
const accountDeclaration = accountSource?.statements.find(
	(node) => ts.isTypeAliasDeclaration(node) && node.name.text === "AccountId",
);
if (!accountDeclaration) {
	console.error("Account boundaries: cannot load the AccountId contract.");
	process.exit(1);
}
const accountType = checker.getTypeAtLocation(accountDeclaration.name);

function isAccountId(type) {
	if (
		type.flags &
		(ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
	) {
		return false;
	}
	if (type.isUnion()) return type.types.some(isAccountId);
	return checker.isTypeAssignableTo(type, accountType);
}

let violationCount = 0;
const reported = new Set();
function report(file, source, position, message) {
	const key = `${file}:${position}:${message}`;
	if (reported.has(key)) return;
	reported.add(key);
	violationCount++;
	const path = relative(process.cwd(), file).split(sep).join("/");
	const line = source.slice(0, position).split("\n").length;
	console.error(`${path}:${line}: ${message}`);
}

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

function tsKey(node, computed = false) {
	node = unwrapTs(node);
	if (!node) return;
	if (ts.isComputedPropertyName(node)) return tsKey(node.expression, true);
	if (ts.isStringLiteralLike(node)) return node.text;
	if (ts.isIdentifier(node)) {
		if (!computed) return node.text;
		const type = checker.getTypeAtLocation(node);
		if (type.isStringLiteral()) return type.value;
	}
}

function tsDriverLiteral(node) {
	node = unwrapTs(node);
	return node && ts.isStringLiteralLike(node) && DRIVER_LITERALS.has(node.text);
}

function checkTs(file) {
	const sourceFile = program.getSourceFile(file);
	const source = sourceFile.text;
	const accountComparison = (id, literal) => {
		if (
			tsDriverLiteral(literal) &&
			isAccountId(checker.getTypeAtLocation(id))
		) {
			report(
				file,
				source,
				literal.getStart(sourceFile),
				"AccountId must not be compared with a driver literal; use the account directory.",
			);
		}
	};
	function visit(node) {
		if (ts.isStringLiteralLike(node) && node.text === "claude-sdk") {
			const declaration = node.parent?.parent?.parent;
			const inAliasTable =
				file === DIRECTORY &&
				ts.isPropertyAssignment(node.parent) &&
				node.parent.name === node &&
				ts.isVariableDeclaration(declaration) &&
				ts.isIdentifier(declaration.name) &&
				declaration.name.text === "LEGACY_ACCOUNT_DRIVERS";
			if (!inAliasTable)
				report(
					file,
					source,
					node.getStart(sourceFile),
					"The claude-sdk alias belongs only in the account directory's alias table.",
				);
		}
		if (!ENV_OWNERS.has(file)) {
			// Key literals also catch constant aliases and Reflect.get/set.
			const key = ts.isPropertyAccessExpression(node)
				? node.name
				: ts.isElementAccessExpression(node)
					? node.argumentExpression
					: ts.isPropertyAssignment(node) ||
							ts.isShorthandPropertyAssignment(node)
						? node.name
						: ts.isBindingElement(node) &&
								ts.isObjectBindingPattern(node.parent)
							? (node.propertyName ?? node.name)
							: ts.isStringLiteralLike(node)
								? node
								: undefined;
			if (
				tsKey(key, ts.isElementAccessExpression(node)) === "CLAUDE_CONFIG_DIR"
			) {
				const location = ts.isComputedPropertyName(key) ? key.expression : key;
				report(
					file,
					source,
					location.getStart(sourceFile),
					"CLAUDE_CONFIG_DIR reads and writes must go through the Claude SDK env builder.",
				);
			}
		}
		if (file !== DIRECTORY) {
			if (
				ts.isBinaryExpression(node) &&
				(node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
					node.operatorToken.kind ===
						ts.SyntaxKind.ExclamationEqualsEqualsToken)
			) {
				accountComparison(node.left, node.right);
				accountComparison(node.right, node.left);
			}
			if (ts.isSwitchStatement(node)) {
				for (const clause of node.caseBlock.clauses) {
					if (ts.isCaseClause(clause)) {
						accountComparison(node.expression, clause.expression);
						accountComparison(clause.expression, node.expression);
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
}

function unwrapSvelte(node) {
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
}

function svelteKey(node) {
	node = unwrapSvelte(node);
	if (node?.type === "Identifier") return node.name;
	if (node?.type === "Literal") return node.value;
	if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
		return node.quasis[0].value.cooked;
	}
}

function svelteAccount(node) {
	node = unwrapSvelte(node);
	const name =
		node?.type === "MemberExpression"
			? node.computed && unwrapSvelte(node.property)?.type === "Identifier"
				? undefined
				: svelteKey(node.property)
			: node?.type === "Identifier"
				? node.name
				: undefined;
	return typeof name === "string" && ACCOUNT_NAME.test(name);
}

function svelteLiteral(node) {
	node = unwrapSvelte(node);
	if (node?.type === "Literal" || node?.type === "TemplateLiteral")
		return svelteKey(node);
}

function checkSvelte(file) {
	const source = readFileSync(file, "utf8");
	let ast;
	try {
		ast = parse(source, { filename: file, modern: true });
	} catch (error) {
		report(
			file,
			source,
			error.position?.[0] ?? 0,
			`Cannot parse Svelte for account boundary checks: ${error.message}`,
		);
		return;
	}
	const accountComparison = (id, literal) => {
		if (svelteAccount(id) && DRIVER_LITERALS.has(svelteLiteral(literal))) {
			report(
				file,
				source,
				literal.start,
				"Account identifier must not be compared with a driver literal; use the account directory.",
			);
		}
	};
	const visited = new WeakSet();
	function visit(node) {
		if (!node || typeof node !== "object" || visited.has(node)) return;
		visited.add(node);
		if (["Comment", "Line", "Block", "Text"].includes(node.type)) return;
		const key =
			node.type === "MemberExpression"
				? node.property
				: node.type === "Property"
					? node.key
					: ["Literal", "TemplateLiteral"].includes(node.type)
						? node
						: undefined;
		if (svelteKey(key) === "CLAUDE_CONFIG_DIR") {
			report(
				file,
				source,
				key.start,
				"CLAUDE_CONFIG_DIR reads and writes must go through the Claude SDK env builder.",
			);
		}
		if (
			["Literal", "TemplateLiteral"].includes(node.type) &&
			svelteLiteral(node) === "claude-sdk"
		) {
			report(
				file,
				source,
				node.start,
				"The claude-sdk alias belongs only in the account directory's alias table.",
			);
		}
		if (
			node.type === "BinaryExpression" &&
			["===", "!=="].includes(node.operator)
		) {
			accountComparison(node.left, node.right);
			accountComparison(node.right, node.left);
		}
		if (node.type === "SwitchStatement") {
			for (const clause of node.cases) {
				if (clause.test) {
					accountComparison(node.discriminant, clause.test);
					accountComparison(clause.test, node.discriminant);
				}
			}
		}
		for (const child of Object.values(node)) {
			if (Array.isArray(child)) child.forEach(visit);
			else visit(child);
		}
	}
	visit(ast);
}

for (const file of files) {
	if (file.endsWith(".svelte")) checkSvelte(file);
	else checkTs(file);
}
console.log(
	`Account boundaries: ${violationCount} violation(s), ${files.length} source file(s) checked.`,
);
process.exit(violationCount > 0 ? 1 : 0);
