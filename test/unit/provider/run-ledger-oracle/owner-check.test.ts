import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A.18 T4 (82tn.32.2.3): each A.21 owner-table row that is ledger state is one oracle field with
 * one writing function, so a second writer fails here. A field written with a literal names the
 * row by that literal (`phase` is the Run end at "Ended" and the unlaunch at "Queued"). Fence is
 * section 9 membership over label work, a predicate with no field; host interrupt mode (4.6) is the
 * host's. The other rows are main's (A.21), so the oracle holds no field for them.
 */
const rows = [
	["Run end", "phase=Ended", "endRun"],
	["End reason", "ended.push()", "endRun"],
	["Unlaunch", "phase=Queued", "reconcile"],
	["Seal", "sealed", "seal"],
	["Wake execution and label work", "ended", "endWork"],
	["Interaction", "resolved", "resolveInteraction"],
	["Interaction answer", "answer", "answerInteraction"],
	["Probe", "probe", "probe"],
	["Lost work", "lostWork.push()", "decideLostWork"],
	["Ledger stop deadline", "stop", "commit"],
	["Ledger stop deadline's work", "items", "commit"],
] as const;

const assignments = new Set([
	ts.SyntaxKind.EqualsToken,
	ts.SyntaxKind.QuestionQuestionEqualsToken,
	ts.SyntaxKind.BarBarEqualsToken,
	ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);
const mutators = new Set(["push", "splice", "unshift", "pop", "shift"]);

/** Each written field, keyed as the rows above key it, with the functions that write it. */
function writers(source: string): ReadonlyMap<string, readonly string[]> {
	const file = ts.createSourceFile(
		"reference.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	const found = new Map<string, Set<string>>();
	const owner = (node: ts.Node): string => {
		for (let at = node.parent; at !== undefined; at = at.parent) {
			if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
			if (
				(ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
				ts.isVariableDeclaration(at.parent)
			)
				return at.parent.name.getText(file);
		}
		return "<module>";
	};
	const add = (key: string, node: ts.Node) =>
		found.set(key, (found.get(key) ?? new Set()).add(owner(node)));
	const visit = (node: ts.Node): void => {
		if (
			ts.isBinaryExpression(node) &&
			assignments.has(node.operatorToken.kind) &&
			ts.isPropertyAccessExpression(node.left)
		) {
			const field = node.left.name.text;
			add(
				field === "phase"
					? `phase=${ts.isStringLiteral(node.right) ? node.right.text : node.right.getText(file)}`
					: field,
				node,
			);
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			mutators.has(node.expression.name.text) &&
			ts.isPropertyAccessExpression(node.expression.expression)
		)
			add(
				`${node.expression.expression.name.text}.${node.expression.name.text}()`,
				node,
			);
		ts.forEachChild(node, visit);
	};
	visit(file);
	return new Map(
		[...found].map(([key, owners]) => [key, [...owners].sort()] as const),
	);
}

const oracle = readFileSync(join(import.meta.dirname, "reference.ts"), "utf8");

describe("A.18 T4 owner check: one writing function per ledger-state row in the oracle", () => {
	it.each(rows)("%s (%s) has one writer, %s", (_row, field, writer) => {
		expect(writers(oracle).get(field)).toEqual([writer]);
	});

	it("writes every phase as a literal, so no Run end or unlaunch is written unseen", () => {
		expect(
			[...writers(oracle).keys()]
				.filter((key) => key.startsWith("phase="))
				.sort(),
		).toEqual([
			"phase=Ended",
			"phase=Interrupting",
			"phase=Launched",
			"phase=Queued",
		]);
	});

	it("fails a second writer of a row's field", () => {
		const second = `${oracle}\nfunction extra(tx: { sealed?: unknown }) {\n\ttx.sealed = undefined;\n}\n`;
		expect(writers(second).get("sealed")).toEqual(["extra", "seal"]);
	});
});
