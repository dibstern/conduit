import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../..");
const sourceRoots = ["src", "test", "acceptance"];
const excluded = new Set([
	"node_modules",
	".git",
	".beads",
	".agents",
	"dist",
	"test-results",
	".scratch",
	".worktrees",
]);
const probeRelative = "test/effect4-collision-probe.ts";
const fixturePath = path.join(directory, "collision-probe.ts.txt");
const digest = (value) => createHash("sha256").update(value).digest("hex");

function treeHashes(base) {
	const trees = {};
	for (const sourceRoot of sourceRoots) {
		const files = new Map();
		const visit = (relative) => {
			const absolute = path.join(base, relative);
			for (const entry of fs
				.readdirSync(absolute, { withFileTypes: true })
				.sort((a, b) => a.name.localeCompare(b.name))) {
				const child = path.join(relative, entry.name);
				if (entry.isSymbolicLink())
					throw new Error(`Refusing source symlink: ${child}`);
				if (entry.isDirectory()) visit(child);
				else if (entry.isFile())
					files.set(child, digest(fs.readFileSync(path.join(base, child))));
			}
		};
		visit(sourceRoot);
		trees[sourceRoot] = {
			files: files.size,
			sha256: digest(
				[...files].map(([file, sha]) => `${file}\0${sha}\n`).join(""),
			),
		};
	}
	return trees;
}

function parse(source) {
	return ts.createSourceFile(
		probeRelative,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
}

function declaration(source, name) {
	for (const statement of source.statements) {
		if (ts.isVariableStatement(statement)) {
			const item = statement.declarationList.declarations.find(
				(node) => ts.isIdentifier(node.name) && node.name.text === name,
			);
			if (item) return item;
		} else if (statement.name?.text === name) return statement;
	}
	throw new Error(`Missing probe declaration ${name}`);
}

function collisionBlock(source) {
	const begin = source.indexOf("// COLLISION BLOCK BEGIN");
	const end = source.indexOf("// COLLISION BLOCK END");
	assert(begin >= 0 && end > begin, "Collision markers must exist");
	return source.slice(begin, end + "// COLLISION BLOCK END".length);
}

function inspectProbe(before, after, report) {
	const original = parse(before);
	const transformed = parse(after);
	const imports = new Map();
	for (const statement of transformed.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (bindings && ts.isNamedImports(bindings)) {
			for (const item of bindings.elements)
				imports.set(item.name.text, {
					exported: (item.propertyName ?? item.name).text,
					typeOnly: Boolean(
						statement.importClause.isTypeOnly || item.isTypeOnly,
					),
				});
		} else if (bindings && ts.isNamespaceImport(bindings))
			imports.set(bindings.name.text, {
				exported: "*",
				typeOnly: Boolean(statement.importClause.isTypeOnly),
			});
	}
	assert.equal(
		collisionBlock(after),
		collisionBlock(before),
		"Local collisions changed",
	);
	assert.equal(
		declaration(transformed, "localIntersectionProperty").initializer.getText(
			transformed,
		),
		"mixed.right",
		"Intersection's local right field changed",
	);
	assert.equal(imports.get("EE")?.exported, "Result");
	assert.equal(imports.get("importedCatchAll")?.exported, "catch");
	assert.equal(imports.get("SchemaTypes")?.typeOnly, true);
	const caught = declaration(transformed, "actualCatch").initializer;
	assert(
		ts.isCallExpression(caught) &&
			ts.isElementAccessExpression(caught.expression),
	);
	assert.equal(caught.expression.argumentExpression.text, "catch");
	for (const name of ["actualUnion", "namespacedUnion"]) {
		const call = declaration(transformed, name).initializer;
		assert(
			ts.isCallExpression(call) &&
				call.arguments.length === 1 &&
				ts.isArrayLiteralExpression(call.arguments[0]),
			`${name} did not receive an array`,
		);
	}
	const literals = declaration(transformed, "actualLiteral").initializer;
	assert(
		ts.isCallExpression(literals) &&
			ts.isPropertyAccessExpression(literals.expression),
	);
	assert.equal(literals.expression.name.text, "Literals");
	assert(
		literals.arguments.length === 1 &&
			ts.isArrayLiteralExpression(literals.arguments[0]),
	);
	for (const [name, variant] of [
		["LeftVariant", "Failure"],
		["RightVariant", "Success"],
	]) {
		const type = declaration(transformed, name).type;
		assert(ts.isTypeReferenceNode(type) && ts.isQualifiedName(type.typeName));
		assert.equal(type.typeName.right.text, variant);
		assert.deepEqual(
			type.typeArguments.map((argument) => argument.getText(transformed)),
			["number", "string"],
		);
	}
	const either = declaration(transformed, "actualEither");
	const properties = new Set();
	const tags = [];
	const visitEither = (node) => {
		if (ts.isPropertyAccessExpression(node)) properties.add(node.name.text);
		if (ts.isStringLiteral(node)) tags.push(node.text);
		ts.forEachChild(node, visitEither);
	};
	visitEither(either);
	for (const property of ["fail", "succeed", "failure", "success"])
		assert(properties.has(property), `Either ${property} migration missing`);
	assert(tags.includes("Failure") && !tags.includes("Left"));
	const shadowed = declaration(transformed, "nullLiteralWithShadowedNamespace");
	const nullReferences = [];
	const visitNull = (node) => {
		if (ts.isPropertyAccessExpression(node) && node.name.text === "Null")
			nullReferences.push(node.expression.getText(transformed));
		ts.forEachChild(node, visitNull);
	};
	visitNull(shadowed);
	assert.equal(nullReferences.length, 2);
	assert.equal(nullReferences[0], "Schema", "Local Schema parameter changed");
	assert.notEqual(
		nullReferences[1],
		"Schema",
		"Generated Null access uses a shadowed namespace",
	);
	assert.equal(
		imports.get(nullReferences[1])?.typeOnly,
		false,
		"Generated Null access needs a runtime import",
	);
	for (const name of ["UnsupportedEitherImport", "unsupportedPartialHandler"]) {
		const old = declaration(original, name);
		const next = declaration(transformed, name);
		assert.equal(
			next.getText(transformed),
			old.getText(original),
			`${name} must stay unchanged`,
		);
		const firstLine =
			original.getLineAndCharacterOfPosition(old.getStart(original)).line + 1;
		const lastLine = original.getLineAndCharacterOfPosition(old.end).line + 1;
		assert(
			report.entries.some(
				(entry) =>
					entry.file === probeRelative &&
					entry.status === "skipped" &&
					entry.line >= firstLine &&
					entry.line <= lastLine,
			),
			`${name} must be reported`,
		);
	}
	return {
		localCollisionBlockUnchanged: true,
		intersectionLocalPropertyUnchanged: true,
		aliasedAndBracketImportsMigrated: true,
		unionAndLiteralShapesMigrated: true,
		eitherFieldsTagsAndVariantTypeOrderMigrated: true,
		typeOnlyAndShadowedNamespacesSafe: true,
		unsupportedFormsUnchangedAndReported: true,
	};
}

function checkV3Probe(file) {
	const config = ts.getParsedCommandLineOfConfigFile(
		path.resolve(path.dirname(file), "../tsconfig.json"),
		{ noEmit: true },
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
				throw new Error(
					ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
				);
			},
		},
	);
	assert(config && config.errors.length === 0, "Original tsconfig must parse");
	const program = ts.createProgram([file], config.options);
	const diagnostics = ts.getPreEmitDiagnostics(program);
	assert.equal(
		diagnostics.length,
		0,
		diagnostics
			.slice(0, 8)
			.map((diagnostic) =>
				ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
			)
			.join("\n"),
	);
}

function main() {
	let scratch;
	let keepScratch = false;
	const args = process.argv.slice(2);
	while (args.length) {
		const arg = args.shift();
		if (arg === "--scratch") {
			const value = args.shift();
			assert(value && !value.startsWith("--"), "--scratch requires a path");
			scratch = path.resolve(value);
		} else if (arg === "--keep-scratch") keepScratch = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!scratch)
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "effect4-safety-"));
	else {
		const parent = fs.realpathSync(path.dirname(scratch));
		const tempRoots = [os.tmpdir(), "/tmp"].map((entry) =>
			fs.realpathSync(entry),
		);
		assert(
			tempRoots.some(
				(entry) => parent === entry || parent.startsWith(`${entry}${path.sep}`),
			),
			"Scratch must be under a temporary directory",
		);
		assert(scratch !== root, "Scratch must be outside the original checkout");
		if (fs.existsSync(scratch) && fs.readdirSync(scratch).length)
			assert(
				keepScratch,
				"A nonempty supplied scratch requires --keep-scratch",
			);
		fs.mkdirSync(scratch, { recursive: true });
	}
	const commands = [];
	const originalHashes = treeHashes(root);
	try {
		fs.cpSync(root, scratch, {
			recursive: true,
			verbatimSymlinks: true,
			filter: (source) =>
				!path
					.relative(root, source)
					.split(path.sep)
					.some((part) => excluded.has(part)),
		});
		const modules = path.join(scratch, "node_modules");
		if (fs.existsSync(modules))
			assert.equal(
				fs.realpathSync(modules),
				fs.realpathSync(path.join(root, "node_modules")),
				"Scratch must use the original v3 node_modules",
			);
		else fs.symlinkSync(path.join(root, "node_modules"), modules, "dir");
		const probe = path.join(scratch, probeRelative);
		const fixture = fs.readFileSync(fixturePath, "utf8");
		fs.writeFileSync(probe, fixture);
		checkV3Probe(probe);
		const before = treeHashes(scratch);
		const invoke = (name) => {
			const report = path.join(
				"test-results/effect4-codemod-safety",
				`${name}.md`,
			);
			const command = {
				executable: process.execPath,
				args: [
					path.join(directory, "index.mjs"),
					"--root",
					scratch,
					"--write",
					"--report",
					report,
				],
				cwd: root,
			};
			const result = spawnSync(command.executable, command.args, {
				cwd: command.cwd,
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			});
			commands.push({
				...command,
				exitCode: result.status,
				output: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-4000),
			});
			assert.equal(
				result.status,
				0,
				result.error?.message ?? commands.at(-1).output,
			);
			return JSON.parse(
				fs.readFileSync(path.join(root, `${report.slice(0, -3)}.json`), "utf8"),
			);
		};
		const first = invoke("first");
		const afterFirst = treeHashes(scratch);
		const firstProbe = fs.readFileSync(probe, "utf8");
		const checks = inspectProbe(fixture, firstProbe, first);
		const second = invoke("second");
		const afterSecond = treeHashes(scratch);
		assert.deepEqual(
			afterSecond,
			afterFirst,
			"Second run changed source tree hashes",
		);
		assert.equal(second.files, 0, "Second run reports changed files");
		assert.equal(second.edits.length, 0, "Second run reports edits");
		assert.deepEqual(
			treeHashes(root),
			originalHashes,
			"Original source tree changed during safety run",
		);
		const proof = {
			command: "node scripts/effect4-codemod/self-check.mjs",
			fixture: {
				path: "scripts/effect4-codemod/collision-probe.ts.txt",
				sha256: digest(fixture),
				v3TypecheckDiagnostics: 0,
				transformedSha256: digest(firstProbe),
			},
			commands,
			sourceTreeHashes: { before, afterFirst, afterSecond },
			firstRun: { files: first.files, edits: first.edits.length },
			secondRun: { files: second.files, edits: second.edits.length },
			checks: {
				...checks,
				fullSourceTreeSecondRunUnchanged: true,
				originalSourceTreeUnchanged: true,
			},
		};
		const artifact = path.join(directory, "SAFETY.json");
		// Committed: must not name this machine's home directory.
		const portable = (_key, value) =>
			typeof value === "string"
				? value.replaceAll(root, ".").replaceAll(os.homedir(), "~")
				: value;
		fs.writeFileSync(artifact, `${JSON.stringify(proof, portable, "\t")}\n`);
		console.log(
			`Safety checks passed. ${path.relative(root, artifact)}; second run: 0 files, 0 edits.`,
		);
	} finally {
		if (!keepScratch) fs.rmSync(scratch, { recursive: true, force: true });
		else console.log(`Scratch retained: ${scratch}`);
	}
}

main();
