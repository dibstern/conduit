import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "src");
const fileRestoreMethods = new Set(["revert", "unrevert", "rewindFiles"]);

function fileRestoreReferences(source: string, file = "source.ts") {
	const references: { line: number; reference: string }[] = [];
	if (!/revert|rewindFiles/.test(source)) return references;
	const scripts = file.endsWith(".svelte")
		? Array.from(
				source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
				(match) => ({
					text: match[1] ?? "",
					offset: match.index + match[0].indexOf(">") + 1,
				}),
			)
		: [{ text: source, offset: 0 }];
	for (const { text, offset } of scripts) {
		const parsed = ts.createSourceFile(
			file,
			text,
			ts.ScriptTarget.Latest,
			true,
		);
		const visit = (node: ts.Node): void => {
			const assignedProperty =
				(ts.isPropertyAssignment(node) ||
					ts.isShorthandPropertyAssignment(node)) &&
				ts.isBinaryExpression(node.parent.parent) &&
				node.parent.parent.left === node.parent &&
				node.parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
			const name = ts.isPropertyAccessExpression(node)
				? node.name
				: ts.isElementAccessExpression(node)
					? node.argumentExpression
					: ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)
						? (node.propertyName ?? node.name)
						: assignedProperty
							? node.name
							: undefined;
			const key =
				name && ts.isComputedPropertyName(name) ? name.expression : name;
			if (
				key &&
				(ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
				fileRestoreMethods.has(key.text)
			) {
				references.push({
					line: source.slice(0, offset + node.getStart(parsed)).split("\n")
						.length,
					reference: node.getText(parsed),
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(parsed);
	}
	return references;
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = join(dir, entry.name);
		return entry.isDirectory()
			? sourceFiles(file)
			: /\.(?:[cm]?[jt]sx?|svelte)$/.test(entry.name)
				? [file]
				: [];
	});
}

describe("provider file restore ownership", () => {
	it("keeps provider file restore references out of src", () => {
		const references = sourceFiles(root).flatMap((file) => {
			const source = readFileSync(file, "utf8");
			return fileRestoreReferences(source, file).map((reference) => ({
				file: relative(process.cwd(), file),
				...reference,
			}));
		});
		expect(
			references,
			"Only Conduit restores files. Truncate native history without restoring files.",
		).toEqual([]);
	});

	it.each([
		"client.session.revert({ sessionID })",
		"client.session.unrevert({ sessionID })",
		"query.rewindFiles(messageId)",
		"client.session?.revert?.({ sessionID })",
		"client.session\n.revert\n({ sessionID })",
		'client.session["revert"]({ sessionID })',
		"const restore = client.session.revert; restore({ sessionID });",
		"const restore = client.session.unrevert; restore({ sessionID });",
		"const restore = query.rewindFiles; restore(messageId);",
		"(client.session.revert)({ sessionID })",
		"(query.rewindFiles)(messageId)",
		"client.session.revert /* forbidden */ ({ sessionID })",
		"query.rewindFiles // forbidden\n(messageId)",
		"const { revert: restore } = client.session; restore({ sessionID });",
		"const { unrevert: restore } = client.session; restore({ sessionID });",
		"const { rewindFiles: restore } = query; restore(messageId);",
		"const { revert } = client.session; revert({ sessionID });",
		'const { ["rewindFiles"]: restore } = query; restore(messageId);',
		'const restore = client.session["unrevert"]; restore({ sessionID });',
		"({ revert: restore } = client.session); restore({ sessionID });",
		"({ unrevert } = client.session); unrevert({ sessionID });",
		"({ rewindFiles: restore } = query); restore(messageId);",
	])("detects %s", (source) => {
		expect(fileRestoreReferences(source)).toHaveLength(1);
	});

	it.each([
		"// query.rewindFiles(messageId)",
		'const documentation = "client.session.revert({ sessionID })";',
		"const { restore: rewindFiles } = conduit; rewindFiles(messageId);",
	])("ignores %s", (source) => {
		expect(fileRestoreReferences(source)).toEqual([]);
	});
});
