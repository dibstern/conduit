#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { parse } from "svelte/compiler";
import ts from "typescript";

const owner = resolve("src/lib/domain/daemon/Services/subprocess.ts");
const longLivedOwners = new Set(
	[
		"src/lib/instance/managed-opencode-process.ts",
		"src/lib/instance/managed-opencode-supervisor.ts",
		"src/lib/provider/codex/app-server/transport.ts",
		"src/lib/provider/runner/process-session-runner.ts",
		"src/lib/terminal/pty-host-client.ts",
	].map((path) => resolve(path)),
);
// Migration debt: one bead per entry (label subprocess-migration, under
// conduit-test-g43i). This list must only shrink;
// new short-lived commands belong in the daemon subprocess owner.
const remainingOneShotCallers = new Set(
	[
		"src/bin/cli-service.ts",
		"src/lib/cli/tls.ts",
		"src/lib/daemon/daemon-utils.ts",
		"src/lib/daemon/keep-awake.ts",
		"src/lib/domain/daemon/Layers/tailscale-serve-layer.ts",
		"src/lib/provider/claude/claude-settings-resolver.ts",
		"src/lib/provider/codex/codex-text-generation.ts",
		"src/lib/provider/cursor/cursor-keychain.ts",
		"src/lib/provider/cursor/cursor-skill-discovery.ts",
		"src/lib/provider/project-shell-env.ts",
		"src/lib/provider/runner/runner-registry.ts",
	].map((path) => resolve(path)),
);
// Shared spawn configuration for long-lived processes may reference types only.
const processContracts = new Set([resolve("src/lib/daemon/daemon-types.ts")]);

function collectSourceFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			return ["generated", "node_modules"].includes(entry.name)
				? []
				: collectSourceFiles(path);
		}
		return entry.isFile() && /\.(?:[cm]?[jt]sx?|svelte)$/.test(entry.name)
			? [path]
			: [];
	});
}

let violations = 0;
function report(file, source, position, message) {
	violations++;
	const path = relative(process.cwd(), file).split(sep).join("/");
	const line = source.slice(0, position).split("\n").length;
	console.error(`${path}:${line}: ${message}`);
}

function checkTs(file, source, text = source, offset = 0) {
	const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	function visit(node) {
		const module =
			ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
				? node.moduleSpecifier
				: ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
					? node.argument.literal
					: ts.isImportEqualsDeclaration(node) &&
							ts.isExternalModuleReference(node.moduleReference)
						? node.moduleReference.expression
						: ts.isCallExpression(node) &&
								(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
									(ts.isIdentifier(node.expression) &&
										node.expression.text === "require"))
							? node.arguments[0]
							: undefined;
		if (
			module &&
			ts.isStringLiteralLike(module) &&
			["node:child_process", "child_process"].includes(module.text)
		) {
			const typeOnly =
				ts.isImportTypeNode(node) ||
				(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
				(ts.isExportDeclaration(node) && node.isTypeOnly) ||
				(ts.isImportEqualsDeclaration(node) && node.isTypeOnly);
			if (!(processContracts.has(file) && typeOnly)) {
				report(
					file,
					source,
					node.getStart(ast) + offset,
					"child_process imports belong in the daemon subprocess owner or an explicit process allowlist.",
				);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
}

function checkSvelte(file, source) {
	let ast;
	try {
		ast = parse(source, { filename: file, modern: true });
	} catch (error) {
		report(
			file,
			source,
			error.position?.[0] ?? 0,
			`Cannot parse Svelte for subprocess imports: ${error.message}`,
		);
		return;
	}
	for (const script of [ast.instance, ast.module]) {
		if (script) {
			const { start, end } = script.content;
			checkTs(file, source, source.slice(start, end), start);
		}
	}
}

const files = collectSourceFiles(resolve("src")).sort();
for (const file of files) {
	if (
		file === owner ||
		longLivedOwners.has(file) ||
		remainingOneShotCallers.has(file)
	)
		continue;
	const source = readFileSync(file, "utf8");
	if (file.endsWith(".svelte")) checkSvelte(file, source);
	else checkTs(file, source);
}
console.log(
	`Subprocess boundary: ${violations} violation(s), ${files.length} source file(s) checked.`,
);
process.exitCode = violations ? 1 : 0;
