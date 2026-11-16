import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface Source {
	readonly path: string;
	readonly text: string;
}

const sharedWriters = [
	"src/lib/domain/relay/Services/provider-runtime-ingestion-service.ts",
	"src/lib/persistence/effect/claude-event-persist-effect.ts",
];

function runnerSources(directory: string): Source[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		// Match on the repo-relative path: the CI runner's home directory is itself named runner.
		const repoPath = relative(process.cwd(), path);
		return entry.isDirectory()
			? runnerSources(path)
			: entry.name.endsWith(".ts") &&
					(repoPath.includes("/runner/") ||
						entry.name.endsWith("-runner-payload.ts"))
				? [{ path: repoPath, text: readFileSync(path, "utf8") }]
				: [];
	});
}

function readOnlyTransaction(node: ts.Node): boolean {
	if (!ts.isCallExpression(node.parent)) return false;
	const body = node.parent.arguments[0];
	if (!body || !ts.isCallExpression(body)) return false;
	let reads = 0;
	let unsafe = false;
	const inspect = (part: ts.Node): void => {
		if (ts.isCallExpression(part) && part.expression.getText() !== "Effect.gen")
			unsafe = true;
		if (ts.isTaggedTemplateExpression(part)) {
			const query = ts.isNoSubstitutionTemplateLiteral(part.template)
				? part.template.text
				: part.template.head.text +
					part.template.templateSpans
						.map((span) => span.literal.text)
						.join("?");
			if (
				part.tag.getText() !== "sql" ||
				!/^\s*SELECT\b/i.test(query) ||
				/\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i.test(query)
			)
				unsafe = true;
			else reads += 1;
		}
		ts.forEachChild(part, inspect);
	};
	inspect(body);
	return reads > 0 && !unsafe;
}

function rawTransactions(source: Source): string[] {
	const file = ts.createSourceFile(
		source.path,
		source.text,
		ts.ScriptTarget.Latest,
		true,
	);
	const failures: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isPropertyAccessExpression(node) &&
				node.name.text === "withTransaction") ||
			(ts.isElementAccessExpression(node) &&
				node.argumentExpression &&
				ts.isStringLiteralLike(node.argumentExpression) &&
				node.argumentExpression.text === "withTransaction")
		) {
			// SELECT-only generators are consistent reads. Opaque callbacks cannot
			// prove that they contain no write, so they must enter through the seam.
			if (!readOnlyTransaction(node)) {
				const line =
					file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
				failures.push(
					`${source.path}:${line}: runner writes must use the commit seam`,
				);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return failures;
}

describe("runner write boundary", () => {
	it("routes every runner transaction through the commit seam", () => {
		const sources = [
			...runnerSources(join(process.cwd(), "src/lib/provider")),
			...sharedWriters.map((path) => ({
				path,
				text: readFileSync(path, "utf8"),
			})),
		];
		expect(sources.flatMap(rawTransactions)).toEqual([]);
	});

	it.each([
		"sql.withTransaction",
		'client["withTransaction"]',
	])("rejects a planted raw %s runner write", (transaction) => {
		expect(
			rawTransactions({
				path: "src/lib/provider/runner/planted.ts",
				text: `yield* ${transaction}(sql\`UPDATE sessions SET title = 'stale'\`);`,
			}),
		).toEqual([
			"src/lib/provider/runner/planted.ts:1: runner writes must use the commit seam",
		]);
	});

	it("rejects a write planted in the read-only transcript snapshot", () => {
		expect(
			rawTransactions({
				path: sharedWriters[1] ?? "",
				text: "const readClaudeSubagentTranscript = () => sql.withTransaction(sql`UPDATE sessions SET title = 'stale'`);",
			}),
		).toHaveLength(1);
	});

	it("accepts a consistent read but rejects an opaque transaction body", () => {
		const path = "src/lib/provider/runner/reader.ts";
		expect(
			rawTransactions({
				path,
				text: "sql.withTransaction(Effect.gen(function* () { return yield* sql`SELECT id FROM sessions`; }));",
			}),
		).toEqual([]);
		expect(
			rawTransactions({
				path,
				text: "sql.withTransaction(unknownBody);",
			}),
		).toHaveLength(1);
	});
});
