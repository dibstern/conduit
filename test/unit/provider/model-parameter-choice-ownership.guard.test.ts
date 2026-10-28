import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const root = process.cwd();
const owner = "src/lib/provider/turn-settings.ts";
const builders: Readonly<Record<string, string>> = {
	"src/lib/provider/cursor/cursor-runner-driver.ts": "cursorModelInfo",
	"src/lib/provider/codex/codex-discovery.ts": "codexModelInfo",
};

// These reads belong to account defaults, context windows or routing scopes,
// not parameter combinations. Counts fail in both directions so the allowance
// cannot silently grow or survive the removal of an unrelated read.
const unrelatedDefaultReads = {
	"src/lib/domain/daemon/Services/instance-manager-service.ts": 1,
	"src/lib/domain/relay/Services/model-catalog.ts": 2,
	"src/lib/frontend/components/layout/UsageFooterMeter.svelte": 2,
	"src/lib/frontend/components/model/InstanceModelPicker.svelte": 4,
	"src/lib/frontend/components/model/ModelSelectionPanel.svelte": 3,
	"src/lib/frontend/components/model/title-model-selection-target.svelte.ts": 1,
	"src/lib/frontend/components/overlays/ClaudeSettingsTab.svelte": 1,
	"src/lib/frontend/components/overlays/CursorAuthSettings.svelte": 1,
	"src/lib/frontend/components/overlays/InstancesSettingsTab.svelte": 3,
	"src/lib/frontend/stores/discovery.svelte.ts": 11,
	"src/lib/frontend/stores/instance.svelte.ts": 3,
};

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory()
			? sourceFiles(path)
			: /\.(ts|svelte)$/.test(path) && !path.endsWith(".stories.ts")
				? [path]
				: [];
	});
}

it("keeps parameter combination and default reads in the choice module and discovery builders", () => {
	const combinationReads: string[] = [];
	const defaultReads: Record<string, number> = {};
	for (const path of sourceFiles(join(root, "src"))) {
		const file = relative(root, path);
		if (file === owner) continue;
		let source = readFileSync(path, "utf8");
		const builder = builders[file];
		if (builder) {
			const parsed = ts.createSourceFile(
				file,
				source,
				ts.ScriptTarget.Latest,
				true,
			);
			const declaration = parsed.statements.find(
				(statement) =>
					ts.isFunctionDeclaration(statement) &&
					statement.name?.text === builder,
			);
			if (!declaration) throw new Error(`Missing discovery builder ${builder}`);
			source =
				source.slice(0, declaration.getStart(parsed)) +
				source.slice(declaration.end);
		}
		const script = file.endsWith(".svelte")
			? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
					.map((match) => match[1] ?? "")
					.join("\n")
			: source;
		const bindings: string[] = [];
		const visit = (node: ts.Node): void => {
			if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
				const name = node.propertyName ?? node.name;
				if (ts.isIdentifier(name) || ts.isStringLiteral(name))
					bindings.push(name.text);
			}
			ts.forEachChild(node, visit);
		};
		visit(ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true));
		if (
			/(?:\?\.|\.)\s*combinations\b|\[\s*["']combinations["']\s*\]/.test(
				source,
			) ||
			bindings.includes("combinations")
		)
			combinationReads.push(file);
		const count =
			[
				...source.matchAll(
					/(?:\?\.|\.)\s*isDefault\b|\[\s*["']isDefault["']\s*\]/g,
				),
			].length + bindings.filter((name) => name === "isDefault").length;
		if (count) defaultReads[file] = count;
	}
	expect(combinationReads).toEqual([]);
	expect(defaultReads).toEqual(unrelatedDefaultReads);
});
