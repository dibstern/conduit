import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const writes = new Set([
	ts.SyntaxKind.EqualsToken,
	ts.SyntaxKind.QuestionQuestionEqualsToken,
	ts.SyntaxKind.BarBarEqualsToken,
	ts.SyntaxKind.AmpersandAmpersandEqualsToken,
	ts.SyntaxKind.PlusEqualsToken,
	ts.SyntaxKind.MinusEqualsToken,
]);

const sources = (directory: string): ts.SourceFile[] =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		if (entry.isDirectory()) return sources(file);
		if (!file.endsWith(".ts")) return [];
		return [
			ts.createSourceFile(
				relative(root, file),
				readFileSync(file, "utf8"),
				ts.ScriptTarget.Latest,
				true,
			),
		];
	});
const provider = sources(join(root, "src/lib/provider"));
const at = (node: ts.Node) => {
	const file = node.getSourceFile();
	return `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
};

/** Every member of each named interface, and where a member is not readonly or holds a mutable collection. */
const declarations = (names: readonly string[]) => {
	const found: string[] = [];
	const members = new Set<string>();
	const mutable: string[] = [];
	for (const file of provider)
		ts.forEachChild(file, function visit(node): void {
			if (ts.isInterfaceDeclaration(node) && names.includes(node.name.text)) {
				found.push(`${file.fileName}:${node.name.text}`);
				for (const member of node.members) {
					if (!ts.isPropertySignature(member)) continue;
					members.add(member.name.getText(file));
					const collection = (type: ts.Node): boolean =>
						(ts.isTypeReferenceNode(type) &&
							["Map", "Set", "Array"].includes(type.typeName.getText(file))) ||
						(ts.isArrayTypeNode(type) &&
							!(
								ts.isTypeOperatorNode(type.parent) &&
								type.parent.operator === ts.SyntaxKind.ReadonlyKeyword
							)) ||
						(ts.forEachChild(type, collection) ?? false);
					if (
						!member.modifiers?.some(
							(modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
						) ||
						(member.type && collection(member.type))
					)
						mutable.push(`${node.name.text}.${member.name.getText(file)}`);
				}
			}
			ts.forEachChild(node, visit);
		});
	return { found: found.sort(), members, mutable: mutable.sort() };
};

/** Writes to the named fields in files that can see the owner's state. */
const writesOutside = (
	owner: string,
	fields: ReadonlySet<string>,
	nested: Readonly<Record<string, readonly string[]>> = {},
) => {
	const offenders: string[] = [];
	const ownerModule = owner.replace(/^.*\//, "./").replace(/\.ts$/, ".js");
	for (const file of provider) {
		if (
			file.fileName === owner ||
			!file.statements.some(
				(statement) =>
					ts.isImportDeclaration(statement) &&
					ts.isStringLiteral(statement.moduleSpecifier) &&
					statement.moduleSpecifier.text === ownerModule,
			)
		)
			continue;
		const owned = (target: ts.Node): boolean => {
			if (ts.isParenthesizedExpression(target)) return owned(target.expression);
			if (
				!ts.isPropertyAccessExpression(target) ||
				target.expression.kind === ts.SyntaxKind.ThisKeyword
			)
				return false;
			const name = target.name.text;
			const parent = target.expression;
			return (
				fields.has(name) ||
				(ts.isPropertyAccessExpression(parent) &&
					nested[parent.name.text]?.includes(name) === true)
			);
		};
		ts.forEachChild(file, function visit(node): void {
			if (
				(ts.isBinaryExpression(node) &&
					writes.has(node.operatorToken.kind) &&
					owned(node.left)) ||
				((ts.isPrefixUnaryExpression(node) ||
					ts.isPostfixUnaryExpression(node)) &&
					(node.operator === ts.SyntaxKind.PlusPlusToken ||
						node.operator === ts.SyntaxKind.MinusMinusToken) &&
					owned(node.operand)) ||
				(ts.isDeleteExpression(node) && owned(node.expression))
			)
				offenders.push(at(node));
			ts.forEachChild(node, visit);
		});
	}
	return offenders;
};

describe("runner state ownership", () => {
	it("assigns RunnerChild fields only in runner-entry-lifecycle.ts", () => {
		const owner = "src/lib/provider/runner/runner-entry-lifecycle.ts";
		const entry = declarations(["RunnerChild"]);
		const upgrade = declarations(["RunnerUpgrade"]);
		expect({
			declared: entry.found,
			mutable: [
				...entry.mutable,
				// The rest of RunnerUpgrade is the upgrade scheduler's own state.
				...upgrade.mutable.filter((field) =>
					["RunnerUpgrade.state", "RunnerUpgrade.activity"].includes(field),
				),
			],
			writes: writesOutside(owner, entry.members, {
				upgrade: ["state", "activity"],
			}),
		}).toEqual({
			declared: [`${owner}:RunnerChild`],
			mutable: [],
			writes: [],
		});
	});

	it("releases runner entry waiters only through the entry scope (B25)", () => {
		const owner = "src/lib/provider/runner/runner-entry-lifecycle.ts";
		const reads = new Set(["make", "await", "isDone", "isDoneUnsafe", "poll"]);
		const offenders: string[] = [];
		const scopes: Record<string, { open: number; own: number }> = {};
		for (const file of provider.filter((source) => source.fileName !== owner)) {
			// Only a module that can see an entry can reach its scope.
			const seesEntries = file.statements.some(
				(statement) =>
					ts.isImportDeclaration(statement) &&
					ts.isStringLiteral(statement.moduleSpecifier) &&
					statement.moduleSpecifier.text === "./runner-entry-lifecycle.js",
			);
			ts.forEachChild(file, function visit(node): void {
				if (ts.isIdentifier(node) && node.text === "releaseWaiters")
					offenders.push(`${at(node)} releaseWaiters`);
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					ts.isIdentifier(node.expression.expression)
				) {
					const [target] = node.arguments;
					const module = node.expression.expression.text;
					const name = node.expression.name.text;
					const field =
						target && ts.isPropertyAccessExpression(target)
							? target.name.text
							: undefined;
					// drained and the End latch have no producer: only the scope settles them.
					if (
						module === "Deferred" &&
						!reads.has(name) &&
						(field === "drained" || field === "released")
					)
						offenders.push(`${at(node)} Deferred.${name}(.${field})`);
					if (seesEntries && module === "Scope" && field === "scope")
						offenders.push(`${at(node)} Scope.${name}(.scope)`);
					if (module === "Entry" && (name === "open" || name === "own")) {
						const counts = (scopes[file.fileName] ??= { open: 0, own: 0 });
						counts[name]++;
					}
				}
				if (ts.isObjectLiteralExpression(node)) {
					const names = new Set(
						node.properties.flatMap((property) =>
							property.name ? [property.name.getText(file)] : [],
						),
					);
					if (
						names.has("ready") &&
						(names.has("drained") || names.has("scope"))
					)
						offenders.push(
							`${at(node)} entry waiters built outside Entry.open`,
						);
				}
				ts.forEachChild(node, visit);
			});
		}
		expect({
			offenders,
			unowned: Object.entries(scopes).filter(
				([, counts]) => counts.open !== counts.own,
			),
			opened: Object.values(scopes).some((counts) => counts.open > 0),
		}).toEqual({ offenders: [], unowned: [], opened: true });
	});

	it("writes send binding fields only in runner-sends.ts, and derives a send's runner", () => {
		const owner = "src/lib/provider/runner/runner-sends.ts";
		const sends = declarations(["SendBinding", "PendingSend"]);
		expect({
			declared: sends.found,
			mutable: sends.mutable,
			// The assignment is the only record of a send's runner.
			stored: ["runnerId", "accepted", "dispatched", "admission"].filter(
				(field) => sends.members.has(field),
			),
			writes: writesOutside(owner, sends.members),
		}).toEqual({
			declared: [`${owner}:PendingSend`, `${owner}:SendBinding`],
			mutable: [],
			stored: [],
			writes: [],
		});
	});
});
