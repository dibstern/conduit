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
	it("keeps generic retry policy and retired send lifetime maps off the send path", () => {
		for (const name of [
			"runner-send-feeder.ts",
			"send-settlement.ts",
			"send-settlement-outbox.ts",
			"runner-stored-send.ts",
		]) {
			const source = readFileSync(
				join(root, "src/lib/provider/runner", name),
				"utf8",
			);
			expect(source, name).not.toMatch(
				/\b(?:runnerRetrySchedule|retryRunnerPersistence)\b|Effect\.(?:retry|repeat)\s*\(/,
			);
		}
		const feeder = readFileSync(
			join(root, "src/lib/provider/runner/runner-send-feeder.ts"),
			"utf8",
		);
		expect(feeder).not.toMatch(
			/Effect\.catchCause\s*\(|\b(?:waiting|abandoned|restoring|cancelledBeforeWrite)\b/,
		);
		const manager = readFileSync(
			join(root, "src/lib/provider/runner/process-session-runner.ts"),
			"utf8",
		);
		expect(manager).not.toMatch(
			/\b(?:ownerSends|restoringOwners|settleOwnerSendFailure)\b/,
		);
		expect(manager).not.toMatch(/while\s*\(draining\)/);
		// The feeder file is checked whole above; the Starter also composes upgrade
		// and reconciler cadence, so only its send start is checked.
		const starter = readFileSync(
			join(root, "src/lib/provider/runner/runner-starter.ts"),
			"utf8",
		);
		const parsed = ts.createSourceFile(
			"starter.ts",
			starter,
			ts.ScriptTarget.Latest,
			true,
		);
		const starts: string[] = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isVariableDeclaration(node) &&
				node.name.getText(parsed) === "start"
			)
				starts.push(node.getText(parsed));
			ts.forEachChild(node, visit);
		};
		visit(parsed);
		expect(starts).toHaveLength(1);
		expect(starts[0]).not.toMatch(
			/\b(?:runnerRetrySchedule|retryRunnerPersistence)\b|Effect\.(?:retry|repeat)\s*\(/,
		);
	});

	it("leaves runner SQL and the run gate entirely with the lifecycle owner", () => {
		const source = readFileSync(
			join(root, "src/lib/persistence/effect/commit-and-signal.ts"),
			"utf8",
		);
		expect(source).not.toMatch(
			/\b(?:claude_runner_cursors|holdRun|releaseRun|HoldCommandIdMismatch)\b/,
		);
	});

	// The cap reports its own ledger evidence (CONTRACT 1521-1524); its turn.error is Settle's.
	// A first hold after its runner's retirement unlaunched the start also requests that Run again
	// (CONTRACT 674-679); no settlement is constructed here.
	it("constructs only dispatch, release, the relaunch's request and the cap's evidence in the lifecycle gate", () => {
		const file = join(root, "src/lib/provider/runner/runner-retirement.ts");
		const source = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const kinds: string[] = [];
		const visit = (node: ts.Node): void => {
			if (
				ts.isCallExpression(node) &&
				node.expression.getText(source) === "canonicalEvent"
			) {
				const kind = node.arguments[0];
				kinds.push(kind && ts.isStringLiteral(kind) ? kind.text : "dynamic");
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		expect(kinds.sort()).toEqual([
			"evidence.hold_exhausted",
			"run.dispatched",
			"run.released",
			"run.requested",
		]);
	});

	it("constructs delivery_unknown evidence only in Settle", () => {
		const constructors = sources(join(root, "src/lib")).flatMap((file) => {
			const parsed = ts.createSourceFile(
				file,
				readFileSync(file, "utf8"),
				ts.ScriptTarget.Latest,
				true,
			);
			const found: string[] = [];
			const visit = (node: ts.Node): void => {
				if (
					ts.isPropertyAssignment(node) &&
					node.name.getText(parsed) === "_tag" &&
					ts.isStringLiteral(node.initializer) &&
					node.initializer.text === "delivery_unknown"
				)
					found.push(relative(root, file));
				ts.forEachChild(node, visit);
			};
			visit(parsed);
			return found;
		});
		expect(constructors).toEqual([
			"src/lib/provider/runner/runner-retirement.ts",
		]);
	});

	it("keeps the run-terminal writer private to the outbox adapter", () => {
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
		expect(imports).toEqual([]);
		expect(readFileSync(join(root, adapter), "utf8")).toMatch(
			/^const settleRunnerCommandReply = /m,
		);
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
		const source = readFileSync(join(root, adapter), "utf8");
		const writer = source.slice(
			source.indexOf("const settleRunnerCommandReply"),
			source.indexOf("export const appendSendSettlement"),
		);
		expect(writer).toMatch(/^const settleRunnerCommandReply/);
		expect(writer).not.toMatch(/\bsettleRun\b/);
		expect(writer).not.toMatch(
			/UPDATE\s+provider_command_outbox\s+SET\s+status/,
		);
	});

	// The run terminal ends every held send's row through settleRunCommands. Only an
	// unheld direct send's reply (a native-lifecycle provider's turn.completed is not a
	// run terminal), a legacy send's native-resume requeue and a legacy send its
	// runner no longer reports write the row directly.
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
			`${adapter}:requeueLegacySend`,
		]);
		// Outside the adapter, the only outbox UPDATE is a write-lock touch that changes no column.
		const outside = readdirSync(join(root, "src/lib/provider/runner")).filter(
			(name) =>
				name.endsWith(".ts") &&
				`src/lib/provider/runner/${name}` !== adapter &&
				/UPDATE\s+provider_command_outbox\b(?!\s+SET\s+status\s*=\s*status\s)/.test(
					readFileSync(join(root, "src/lib/provider/runner", name), "utf8"),
				),
		);
		expect(outside).toEqual([]);
		const source = readFileSync(join(root, adapter), "utf8");
		const direct = source.slice(
			source.indexOf("export const settleDirectSend"),
			source.indexOf("UPDATE provider_command_outbox"),
		);
		expect(direct).toMatch(/run\.runner_id IS NULL/);
	});
});
