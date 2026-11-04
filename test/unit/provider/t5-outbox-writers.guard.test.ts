// T5-writers (CONTRACT.md 3.12): the outbox's status machine is main's, and each
// writer's from and to statuses are pinned here against its SQL text. A new
// status write, a changed target or a dropped guard fails until the table and
// 3.12 agree. The ledger core stays pure: it imports no main write module.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const sources = readdirSync(join(root, "src/lib"), { recursive: true })
	.map(String)
	.filter((name) => name.endsWith(".ts"))
	.map((name) => join(root, "src/lib", name));

const parse = (file: string) =>
	ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);

const nodes = (node: ts.Node): ts.Node[] => {
	const children: ts.Node[] = [];
	ts.forEachChild(node, (child) => {
		children.push(child);
	});
	return [node, ...children.flatMap(nodes)];
};

const STATUSES = [
	"pending",
	"running",
	"completed",
	"failed",
	"retryable_failed",
	"cancelled",
] as const;
const statusesIn = (text: string) =>
	STATUSES.filter((value) => new RegExp(`['"]${value}['"]`).test(text));

/** The text after the statement's own WHERE, with every subquery removed. */
const outerWhere = (sql: string) => {
	let depth = 0;
	let start = -1;
	for (let index = 0; index < sql.length && start < 0; index++) {
		if (sql[index] === "(") depth++;
		else if (sql[index] === ")") depth--;
		else if (depth === 0 && /^\bWHERE\b/.test(sql.slice(index, index + 6)))
			start = index + 5;
	}
	if (start < 0) return "";
	let clause = sql.slice(start);
	for (;;) {
		const open = clause.search(/\(\s*SELECT\b/);
		if (open < 0) return clause;
		let close = open;
		for (let level = 0; close < clause.length; close++) {
			if (clause[close] === "(") level++;
			else if (clause[close] === ")" && --level === 0) break;
		}
		clause = clause.slice(0, open) + clause.slice(close + 1);
	}
};

const guard = (sql: string) => {
	const where = outerWhere(sql);
	const found = [
		...where.matchAll(/(?<![.\w])status\s*(?:=|<>|IN)\s*(\([^)]*\)|'[^']*')/g),
	].flatMap((match) => statusesIn(match[1] ?? ""));
	return found.length === 0 ? "any" : [...new Set(found)].join(",");
};

/** The status assignment's expression, read to its depth-0 comma. */
const assignment = (sql: string) => {
	const match = /(?:\bSET|,)\s*status\s*=\s*/.exec(sql);
	if (!match) return undefined;
	let depth = 0;
	let end = match.index + match[0].length;
	for (; end < sql.length; end++) {
		const char = sql[end];
		if (char === "(" || char === "{") depth++;
		else if (char === ")" || char === "}") depth--;
		else if (
			depth === 0 &&
			(char === "," || /^\s(WHERE|RETURNING)\b/.test(sql.slice(end, end + 11)))
		)
			break;
	}
	return sql.slice(match.index + match[0].length, end).trim();
};

const writerName = (node: ts.Node): string => {
	for (let at: ts.Node | undefined = node; at; at = at.parent) {
		if (
			(ts.isMethodDeclaration(at) ||
				ts.isFunctionDeclaration(at) ||
				ts.isPropertyAssignment(at) ||
				ts.isVariableDeclaration(at)) &&
			at.name &&
			ts.isIdentifier(at.name) &&
			(!ts.isVariableDeclaration(at) ||
				(at.initializer !== undefined &&
					(ts.isArrowFunction(at.initializer) ||
						ts.isFunctionExpression(at.initializer) ||
						(ts.isCallExpression(at.initializer) &&
							/^Effect\.(gen|fn)\b/.test(
								at.initializer.expression.getText(),
							)))))
		)
			return at.name.text;
		// An anonymous body passed to a named call, as cancelControls is to retirePendingPrompts.
		if (
			at.parent &&
			ts.isCallExpression(at.parent) &&
			ts.isIdentifier(at.parent.expression) &&
			at.parent.arguments.some((argument) => argument === at)
		)
			return `${at.parent.expression.text}(argument ${at.parent.arguments.indexOf(at as ts.Expression)})`;
	}
	return "<module>";
};

/** Every SQL text that writes outbox status, as `path#writer: from -> to`. */
const statusWrites = sources.flatMap((file) => {
	const source = readFileSync(file, "utf8");
	if (!source.includes("provider_command_outbox")) return [];
	const parsed = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	return nodes(parsed).flatMap((node) => {
		if (
			!ts.isTemplateExpression(node) &&
			!ts.isNoSubstitutionTemplateLiteral(node) &&
			!ts.isStringLiteral(node)
		)
			return [];
		const sql = node.getText(parsed);
		const verb =
			/\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|DELETE\s+FROM|UPDATE)\s+provider_command_outbox\b/.exec(
				sql,
			)?.[1];
		if (!verb) return [];
		const site = `${relative(root, file)}#${writerName(node)}`;
		if (verb.startsWith("DELETE")) return [`${site}: ${guard(sql)} -> deleted`];
		if (verb.startsWith("INSERT")) {
			// INSERT ... VALUES, or the ledger arm's INSERT ... SELECT.
			const values = sql.slice(sql.search(/\b(VALUES|SELECT)\b/));
			return [`${site}: new -> ${statusesIn(values).join(",") || "<dynamic>"}`];
		}
		const target = assignment(sql);
		if (target === undefined || target === "status") return [];
		return [
			`${site}: ${guard(sql)} -> ${statusesIn(target).join(",") || "<dynamic>"}`,
		];
	});
});

describe("T5-writers", () => {
	it("pins every outbox status writer's from and to statuses (CONTRACT.md 3.12)", () => {
		expect(statusWrites.sort()).toEqual(
			[
				// The command commit replaces an open row with a fresh pending one.
				"src/lib/provider/orchestration-command-commit.ts#recordOutboxRequest: new -> pending",
				"src/lib/provider/orchestration-command-commit.ts#recordOutboxRequest: pending,retryable_failed -> deleted",
				// markRunning is the only writer of running.
				"src/lib/provider/orchestration-side-effect-reactor.ts#markRunning: pending,retryable_failed -> running",
				// markCompleted and writeFailure keep main's unguarded write (3.12).
				"src/lib/provider/orchestration-side-effect-reactor.ts#markCompleted: any -> completed",
				"src/lib/provider/orchestration-side-effect-reactor.ts#writeFailure: any -> failed,retryable_failed",
				"src/lib/provider/orchestration-side-effect-reactor.ts#recordControlOutcome: running,pending,retryable_failed -> completed,failed,retryable_failed,cancelled",
				"src/lib/provider/orchestration-side-effect-reactor.ts#prepareRecovery: running -> pending",
				"src/lib/provider/orchestration-side-effect-reactor.ts#refuseProjectCommand: pending,running,retryable_failed -> cancelled",
				// Pending-prompt retirement's cancelControls body.
				"src/lib/persistence/effect/retire-pending-prompts.ts#retirePendingPrompts(argument 1): pending,running,retryable_failed -> cancelled",
				"src/lib/provider/runner/send-settlement-outbox.ts#settleDirectSend: running -> completed,failed,retryable_failed",
				"src/lib/provider/runner/send-settlement-outbox.ts#settleLegacySend: running -> retryable_failed",
				"src/lib/provider/runner/send-settlement-outbox.ts#requeueLegacySend: running -> retryable_failed",
				// CONTRACT.md 3.12 says every writer but markCompleted and writeFailure guards
				// status IN (from). settleRunCommands guards through its SELECT in the same
				// transaction (open send rows), not in the UPDATE's text. Gap, reported.
				"src/lib/persistence/effect/projectors-effect.ts#settleRunCommands: any -> completed,failed,retryable_failed",
				"src/lib/provider/orchestration-engine.ts#acceptStopEffect: retryable_failed -> deleted",
				// The ledger arm's keyed INSERT OR IGNORE of probe, stop_task and cancel_request.
				"src/lib/persistence/effect/run-ledger-arm.ts#project: new -> pending",
				// The ledger effects' executor: its claimed row's outcome, with its effect_outcome.
				"src/lib/provider/orchestration-side-effect-reactor.ts#runLedgerEffect: running -> completed,failed,retryable_failed,cancelled",
				// Outside the machine (3.12): the two migration-time deletes.
				"src/lib/persistence/effect/migrations.ts#runPurgeBackgroundShellSessionsMigration: any -> deleted",
				"src/lib/persistence/effect/migrations.ts#runPurgeLegacySkeletonSessionsMigration: any -> deleted",
				// runner-recovery's lock (SET status = status) writes no status, so it is not listed.
			].sort(),
		);
	});

	it("keeps the ledger core free of main's write modules", () => {
		const core = join(root, "src/lib/provider/run-ledger");
		const allowed = [core, join(root, "src/lib/contracts")];
		const imports = sources
			.filter((file) => file.startsWith(core))
			.flatMap((file) =>
				nodes(parse(file)).flatMap((node) =>
					(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
					node.moduleSpecifier &&
					ts.isStringLiteral(node.moduleSpecifier) &&
					node.moduleSpecifier.text.startsWith(".")
						? [resolve(dirname(file), node.moduleSpecifier.text)]
						: [],
				),
			);
		expect(imports.length).toBeGreaterThan(0);
		expect(
			imports
				.filter((target) => !allowed.some((dir) => target.startsWith(dir)))
				.map((target) => relative(root, target)),
		).toEqual([]);
	});
});
