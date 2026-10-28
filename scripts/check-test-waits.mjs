#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const started = performance.now();
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(root, "scripts/check-test-waits.baseline.json");
const rules = ["polling", "real-wait", "retry-override", "timeout-override"];
const registrations = new Set([
	"test",
	"it",
	"describe",
	"beforeAll",
	"beforeEach",
	"afterAll",
	"afterEach",
]);
const modifiers = new Set([
	"only",
	"skip",
	"concurrent",
	"sequential",
	"todo",
	"fails",
	"shuffle",
]);
const factories = new Set(["each", "for", "skipIf", "runIf", "extend"]);
const excludedDirectories = new Set([
	"node_modules",
	"generated",
	"__generated__",
	"dist",
	"coverage",
	"test-results",
	"playwright-report",
	"artifacts",
]);
const repoPath = (file) => relative(root, file).split(sep).join("/");
const isSource = (file) =>
	/\.[cm]?[jt]sx?$/.test(file) &&
	!/(?:\.d\.[cm]?ts|\.config\.[cm]?[jt]s)$/.test(file);

function collect(directory, sourceTestsOnly = false) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			return excludedDirectories.has(entry.name) ||
				entry.name.endsWith("-snapshots")
				? []
				: collect(file, sourceTestsOnly);
		}
		return entry.isFile() &&
			isSource(file) &&
			(!sourceTestsOnly || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file))
			? [file]
			: [];
	});
}

const args = process.argv.slice(2);
const writeBaseline = args.includes("--write-baseline");
const explicit = args.filter((arg) => arg !== "--write-baseline");
if (writeBaseline && explicit.length) {
	console.error(
		"Use --write-baseline without file arguments to regenerate all counts.",
	);
	process.exit(1);
}
const files = [
	...new Set(
		explicit.length
			? explicit.map((file) => resolve(file))
			: [
					// Vitest configs cover test/{unit,integration,contract,fixture,build,media,budget,e2e}.
					// Playwright configs add test/e2e/specs and test/visual. Include helpers too.
					...collect(resolve(root, "test")),
					...collect(resolve(root, "acceptance")),
					...collect(resolve(root, "src"), true),
				],
	),
].sort();
// Bind local symbols without loading application imports or dependencies. This
// follows aliases and respects shadowing without a whole-project typecheck.
const program = ts.createProgram(files, {
	allowJs: true,
	noLib: true,
	noResolve: true,
	moduleDetection: ts.ModuleDetectionKind.Force,
	target: ts.ScriptTarget.Latest,
});
const checker = program.getTypeChecker();
const findings = new Map();
let errors = 0;
let exemptPolling = 0;

function unwrap(node) {
	while (
		node &&
		(ts.isParenthesizedExpression(node) ||
			ts.isAsExpression(node) ||
			ts.isSatisfiesExpression(node) ||
			ts.isNonNullExpression(node))
	)
		node = node.expression;
	return node;
}

function memberName(node) {
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (
		ts.isElementAccessExpression(node) &&
		ts.isStringLiteralLike(node.argumentExpression)
	)
		return node.argumentExpression.text;
	return undefined;
}

function memberOrigin(owner, name) {
	if (owner === "test-api") {
		if (registrations.has(name) || ["expect", "vi", "vitest"].includes(name))
			return name === "vitest" ? "vi" : name;
	}
	if (registrations.has(owner)) {
		if (modifiers.has(name)) return owner;
		if (factories.has(name)) return `${owner}:${name}`;
		if (owner === "test" && name === "describe") return "describe";
	}
	if (["test", "test-info"].includes(owner) && name === "setTimeout")
		return "test-timeout";
	if (owner === "test" && name === "info") return "test-info-factory";
	if (owner === "expect" && name === "poll") return "polling";
	if (owner === "vi") {
		if (["waitFor", "waitUntil"].includes(name)) return "polling";
		if (name === "setConfig") return "vi-config";
	}
	if (owner === "promise-timers") {
		if (name === "setTimeout") return "promise-timer";
		if (name === "scheduler") return "scheduler";
	}
	if (owner === "scheduler" && name === "wait") return "promise-timer";
	if (
		["global", "timers"].includes(owner) &&
		["setTimeout", "setInterval"].includes(name)
	)
		return "timer";
	if (owner === "global" && name === "Promise") return "Promise";
	return undefined;
}

function origin(expression, seen = new Set()) {
	const node = unwrap(expression);
	if (!node) return undefined;
	if (ts.isIdentifier(node)) {
		const symbol = checker.getSymbolAtLocation(node);
		if (symbol?.declarations?.length) {
			if (seen.has(symbol)) return undefined;
			seen = new Set(seen).add(symbol);
			for (const declaration of symbol.declarations ?? []) {
				if (
					ts.isImportSpecifier(declaration) ||
					ts.isNamespaceImport(declaration) ||
					ts.isImportClause(declaration)
				) {
					let statement = declaration.parent;
					while (statement && !ts.isImportDeclaration(statement))
						statement = statement.parent;
					if (
						!statement ||
						statement.importClause?.isTypeOnly ||
						declaration.isTypeOnly
					)
						return undefined;
					const module = statement.moduleSpecifier.text;
					if (
						ts.isImportClause(declaration) &&
						["@playwright/test", "playwright/test"].includes(module)
					)
						return "test";
					const owner = ["node:timers/promises", "timers/promises"].includes(
						module,
					)
						? "promise-timers"
						: ["node:timers", "timers"].includes(module)
							? "timers"
							: ["vitest", "@playwright/test", "playwright/test"].includes(
										module,
									) || module.startsWith(".")
								? "test-api"
								: undefined;
					return ts.isImportSpecifier(declaration)
						? memberOrigin(
								owner,
								(declaration.propertyName ?? declaration.name).text,
							)
						: owner;
				}
				if (ts.isVariableDeclaration(declaration))
					return origin(declaration.initializer, seen);
				if (
					ts.isBindingElement(declaration) &&
					ts.isObjectBindingPattern(declaration.parent) &&
					ts.isVariableDeclaration(declaration.parent.parent)
				)
					return memberOrigin(
						origin(declaration.parent.parent.initializer, seen),
						(declaration.propertyName ?? declaration.name).text,
					);
				if (ts.isParameter(declaration) && node.text === "testInfo")
					return "test-info";
			}
			return undefined;
		}
		if (registrations.has(node.text) || ["expect", "vi"].includes(node.text))
			return node.text;
		if (node.text === "vitest") return "vi";
		if (["setTimeout", "setInterval"].includes(node.text)) return "timer";
		if (["globalThis", "global", "window"].includes(node.text)) return "global";
		if (node.text === "testInfo") return "test-info";
		if (node.text === "Promise") return "Promise";
	}
	if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
		return memberOrigin(origin(node.expression, seen), memberName(node));
	if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
		const factory = origin(
			ts.isCallExpression(node) ? node.expression : node.tag,
			seen,
		);
		if (factory === "test-info-factory") return "test-info";
		if (factory?.includes(":")) return factory.split(":")[0];
	}
	return undefined;
}

function optionKeys(expression, seen = new Set()) {
	const node = unwrap(expression);
	if (!node) return [];
	if (ts.isIdentifier(node)) {
		const symbol = checker.getSymbolAtLocation(node);
		if (!symbol || seen.has(symbol)) return [];
		seen = new Set(seen).add(symbol);
		const declaration = symbol.valueDeclaration;
		return declaration && ts.isVariableDeclaration(declaration)
			? optionKeys(declaration.initializer, seen)
			: [];
	}
	if (!ts.isObjectLiteralExpression(node)) return [];
	return node.properties.flatMap((property) => {
		if (ts.isSpreadAssignment(property))
			return optionKeys(property.expression, seen);
		const name = property.name;
		return name && ts.isComputedPropertyName(name)
			? ts.isStringLiteralLike(name.expression)
				? [name.expression.text]
				: []
			: name
				? [name.text]
				: [];
	});
}

function insidePromise(node) {
	for (let parent = node.parent; parent; parent = parent.parent) {
		if (
			(ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
			ts.isNewExpression(parent.parent) &&
			parent.parent.arguments?.[0] === parent &&
			origin(parent.parent.expression) === "Promise"
		)
			return true;
	}
	return false;
}

for (const file of files) {
	const source = program.getSourceFile(file);
	if (!source) throw new Error(`Cannot read test source: ${file}`);
	const path = repoPath(file);
	const byRule = new Map(rules.map((rule) => [rule, []]));
	findings.set(path, byRule);
	const allows = new Map();
	const comments = new Set();
	const browser =
		path.startsWith("acceptance/") ||
		path.startsWith("test/visual/") ||
		(path.startsWith("test/e2e/") && !/\.test\.[cm]?[jt]sx?$/.test(path)) ||
		(/\.spec\.[cm]?[jt]sx?$/.test(path) &&
			source.statements.some(
				(node) =>
					ts.isImportDeclaration(node) &&
					["@playwright/test", "playwright/test"].includes(
						node.moduleSpecifier.text,
					),
			));
	function location(position) {
		const { line, character } = source.getLineAndCharacterOfPosition(position);
		return `${path}:${line + 1}:${character + 1}`;
	}
	function readComments(node) {
		for (const comment of [
			...(ts.getLeadingCommentRanges(source.text, node.pos) ?? []),
			...(ts.getTrailingCommentRanges(source.text, node.end) ?? []),
		]) {
			if (comments.has(comment.pos)) continue;
			comments.add(comment.pos);
			const text = source.text.slice(comment.pos, comment.end);
			if (!/^\/\/\s*test-waits-allow\b/.test(text)) continue;
			const match = /^\/\/\s*test-waits-allow\s+([\w-]+):\s*(\S.*)$/.exec(text);
			if (!match || !rules.includes(match[1])) {
				console.error(
					`${location(comment.pos)} [invalid-allow] Expected // test-waits-allow <rule-id>: <non-empty reason>.`,
				);
				errors++;
			} else {
				const { line } = source.getLineAndCharacterOfPosition(comment.pos);
				const lineStart = source.getLineStarts()[line];
				if (!source.text.slice(lineStart, comment.pos).trim())
					allows.set(line + 1, { rule: match[1], used: false });
			}
		}
		ts.forEachChild(node, readComments);
	}
	readComments(source);
	function report(node, rule, message) {
		const start = node.getStart(source);
		const { line } = source.getLineAndCharacterOfPosition(start);
		const allow = allows.get(line);
		if (allow?.rule === rule && !allow.used) {
			allow.used = true;
			return;
		}
		byRule.get(rule).push(`${location(start)} [${rule}] ${message}`);
	}
	function visit(node) {
		if (ts.isCallExpression(node)) {
			const callee = unwrap(node.expression);
			const name = memberName(callee);
			const kind = origin(callee);
			if (
				name === "waitForTimeout" ||
				kind === "promise-timer" ||
				(kind === "timer" && insidePromise(node))
			)
				report(
					node,
					"real-wait",
					"Replace wall-clock waiting with an observable condition or virtual time.",
				);
			if (kind === "test-timeout")
				report(
					node,
					"timeout-override",
					"Use the configured test timeout instead of a local override.",
				);
			const configure =
				name === "configure" &&
				(origin(callee.expression) === "describe" ||
					memberName(callee.expression) === "describe");
			if (configure || kind === "vi-config" || registrations.has(kind)) {
				const keys = (
					configure || kind === "vi-config"
						? node.arguments.slice(0, 1)
						: node.arguments
				).flatMap((argument) => optionKeys(argument));
				const numericTimeout =
					registrations.has(kind) &&
					node.arguments
						.slice(/^(before|after)(All|Each)$/.test(kind) ? 1 : 2)
						.some(
							(argument) =>
								checker.getTypeAtLocation(argument).flags &
								ts.TypeFlags.NumberLike,
						);
				if (
					numericTimeout ||
					keys.includes("timeout") ||
					(kind === "vi-config" &&
						keys.some((key) => ["testTimeout", "hookTimeout"].includes(key)))
				)
					report(
						node,
						"timeout-override",
						"Use configured test/hook timeouts instead of local overrides.",
					);
				if (keys.some((key) => ["retry", "retries"].includes(key)))
					report(
						node,
						"retry-override",
						"Use configured retries instead of a local override.",
					);
			}
			if (kind === "polling" || name === "toPass") {
				// Playwright specs/helpers and the acceptance harness poll the DOM
				// as part of normal assertions. Only the polling rule exempts them.
				if (browser) exemptPolling++;
				else
					report(
						node,
						"polling",
						"Assert an observable event or virtual-clock result instead of polling.",
					);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
}

const counts = Object.fromEntries(
	[...findings].flatMap(([path, byRule]) => {
		const entries = rules.flatMap((rule) => {
			const count = byRule.get(rule).length;
			return count ? [[rule, count]] : [];
		});
		return entries.length ? [[path, Object.fromEntries(entries)]] : [];
	}),
);
if (writeBaseline) {
	if (!errors)
		writeFileSync(baselinePath, `${JSON.stringify(counts, null, "\t")}\n`);
} else {
	const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
	const checkedPaths = explicit.length
		? [...findings.keys()]
		: [...new Set([...findings.keys(), ...Object.keys(baseline)])].sort();
	for (const path of checkedPaths) {
		for (const rule of new Set([
			...rules,
			...Object.keys(baseline[path] ?? {}),
		])) {
			const budget = baseline[path]?.[rule] ?? 0;
			const current = findings.get(path)?.get(rule) ?? [];
			if (
				!rules.includes(rule) ||
				!Number.isSafeInteger(budget) ||
				budget < 0
			) {
				console.error(`${path}:1:1 [${rule}] Invalid baseline entry.`);
				errors++;
			} else if (current.length > budget) {
				// Counts cannot identify which old location moved. Print all matching
				// locations in an over-budget file/rule so the new one is visible.
				for (const finding of current) console.error(finding);
				console.error(
					`${path}: ${rule} has ${current.length} occurrence(s), baseline allows ${budget}.`,
				);
				errors++;
			} else if (current.length < budget) {
				console.error(
					`${path}:1:1 [${rule}] Stale baseline: found ${current.length}, expected ${budget}; run node scripts/check-test-waits.mjs --write-baseline.`,
				);
				errors++;
			}
		}
	}
}
const totals = rules.map(
	(rule) =>
		`${rule}=${[...findings.values()].reduce((sum, byRule) => sum + byRule.get(rule).length, 0)}`,
);
console.log(
	`Test waits: ${errors} error(s), ${files.length} source file(s), ${totals.join(", ")}; ${exemptPolling} browser polling call(s) exempt; ${((performance.now() - started) / 1000).toFixed(2)}s${writeBaseline && !errors ? "; baseline written" : ""}.`,
);
process.exitCode = errors ? 1 : 0;
