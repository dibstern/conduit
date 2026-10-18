#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const transforms = [
	"imports",
	"services",
	"generators",
	"layers",
	"catch",
	"either",
	"fork",
	"option",
	"schema",
	"testing",
	"core",
];
const args = process.argv.slice(2);
const options = {
	keepScratch: false,
	skipInstall: false,
	reclassifyLogs: false,
	prune: false,
	transform: [],
};
for (let index = 0; index < args.length; index++) {
	const argument = args[index];
	if (argument === "--keep-scratch") options.keepScratch = true;
	else if (argument === "--skip-install") options.skipInstall = true;
	else if (argument === "--reclassify-logs") options.reclassifyLogs = true;
	else if (argument === "--prune") options.prune = true;
	else if (["--scratch", "--output", "--transform"].includes(argument)) {
		const value = args[++index];
		if (!value || value.startsWith("--"))
			throw new Error(`${argument} needs a value`);
		if (argument === "--transform") options.transform.push(value);
		else options[argument.slice(2)] = path.resolve(value);
	} else if (argument === "--help") {
		console.log(
			"node scripts/effect4-codemod/measure.mjs [--scratch DIR] [--skip-install] [--keep-scratch] [--transform NAME] [--output DIR] [--reclassify-logs] [--prune]",
		);
		process.exit(0);
	} else throw new Error(`Unknown argument: ${argument}`);
}
for (const transform of options.transform) {
	if (![...transforms, "combined"].includes(transform))
		throw new Error(`Unknown transform: ${transform}`);
}

const output = options.output ?? path.join(root, "scripts/effect4-codemod");
const artifacts = path.join(root, "test-results/effect4-codemod-measurements");
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
const projects = ["tsconfig.json", "src/lib/frontend/tsconfig.json"];
const commands = [];
let scratch;
let originals = new Map();
const semanticSites = new Map();

function apiCategory(module, name) {
	if (
		["Context", "Effect"].includes(module) &&
		["Tag", "Service"].includes(name)
	)
		return "services";
	if (module === "Effect" && name === "gen") return "generators";
	if (module === "Effect" && name.startsWith("catch")) return "catch";
	if (module === "Effect" && name.startsWith("fork")) return "fork";
	if (module === "Either") return "either";
	if (module === "Option") return "option";
	if (module === "Layer") return "layers";
	if (module === "Schema") return "schema";
	if (["TestClock", "TestContext", "@effect/vitest"].includes(module))
		return "testing";
	return "core";
}

function buildSemanticSites() {
	for (const project of projects) {
		console.log(`Indexing Effect API sites: ${project}`);
		const config = ts.getParsedCommandLineOfConfigFile(
			path.join(root, project),
			{},
			{
				...ts.sys,
				onUnRecoverableConfigFileDiagnostic(diagnostic) {
					throw new Error(
						ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
					);
				},
			},
		);
		const program = ts.createProgram(config.fileNames, config.options);
		const checker = program.getTypeChecker();
		let effectBindings = new Set();
		function resolvedCategory(node) {
			let target = node;
			while (ts.isCallExpression(target)) target = target.expression;
			// Only a directly imported function or namespace member is an
			// export site. Resolving `.pipe` on an instantiated Effect both
			// misclassifies a method and needlessly instantiates its type.
			if (ts.isPropertyAccessExpression(target)) {
				if (
					!ts.isIdentifier(target.expression) ||
					!effectBindings.has(target.expression.text)
				)
					return undefined;
				target = target.name;
			} else if (!ts.isIdentifier(target) || !effectBindings.has(target.text))
				return undefined;
			let symbol = checker.getSymbolAtLocation(target);
			const seen = new Set();
			while (
				symbol &&
				symbol.flags & ts.SymbolFlags.Alias &&
				!seen.has(symbol)
			) {
				seen.add(symbol);
				symbol = checker.getAliasedSymbol(symbol);
			}
			for (const declaration of symbol?.declarations ?? []) {
				const file = declaration
					.getSourceFile()
					.fileName.split(path.sep)
					.join("/");
				const marker = file.lastIndexOf("/node_modules/");
				if (marker === -1) continue;
				const packagePath = file.slice(marker + "/node_modules/".length);
				if (
					!packagePath.startsWith("effect/") &&
					!packagePath.startsWith("@effect/")
				)
					continue;
				const module = packagePath.startsWith("@effect/vitest/")
					? "@effect/vitest"
					: path.basename(file).replace(/\.d\.ts$|\.ts$/, "");
				return apiCategory(module, symbol.getName());
			}
			return undefined;
		}
		for (const source of program.getSourceFiles()) {
			if (
				!source.fileName.startsWith(`${root}${path.sep}`) ||
				source.fileName.includes(`${path.sep}node_modules${path.sep}`)
			)
				continue;
			const file = path
				.relative(root, source.fileName)
				.split(path.sep)
				.join("/");
			if (semanticSites.has(file)) continue;
			effectBindings = new Set();
			for (const statement of source.statements) {
				if (
					!ts.isImportDeclaration(statement) ||
					!ts.isStringLiteral(statement.moduleSpecifier)
				)
					continue;
				const module = statement.moduleSpecifier.text;
				if (
					module !== "effect" &&
					!module.startsWith("effect/") &&
					!module.startsWith("@effect/")
				)
					continue;
				const clause = statement.importClause;
				if (clause?.name) effectBindings.add(clause.name.text);
				const bindings = clause?.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings))
					effectBindings.add(bindings.name.text);
				if (bindings && ts.isNamedImports(bindings))
					for (const element of bindings.elements)
						effectBindings.add(element.name.text);
			}
			const sites = [];
			function add(node, category, end = node.end) {
				if (category)
					sites.push({ start: node.getStart(source), end, category });
			}
			function visit(node) {
				if (
					ts.isIdentifier(node) &&
					!(
						ts.isPropertyAccessExpression(node.parent) &&
						node.parent.expression === node
					)
				) {
					add(
						node,
						resolvedCategory(
							ts.isPropertyAccessExpression(node.parent) ? node.parent : node,
						),
					);
				}
				if (ts.isCallExpression(node)) {
					const category = resolvedCategory(node.expression);
					add(node.expression, category);
					for (const argument of node.arguments) {
						// Include a callback's signature only. Its body can contain
						// independent migration errors and must keep its own category.
						const end =
							ts.isFunctionExpression(argument) || ts.isArrowFunction(argument)
								? argument.body.getStart(source)
								: argument.getStart(source) + 1;
						add(argument, category, end);
					}
				}
				if (ts.isClassDeclaration(node) && node.name) {
					for (const clause of node.heritageClauses ?? []) {
						for (const type of clause.types) {
							if (resolvedCategory(type.expression) === "services")
								add(node.name, "services");
						}
					}
				}
				ts.forEachChild(node, visit);
			}
			visit(source);
			semanticSites.set(file, sites);
		}
	}
}

async function classifyDiagnostics(
	diagnostics,
	edits,
	readSource = (file) => readFile(path.join(scratch, file), "utf8"),
) {
	const sources = new Map();
	for (const diagnostic of diagnostics) {
		if (!diagnostic.file) continue;
		if (!sources.has(diagnostic.file))
			sources.set(diagnostic.file, await readSource(diagnostic.file));
		const position = originalPosition(
			offset(sources.get(diagnostic.file), diagnostic.line, diagnostic.column),
			edits.get(diagnostic.file) ?? [],
		);
		const sites = semanticSites.get(diagnostic.file) ?? [];
		const site = sites
			.filter(
				(candidate) => candidate.start <= position && position < candidate.end,
			)
			.sort((a, b) => a.end - a.start - (b.end - b.start))[0];
		if (site) diagnostic.category = site.category;
	}
	return diagnostics;
}

async function run(command, argv, cwd, log) {
	commands.push({ command: [command, ...argv], cwd, log });
	const chunks = [];
	const child = spawn(command, argv, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	for (const stream of [child.stdout, child.stderr]) {
		stream.on("data", (chunk) => chunks.push(chunk));
	}
	const exitCode = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	const text = Buffer.concat(chunks).toString();
	await writeFile(log, text);
	return { exitCode, text };
}

function counts(diagnostics, select) {
	const result = {};
	for (const diagnostic of diagnostics) {
		const key = select(diagnostic);
		result[key] = (result[key] ?? 0) + 1;
	}
	return Object.fromEntries(
		Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
	);
}

// These categories describe the compiler's reported API, not the transform
// being measured. This prevents an edit from redefining its own success.
function category(diagnostic) {
	const message = diagnostic.message;
	if (diagnostic.code === 2307 || diagnostic.code === 7016) return "imports";
	if (
		/\b(Context\.Tag|Effect\.Tag|Effect\.Service|TagClass|Tag\.Service)\b|Property 'Tag'|Property 'Service'/.test(
			message,
		)
	)
		return "services";
	if (
		/\b(catchAll|catchAllCause|catchSome|catchSomeCause|catchTag|catchTags|catchIf)\b/.test(
			message,
		)
	)
		return "catch";
	if (
		/\b(Either|Left|Right)\b|Property '(left|right|isLeft|isRight)'/.test(
			message,
		)
	)
		return "either";
	if (
		/\b(forkDaemon|forkScoped|forkIn|forkAll|forkWithErrorHandler)\b|Property 'fork'/.test(
			message,
		)
	)
		return "fork";
	if (
		/\b(Option|fromNullable|getOrNull|getOrUndefined|isNone|isSome)\b/.test(
			message,
		)
	)
		return "option";
	if (
		/\b(Schema|decodeUnknown|decodeSync|encodeSync|filterEffect|Literal|Tuple|Union)\b/.test(
			message,
		)
	)
		return "schema";
	if (
		/\b(TestClock|TestContext)\b|Property '(scoped|effect)' does not exist on type 'Vitest/.test(
			message,
		)
	)
		return "testing";
	if (/\b(Layer|scopedDiscard|scopedContext|effectDiscard)\b/.test(message))
		return "layers";
	if (
		/\bgen\b|this context|this' implicitly|implicitly has type 'any'.*this/.test(
			message,
		)
	)
		return "generators";
	if (
		/\b(runtime|Runtime|ManagedRuntime|Fiber|Scope|Cause|Exit|Queue|Stream|Chunk|Data|Duration|Deferred|Ref)\b/.test(
			message,
		)
	)
		return "core";
	return "other";
}

function parseDiagnostics(text, project) {
	const diagnostics = [];
	for (const line of text.split("\n")) {
		const match = /^(.*?)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
		const global = /^error TS(\d+): (.*)$/.exec(line);
		if (match) {
			diagnostics.push({
				project,
				file: path
					.relative(scratch, path.resolve(scratch, match[1]))
					.split(path.sep)
					.join("/"),
				line: Number(match[2]),
				column: Number(match[3]),
				code: Number(match[4]),
				message: match[5],
			});
		} else if (global) {
			diagnostics.push({
				project,
				file: "",
				line: 0,
				column: 0,
				code: Number(global[1]),
				message: global[2],
			});
		} else if (diagnostics.length && /^\s/.test(line)) {
			diagnostics.at(-1).message += `\n${line}`;
		}
	}
	return diagnostics.map((diagnostic) => ({
		...diagnostic,
		category: category(diagnostic),
	}));
}

async function compile(label, edits = new Map()) {
	const diagnostics = [];
	for (const [index, project] of projects.entries()) {
		const result = await run(
			"pnpm",
			["exec", "tsc", "--noEmit", "--pretty", "false", "--project", project],
			scratch,
			path.join(artifacts, `${label}-${index === 0 ? "root" : "frontend"}.log`),
		);
		const parsed = parseDiagnostics(result.text, project);
		if (result.exitCode !== 0 && parsed.length === 0) {
			throw new Error(
				`${label}: tsc failed without parseable diagnostics; see ${commands.at(-1).log}`,
			);
		}
		diagnostics.push(...parsed);
	}
	return classifyDiagnostics(diagnostics, edits);
}

async function sourceFingerprint() {
	const files = new Set(["package.json", ...projects]);
	for (const project of projects) {
		const config = ts.getParsedCommandLineOfConfigFile(
			path.join(root, project),
			{},
			{
				...ts.sys,
				onUnRecoverableConfigFileDiagnostic(diagnostic) {
					throw new Error(
						ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
					);
				},
			},
		);
		for (const file of config.fileNames) files.add(path.relative(root, file));
	}
	const hash = createHash("sha256");
	for (const file of [...files].sort())
		hash.update(file).update(await readFile(path.join(root, file)));
	return hash.digest("hex");
}

async function restore() {
	for (const [file, text] of originals)
		await writeFile(path.join(scratch, file), text);
	originals = new Map();
}

async function applyEdits(edits, patchFile) {
	const grouped = Map.groupBy(edits, (edit) => edit.file);
	const expected = new Map();
	for (const [file, changes] of grouped) {
		const target = path.resolve(scratch, file);
		if (!target.startsWith(`${scratch}${path.sep}`))
			throw new Error(`Unsafe edit path: ${file}`);
		const original = await readFile(path.join(root, file), "utf8");
		if ((await readFile(target, "utf8")) !== original)
			throw new Error(`Scratch source differs from v3 source: ${file}`);
		originals.set(file, original);
		let changed = original;
		for (const edit of [...changes].sort(
			(a, b) => b.start - a.start || b.end - a.end,
		)) {
			if (changed.slice(edit.start, edit.end) !== edit.before)
				throw new Error(`Edit no longer matches: ${file}:${edit.start}`);
			changed =
				changed.slice(0, edit.start) + edit.after + changed.slice(edit.end);
		}
		expected.set(target, changed);
	}
	if (edits.length) {
		const applied = await run(
			"git",
			["apply", "--whitespace=nowarn", patchFile],
			scratch,
			`${patchFile}.apply.log`,
		);
		if (applied.exitCode !== 0)
			throw new Error(`Patch application failed: ${patchFile}.apply.log`);
		for (const [target, changed] of expected)
			if ((await readFile(target, "utf8")) !== changed)
				throw new Error(
					`Unified patch differs from checker edit list: ${target}`,
				);
	}
	return grouped;
}

function offset(text, line, column) {
	let result = 0;
	for (let current = 1; current < line; current++) {
		const newline = text.indexOf("\n", result);
		if (newline === -1) return text.length;
		result = newline + 1;
	}
	return result + column - 1;
}

const tokenMappings = new WeakMap();

function tokenMapping(edit) {
	if (tokenMappings.has(edit)) return tokenMappings.get(edit);
	function tokens(text) {
		const scanner = ts.createScanner(
			ts.ScriptTarget.Latest,
			true,
			ts.LanguageVariant.Standard,
			text,
		);
		const tokens = [];
		let kind = scanner.scan();
		while (kind !== ts.SyntaxKind.EndOfFileToken) {
			tokens.push({
				key: `${kind}:${scanner.getTokenText()}`,
				start: scanner.getTokenPos(),
				end: scanner.getTextPos(),
			});
			kind = scanner.scan();
		}
		return tokens;
	}
	const before = Map.groupBy(tokens(edit.before), (token) => token.key);
	const occurrence = new Map();
	const mapping = tokens(edit.after).map((token) => {
		const index = occurrence.get(token.key) ?? 0;
		occurrence.set(token.key, index + 1);
		return { ...token, original: before.get(token.key)?.[index] };
	});
	tokenMappings.set(edit, mapping);
	return mapping;
}

function originalPosition(position, edits) {
	let displacement = 0;
	for (const edit of [...edits].sort(
		(a, b) => a.start - b.start || a.end - b.end,
	)) {
		const start = edit.start + displacement;
		if (position < start) break;
		if (position < start + edit.after.length) {
			const relative = position - start;
			const token = tokenMapping(edit).find(
				(token) => token.start <= relative && relative < token.end,
			);
			if (token?.original)
				return (
					edit.start +
					token.original.start +
					Math.min(
						relative - token.start,
						token.original.end - token.original.start - 1,
					)
				);
			return edit.start;
		}
		displacement += edit.after.length - (edit.end - edit.start);
	}
	return position - displacement;
}

async function identities(
	diagnostics,
	edits = new Map(),
	readSource = (file) => readFile(path.join(scratch, file), "utf8"),
) {
	const sources = new Map();
	const identities = new Map();
	for (const diagnostic of diagnostics) {
		let position = 0;
		if (diagnostic.file) {
			if (!sources.has(diagnostic.file))
				sources.set(diagnostic.file, await readSource(diagnostic.file));
			position = offset(
				sources.get(diagnostic.file),
				diagnostic.line,
				diagnostic.column,
			);
			position = originalPosition(position, edits.get(diagnostic.file) ?? []);
		}
		const key = JSON.stringify([
			diagnostic.project,
			diagnostic.file,
			position,
			diagnostic.code,
			diagnostic.message,
		]);
		const list = identities.get(key) ?? [];
		list.push(diagnostic);
		identities.set(key, list);
	}
	return identities;
}

function introduced(before, after) {
	const result = [];
	for (const [key, diagnostics] of after)
		result.push(...diagnostics.slice(before.get(key)?.length ?? 0));
	return result;
}

function summary(diagnostics) {
	return {
		total: diagnostics.length,
		byCode: counts(diagnostics, (item) => `TS${item.code}`),
		byCategory: counts(diagnostics, (item) => item.category),
	};
}

function measurement(name, editCount, baseline, after, newDiagnostics) {
	const beforeSummary = summary(baseline);
	const afterSummary = summary(after);
	const outside =
		name === "combined"
			? newDiagnostics
			: newDiagnostics.filter((item) => item.category !== name);
	const ownBefore =
		name === "combined"
			? baseline.length
			: (beforeSummary.byCategory[name] ?? 0);
	const ownAfter =
		name === "combined" ? after.length : (afterSummary.byCategory[name] ?? 0);
	const passed =
		ownAfter < ownBefore &&
		after.length < baseline.length &&
		outside.length === 0;
	return {
		edits: editCount,
		after: afterSummary,
		ownBefore,
		ownAfter,
		introduced: newDiagnostics.length,
		introducedByCategory: counts(newDiagnostics, (item) => item.category),
		introducedOutsideCategory: outside.length,
		categoryDelta: Object.fromEntries(
			[
				...new Set([
					...Object.keys(beforeSummary.byCategory),
					...Object.keys(afterSummary.byCategory),
				]),
			]
				.sort()
				.map((category) => [
					category,
					(afterSummary.byCategory[category] ?? 0) -
						(beforeSummary.byCategory[category] ?? 0),
				]),
		),
		result:
			editCount === 0 ? "UNMEASURED (no sites)" : passed ? "PASS" : "FAIL",
	};
}

// Committed artifacts must not name this machine's home directory
// (test/unit/fixtures-redacted.test.ts).
const portable = (_key, value) =>
	typeof value === "string"
		? value.replaceAll(root, ".").replaceAll(homedir(), "~")
		: value;

async function saveResult(result) {
	await writeFile(
		path.join(output, "measurements.json"),
		`${JSON.stringify(result, portable, "\t")}\n`,
	);
	await writeFile(path.join(output, "MEASUREMENTS.md"), markdown(result));
	let deferred = {};
	try {
		deferred = JSON.parse(
			await readFile(
				path.join(root, "scripts/effect4-codemod/deferred.json"),
				"utf8",
			),
		);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (Object.keys(deferred).length === 0) {
		await writeFile(
			path.join(artifacts, "attempted-measurements.json"),
			`${JSON.stringify(result, portable, "\t")}\n`,
		);
	}
}

function loggedSourceReader(edits) {
	const sources = new Map();
	return (file) => {
		if (!sources.has(file))
			sources.set(
				file,
				readFile(path.join(root, file), "utf8").then((original) => {
					let text = original;
					for (const edit of [...(edits.get(file) ?? [])].sort(
						(a, b) => b.start - a.start || b.end - a.end,
					)) {
						if (text.slice(edit.start, edit.end) !== edit.before)
							throw new Error(
								`Cached edit no longer matches v3 source: ${file}:${edit.start}`,
							);
						text =
							text.slice(0, edit.start) + edit.after + text.slice(edit.end);
					}
					return text;
				}),
			);
		return sources.get(file);
	};
}

async function reclassifyLogs() {
	const previous = JSON.parse(
		await readFile(path.join(output, "measurements.json"), "utf8"),
	);
	const fingerprint = await sourceFingerprint();
	if (previous.sourceFingerprint !== fingerprint)
		throw new Error(
			"Original v3 source changed since these logs were captured; rerun measurements",
		);
	scratch =
		options.scratch ??
		previous.commands.find((entry) => entry.command.includes("tsc"))?.cwd ??
		tmpdir();
	buildSemanticSites();
	async function loggedDiagnostics(label) {
		const diagnostics = [];
		for (const [index, project] of projects.entries()) {
			const text = await readFile(
				path.join(
					artifacts,
					`${label}-${index === 0 ? "root" : "frontend"}.log`,
				),
				"utf8",
			);
			if (text.length && !text.endsWith("\n"))
				throw new Error(`Compiler log may still be in progress: ${label}`);
			diagnostics.push(...parseDiagnostics(text, project));
		}
		return diagnostics;
	}
	const baselineReader = loggedSourceReader(new Map());
	const baseline = await classifyDiagnostics(
		await loggedDiagnostics("baseline"),
		new Map(),
		baselineReader,
	);
	const before = await identities(baseline, new Map(), baselineReader);
	const result = {
		...previous,
		baseline: summary(baseline),
		transforms: {},
		reclassifiedFromLogs: true,
	};
	for (const name of options.transform.length
		? options.transform
		: [...transforms, "combined"]) {
		let document;
		try {
			document = JSON.parse(
				await readFile(path.join(artifacts, `${name}.json`), "utf8"),
			);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			console.log(`${name}: no cached codemod report; skipped`);
			continue;
		}
		const edits = Map.groupBy(document.edits, (edit) => edit.file);
		const reader = loggedSourceReader(edits);
		let after;
		try {
			after = document.edits.length
				? await classifyDiagnostics(
						await loggedDiagnostics(name),
						edits,
						reader,
					)
				: baseline;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			console.log(`${name}: compiler logs incomplete; skipped`);
			continue;
		}
		const newDiagnostics = introduced(
			before,
			await identities(after, edits, reader),
		);
		const row = measurement(
			name,
			document.edits.length,
			baseline,
			after,
			newDiagnostics,
		);
		result.transforms[name] = row;
		await writeFile(
			path.join(artifacts, `${name}-introduced.json`),
			`${JSON.stringify(newDiagnostics, null, 2)}\n`,
		);
		console.log(
			`${name}: ${baseline.length} -> ${after.length}; own ${row.ownBefore} -> ${row.ownAfter}; ${row.introducedOutsideCategory} new outside category; ${row.result}`,
		);
	}
	await saveResult(result);
	process.exitCode = Object.values(result.transforms).some(
		(row) => row.result === "FAIL",
	)
		? 1
		: 0;
}

function markdown(result) {
	const lines = [
		"# Effect 4 codemod measurements",
		"",
		"Run `node scripts/effect4-codemod/measure.mjs`. The harness copies the current v3 sources outside the worktree, installs the pinned v4 dependencies, checks both tsconfigs, and restores the original v3 files before measuring each transform independently. The codemod resolves symbols against the original v3 tree and exports edits without changing it.",
		"",
		`Source SHA-256: \`${result.sourceFingerprint}\`. TypeScript: \`${result.typescript}\`. Node: \`${result.node}\`.`,
		"",
		"Scratch dependencies: `effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`, `@effect/opentelemetry`, and `@effect/vitest`, each exactly `4.0.5`. Consolidated `@effect/platform`, `@effect/rpc`, `@effect/sql`, and `@effect/experimental` are removed.",
		"",
		"Commands (in the scratch copy):",
		"",
		"```sh",
		"pnpm install --no-frozen-lockfile --ignore-scripts",
		"pnpm exec tsc --noEmit --pretty false --project tsconfig.json",
		"pnpm exec tsc --noEmit --pretty false --project src/lib/frontend/tsconfig.json",
		"```",
		"",
		`Baseline: **${result.baseline.total} diagnostics** (root and frontend counts include duplicate diagnostics in shared files).`,
		"",
		"| Transform | Edits | Before | After | Own category before → after | New outside category | Result |",
		"| --- | ---: | ---: | ---: | ---: | ---: | --- |",
	];
	for (const name of [...transforms, "combined"]) {
		const row = result.transforms[name];
		if (!row) continue;
		lines.push(
			`| ${name} | ${row.edits} | ${result.baseline.total} | ${row.after.total} | ${row.ownBefore} → ${row.ownAfter} | ${row.introducedOutsideCategory} | ${row.result} |`,
		);
	}
	const measured = [...transforms, "combined"].filter(
		(name) => result.transforms[name],
	);
	const categories = [
		...new Set([
			...Object.keys(result.baseline.byCategory),
			...measured.flatMap((name) =>
				Object.keys(result.transforms[name].after.byCategory),
			),
		]),
	].sort();
	lines.push(
		"",
		"## All diagnostic categories",
		"",
		"Each transform column is its after count; every transform starts from the same baseline.",
		"",
		`| Category | Baseline | ${measured.join(" | ")} |`,
		`| --- | ---: | ${measured.map(() => "---:").join(" | ")} |`,
	);
	for (const category of categories)
		lines.push(
			`| ${category} | ${result.baseline.byCategory[category] ?? 0} | ${measured.map((name) => result.transforms[name].after.byCategory[category] ?? 0).join(" | ")} |`,
		);
	lines.push(
		"",
		"The JSON artifact contains total, TS diagnostic-code and API-category counts and category deltas for every run. Categories use the original v3 AST and type-checker-resolved Effect exports at the failing API site, with diagnostic codes/messages as fallback. Callback signatures can belong to their calling API; callback bodies retain their independent categories. Unclassified errors remain `other`. New diagnostics are compared as multisets using file, project, code, complete message, and original source offset (edits are reversed for location matching). A transform passes only when its category decreases, its total decreases, and it introduces no diagnostics outside its category. A transform with no applicable sites is recorded as unmeasured, never as passing.",
		"",
		"Raw compiler logs, patches, codemod reports, and introduced-diagnostic details are retained under `test-results/effect4-codemod-measurements/`; the scratch copy is removed unless `--keep-scratch` is supplied. `.svelte` files are not analyzed by `tsc`; the codemod report lists those separately.",
		"",
		"## Collision and rerun proof",
		"",
		"Run `node scripts/effect4-codemod/self-check.mjs`. [SAFETY.json](SAFETY.json) records the type-checked probe, unchanged local `catchAll`, `Either` and `Literal` symbols, positive aliased Effect rewrites, and source-tree hashes before and after two runs. It requires the second run to produce zero files and zero edits and verifies the original checkout stayed unchanged. The temporary copy is removed automatically.",
		"",
	);
	return lines.join("\n");
}

async function main() {
	await mkdir(artifacts, { recursive: true });
	await mkdir(output, { recursive: true });
	if (options.reclassifyLogs) return reclassifyLogs();
	scratch =
		options.scratch ?? (await mkdtemp(path.join(tmpdir(), "effect4-measure-")));
	scratch = await realpath(scratch);
	if (scratch === root || scratch.startsWith(`${root}${path.sep}`))
		throw new Error("Scratch copy must be outside the worktree");
	if (!scratch.startsWith(`${await realpath(tmpdir())}${path.sep}`))
		throw new Error(
			"Scratch copy must be below the system temporary directory",
		);
	try {
		if (!options.scratch) {
			await cp(root, scratch, {
				recursive: true,
				filter: (file) => !excluded.has(path.basename(file)),
			});
		}
		const packageFile = path.join(scratch, "package.json");
		const pkg = JSON.parse(await readFile(packageFile, "utf8"));
		for (const name of [
			"@effect/platform",
			"@effect/rpc",
			"@effect/sql",
			"@effect/experimental",
		]) {
			delete pkg.dependencies?.[name];
			delete pkg.devDependencies?.[name];
		}
		for (const name of [
			"effect",
			"@effect/platform-node",
			"@effect/sql-sqlite-node",
			"@effect/opentelemetry",
			"@effect/vitest",
		]) {
			const section = pkg.devDependencies?.[name]
				? "devDependencies"
				: "dependencies";
			pkg[section] ??= {};
			pkg[section][name] = "4.0.5";
		}
		await writeFile(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
		if (!options.skipInstall) {
			console.log("Installing scratch Effect 4 dependencies...");
			const install = await run(
				"pnpm",
				["install", "--no-frozen-lockfile", "--ignore-scripts"],
				scratch,
				path.join(artifacts, "install.log"),
			);
			if (install.exitCode !== 0)
				throw new Error(`Scratch install failed; see ${commands.at(-1).log}`);
		}
		for (const name of [
			"effect",
			"@effect/platform-node",
			"@effect/sql-sqlite-node",
			"@effect/opentelemetry",
			"@effect/vitest",
		]) {
			const installed = JSON.parse(
				await readFile(
					path.join(scratch, "node_modules", name, "package.json"),
					"utf8",
				),
			);
			if (installed.version !== "4.0.5") {
				throw new Error(
					`Expected ${name}@4.0.5, installed ${installed.version}`,
				);
			}
		}
		console.log("Indexing v3 Effect API sites for diagnostic categories...");
		buildSemanticSites();
		console.log("Measuring the unmodified v3 sources against Effect 4...");
		const baseline = await compile("baseline");
		const before = await identities(baseline);
		const fingerprint = await sourceFingerprint();
		let previous;
		try {
			previous = JSON.parse(
				await readFile(path.join(output, "measurements.json"), "utf8"),
			);
		} catch {
			/* First measurement run. */
		}
		const result = {
			sourceFingerprint: fingerprint,
			typescript: ts.version,
			node: process.version,
			baseline: summary(baseline),
			transforms:
				previous?.sourceFingerprint === fingerprint &&
				JSON.stringify(previous.baseline) === JSON.stringify(summary(baseline))
					? previous.transforms
					: {},
		};
		const selected = options.transform.length
			? options.transform
			: [...transforms, "combined"];
		for (const name of selected) {
			for (let attempt = 0; attempt < 4; attempt++) {
				await restore();
				console.log(`Measuring ${name}...`);
				const report = path.join(artifacts, `${name}.md`);
				const argv = [
					path.join(root, "scripts/effect4-codemod/index.mjs"),
					"--report",
					report,
					"--patch",
					path.join(artifacts, `${name}.patch`),
				];
				if (name !== "combined") argv.push("--transform", name);
				const codemod = await run(
					process.execPath,
					argv,
					root,
					path.join(artifacts, `${name}-codemod.log`),
				);
				if (codemod.exitCode !== 0)
					throw new Error(`${name} codemod failed; see ${commands.at(-1).log}`);
				const document = JSON.parse(
					await readFile(report.replace(/\.md$/, ".json"), "utf8"),
				);
				const edits = await applyEdits(
					document.edits,
					path.join(artifacts, `${name}.patch`),
				);
				const after = document.edits.length
					? await compile(name, edits)
					: baseline;
				const newDiagnostics = introduced(
					before,
					await identities(after, edits),
				);
				result.transforms[name] = measurement(
					name,
					document.edits.length,
					baseline,
					after,
					newDiagnostics,
				);
				await writeFile(
					path.join(artifacts, `${name}-introduced.json`),
					`${JSON.stringify(newDiagnostics, null, 2)}\n`,
				);
				result.commands = commands;
				await saveResult(result);
				console.log(
					`${name}: ${baseline.length} -> ${after.length}; ${result.transforms[name].introducedOutsideCategory} new outside category; ${result.transforms[name].result}`,
				);
				if (
					!options.prune ||
					result.transforms[name].result !== "FAIL" ||
					attempt === 3
				)
					break;
				const manifest = path.join(
					root,
					"scripts/effect4-codemod/deferred.json",
				);
				const previous = await readFile(manifest, "utf8").catch(() => "{}");
				const pruneArgs = [
					path.join(root, "scripts/effect4-codemod/prune.mjs"),
				];
				if (name === "combined") pruneArgs.push("--combined");
				else pruneArgs.push("--transform", name);
				if (
					attempt > 0 ||
					(result.transforms[name].introducedOutsideCategory === 0 &&
						result.transforms[name].result === "FAIL")
				)
					pruneArgs.push("--all-new");
				const pruned = await run(
					process.execPath,
					pruneArgs,
					root,
					path.join(artifacts, `${name}-prune-${attempt}.log`),
				);
				if (pruned.exitCode !== 0)
					throw new Error(`Pruning failed for ${name}`);
				if ((await readFile(manifest, "utf8")) === previous) break;
			}
		}
		process.exitCode = Object.values(result.transforms).some(
			(item) => item.result === "FAIL",
		)
			? 1
			: 0;
	} finally {
		await restore();
		if (!options.keepScratch)
			await rm(scratch, { recursive: true, force: true });
		else console.log(`Scratch retained: ${scratch}`);
	}
}

await main();
