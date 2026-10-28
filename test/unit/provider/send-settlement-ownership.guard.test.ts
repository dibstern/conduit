import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const adapter = "src/lib/provider/runner/send-settlement-outbox.ts";
const owner = "src/lib/provider/runner/send-settlement.ts";

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

describe("send settlement ownership", () => {
	it("allows only the outbox adapter to import the run-terminal writer", () => {
		const imports = sources(join(root, "src/lib")).flatMap((file) => {
			const parsed = ts.createSourceFile(
				file,
				readFileSync(file, "utf8"),
				ts.ScriptTarget.Latest,
				true,
			);
			return parsed.statements.flatMap((statement) =>
				ts.isImportDeclaration(statement) &&
				statement.importClause?.namedBindings &&
				ts.isNamedImports(statement.importClause.namedBindings) &&
				statement.importClause.namedBindings.elements.some(
					(binding) =>
						(binding.propertyName ?? binding.name).text ===
						"settleRunnerCommandReply",
				)
					? [relative(root, file)]
					: [],
			);
		});
		expect(imports).toEqual([adapter]);
	});

	it("keeps send retry policy in classify while permitting producers and decoders", () => {
		const files = [
			...sources(join(root, "src/lib/provider/runner")),
			join(root, "src/lib/provider/orchestration-side-effect-reactor.ts"),
		];
		const offenders: string[] = [];
		for (const file of files) {
			const parsed = ts.createSourceFile(
				file,
				readFileSync(file, "utf8"),
				ts.ScriptTarget.Latest,
				true,
			);
			const visit = (node: ts.Node): void => {
				if (
					ts.isBinaryExpression(node) &&
					/^(?:={2,3}|!={1,2})$/.test(node.operatorToken.getText(parsed)) &&
					/(?:\.|\[\s*["'])retry(?:able|Handled)\b/.test(
						node.getText(parsed),
					) &&
					!(ts.isIdentifier(node.right) && node.right.text === "undefined") &&
					!ts.isTypeOfExpression(node.left) &&
					!ts.isTypeOfExpression(node.right)
				) {
					let permitted = false;
					for (
						let parent: ts.Node | undefined = node.parent;
						parent;
						parent = parent.parent
					) {
						if (
							ts.isPropertyAssignment(parent) &&
							parent.name.getText(parsed) === "retryable"
						)
							permitted = true;
						if (
							relative(root, file) === owner &&
							ts.isVariableDeclaration(parent) &&
							parent.name.getText(parsed) === "classify"
						)
							permitted = true;
					}
					if (!permitted)
						offenders.push(
							`${relative(root, file)}:${parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1}`,
						);
				}
				ts.forEachChild(node, visit);
			};
			visit(parsed);
		}
		expect(offenders).toEqual([]);
	});

	it("has no optional run settlement or direct outbox terminal write in the writer", () => {
		const source = readFileSync(
			join(root, "src/lib/provider/runner/runner-recovery.ts"),
			"utf8",
		);
		const writer = source.slice(
			source.indexOf("export const settleRunnerCommandReply"),
			source.indexOf("export const settleUnclaimedRunnerCommands"),
		);
		expect(writer).not.toMatch(/\bsettleRun\b/);
		expect(writer).not.toMatch(
			/UPDATE\s+provider_command_outbox\s+SET\s+status/,
		);
	});

	// The run terminal ends every held send's row through settleRunCommands. Only an
	// unheld direct send's reply (a native-lifecycle provider's turn.completed is not a
	// run terminal) and a legacy send's native-resume requeue write the row directly.
	it("leaves settlement outbox status writes to direct replies and legacy requeue", () => {
		const writes = readdirSync(join(root, "src/lib/provider/runner"))
			.filter(
				(name) => name.startsWith("send-settlement") && name.endsWith(".ts"),
			)
			.flatMap((name) => {
				const file = join(root, "src/lib/provider/runner", name);
				const parsed = ts.createSourceFile(
					file,
					readFileSync(file, "utf8"),
					ts.ScriptTarget.Latest,
					true,
				);
				return parsed.statements.flatMap((statement) =>
					/UPDATE\s+provider_command_outbox\s+SET\s+status/.test(
						statement.getText(parsed),
					)
						? [
								`${relative(root, file)}:${
									ts.isVariableStatement(statement)
										? statement.declarationList.declarations[0]?.name.getText(
												parsed,
											)
										: "statement"
								}`,
							]
						: [],
				);
			});
		expect(writes).toEqual([
			`${adapter}:settleDirectSend`,
			`${adapter}:settleLegacySend`,
		]);
		const source = readFileSync(join(root, adapter), "utf8");
		const direct = source.slice(
			source.indexOf("export const settleDirectSend"),
			source.indexOf("UPDATE provider_command_outbox"),
		);
		expect(direct).toMatch(/run\.runner_id IS NULL/);
	});
});
