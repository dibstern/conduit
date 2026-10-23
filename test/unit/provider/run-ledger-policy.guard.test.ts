import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const directory = join(process.cwd(), "src/lib/provider/run-ledger");
const providerNames = new Set(["claude", "cursor", "opencode"]);

function sourceFiles(path: string): string[] {
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
		const file = join(path, entry.name);
		return entry.isDirectory()
			? sourceFiles(file)
			: file.endsWith(".ts")
				? [file]
				: [];
	});
}

function providerLiterals(file: string, source: string): string[] {
	if (file === "run-ledger-policy-adapters.ts") return [];
	const parsed = ts.createSourceFile(
		file,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const violations: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			file === "run-ledger-model.ts" &&
			ts.isTypeAliasDeclaration(node) &&
			node.name.text === "ProviderKind"
		)
			return;
		if (ts.isStringLiteralLike(node) && providerNames.has(node.text)) {
			const { line, character } = parsed.getLineAndCharacterOfPosition(
				node.getStart(parsed),
			);
			violations.push(`${file}:${line + 1}:${character + 1}: ${node.text}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	return violations;
}

describe("Run Ledger native-policy boundary", () => {
	it("keeps every provider literal in the adapters or ProviderKind", () => {
		const violations = sourceFiles(directory).flatMap((file) => {
			const source = readFileSync(file, "utf8");
			// Deadlines never re-enter the native-policy/correlation boundary as sends.
			expect(source, file).not.toMatch(/\b(?:arm_timer|timer_fired)\b/);
			return providerLiterals(relative(directory, file), source);
		});
		expect(violations).toEqual([]);
	});

	it("detects string and template literals without matching comments", () => {
		expect(
			providerLiterals(
				"run-ledger-decider.ts",
				'// "claude"\nconst a = "claude"; const b = \'cursor\'; const c = `opencode`;',
			),
		).toHaveLength(3);
	});

	it("permits only the public ProviderKind type and policy adapters", () => {
		const source =
			'export type ProviderKind = "claude" | "cursor" | "opencode";\nconst provider = "claude";';
		expect(providerLiterals("run-ledger-model.ts", source)).toEqual([
			"run-ledger-model.ts:2:18: claude",
		]);
		expect(providerLiterals("run-ledger-policy-adapters.ts", source)).toEqual(
			[],
		);
		expect(providerLiterals("other.ts", source)).toHaveLength(4);
	});
});
