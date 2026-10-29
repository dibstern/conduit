import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const owner = "src/lib/provider/runner/runner-legacy-classification.ts";
const classifiers = [
	"isLegacyRunner",
	"legacyRunnerRunPredicate",
	"legacyRunnerRunQuery",
];

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		return entry.isDirectory()
			? sources(file)
			: file.endsWith(".ts")
				? [file]
				: [];
	});
}

describe("legacy classification ownership", () => {
	it("classifies a legacy runner or run only in the classification leaf", () => {
		const offenders: string[] = [];
		const declared: string[] = [];
		for (const file of sources(join(root, "src"))) {
			const name = relative(root, file);
			const source = readFileSync(file, "utf8");
			const parsed = ts.createSourceFile(
				name,
				source,
				ts.ScriptTarget.Latest,
				true,
			);
			const at = (node: ts.Node) =>
				`${name}:${parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1}`;
			const visit = (node: ts.Node): void => {
				// The runner side: the hello's send-journal flag is read only by the predicate.
				const flagRead =
					(ts.isPropertyAccessExpression(node) &&
						node.name.text === "sendJournalAnswers") ||
					(ts.isElementAccessExpression(node) &&
						ts.isStringLiteralLike(node.argumentExpression) &&
						node.argumentExpression.text === "sendJournalAnswers") ||
					(ts.isBindingElement(node) &&
						(node.propertyName ?? node.name).getText(parsed) ===
							"sendJournalAnswers");
				// The store side: a dispatch without a command id marks a legacy run.
				const storeRead =
					(ts.isNoSubstitutionTemplateLiteral(node) ||
						ts.isTemplateHead(node) ||
						ts.isTemplateMiddle(node) ||
						ts.isTemplateTail(node)) &&
					/'\$\.commandId'\)\s+IS\s+NULL/i.test(node.text);
				const declaration =
					(ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
					node.name !== undefined &&
					classifiers.includes(node.name.getText(parsed));
				if (declaration) declared.push(`${name}:${node.name?.getText(parsed)}`);
				if ((flagRead || storeRead || declaration) && name !== owner)
					offenders.push(at(node));
				ts.forEachChild(node, visit);
			};
			visit(parsed);
		}
		expect(offenders).toEqual([]);
		expect(declared.sort()).toEqual(
			classifiers.map((classifier) => `${owner}:${classifier}`).sort(),
		);
	});
});
