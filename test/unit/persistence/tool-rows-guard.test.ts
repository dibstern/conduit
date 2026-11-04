// 82tn.45 guard: no code path outside the Run Ledger derives busy or run end from tool rows.
// Failure modes: a statement reads open tool rows and writes or tests a session's busy or idle
// status, or ends a turn or run; the scan misses SQL split across a template's interpolations;
// the scan flags the ledger's own run-end closing or plain row reads.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "src/lib");
// The Run Ledger: its folder, its arm, and the run-end closing it calls.
const ledger = [
	"provider/run-ledger/",
	"persistence/effect/run-ledger-arm.ts",
	"persistence/effect/tool-row-run.ts",
];
// Known before 82tn.45, left as found (reported gap): when a parent's Run ends, the session
// projector idles child sessions reached through the parent's open foreground Task rows.
const known = [
	"persistence/projectors/session-handlers.ts:settleOpenSubagents",
];

const openToolRows =
	/message_parts[\s\S]*status\s+IN\s*\(\s*'started'|message_parts[\s\S]*status\s+IS\s+NOT\s+'completed'/i;
const busyOrRunEnd =
	/'busy'|'idle'|UPDATE\s+(sessions|turns|provider_runs)\b|turn\.completed|turn\.interrupted/i;

function sourceFiles(path: string): string[] {
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
		const file = join(path, entry.name);
		return entry.isDirectory()
			? sourceFiles(file)
			: /\.(ts|svelte)$/.test(file) && !file.endsWith(".d.ts")
				? [file]
				: [];
	});
}

/** Each statement literal (template pieces joined) that reads open tool rows to settle busy or a
 * run, named by its enclosing function. */
function violations(file: string, source: string): string[] {
	const parsed = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	const found: string[] = [];
	const visit = (node: ts.Node, owner: string): void => {
		const name =
			(ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
			node.name &&
			ts.isIdentifier(node.name)
				? node.name.text
				: owner;
		const text = ts.isTemplateExpression(node)
			? [
					node.head.text,
					...node.templateSpans.map((span) => span.literal.text),
				].join(" ")
			: ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)
				? node.text
				: undefined;
		if (text && openToolRows.test(text) && busyOrRunEnd.test(text))
			found.push(`${file}:${name}`);
		ts.forEachChild(node, (child) => visit(child, name));
	};
	visit(parsed, "<module>");
	return [...new Set(found)];
}

describe("tool rows never settle busy or a run outside the Run Ledger", () => {
	it("finds only the known path", () => {
		const found = sourceFiles(root)
			.map((file) => relative(root, file))
			.filter((file) => !ledger.some((owned) => file.startsWith(owned)))
			.flatMap((file) =>
				violations(file, readFileSync(join(root, file), "utf8")),
			);
		expect(found).toEqual(known);
	});

	it("catches a split template and a plain string, and passes plain row reads", () => {
		expect(
			violations(
				"a.ts",
				"const idleChildren = (x: string) => sql`UPDATE sessions SET status = 'idle' WHERE id IN (SELECT m.session_id FROM message_parts p JOIN messages m ON ${x} WHERE p.status IN ('started', 'running'))`;\n" +
					"function endTurn() { return \"UPDATE turns SET state = 'done' WHERE NOT EXISTS (SELECT 1 FROM message_parts WHERE status IS NOT 'completed')\"; }",
			),
		).toEqual(["a.ts:idleChildren", "a.ts:endTurn"]);
		expect(
			violations(
				"b.ts",
				"const q = sql`SELECT * FROM message_parts WHERE status IN ('started', 'running')`;",
			),
		).toEqual([]);
	});
});
