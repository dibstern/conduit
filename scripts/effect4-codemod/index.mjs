import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { importMoves, manual, manualImportMoves, renames } from "./rules.mjs";

const categoryFor = (module, name) => {
	if (
		module === "effect/Context" ||
		(module === "effect/Effect" && ["Tag", "Service"].includes(name))
	)
		return "services";
	if (module === "effect/Schema") return "schema";
	if (
		module === "effect/Either" ||
		(module === "effect/Effect" && name === "either")
	)
		return "either";
	if (name.startsWith("catch")) return "catch";
	if (module === "effect/Layer") return "layers";
	if (module === "effect/Option") return "option";
	if (module === "effect/Effect" && name.startsWith("fork")) return "fork";
	if (module === "effect/Effect" && name === "gen") return "generators";
	return "core";
};

// Parse reference metadata, never source code, to inventory unsupported API rows.
const changedApis = new Map();
const unmappedImports = new Map();
let referenceModule;
for (const [index, line] of fs
	.readFileSync(new URL("./reference/v3-to-v4.md", import.meta.url), "utf8")
	.split("\n")
	.entries()) {
	if (
		line.startsWith("- `") &&
		line.split("`")[1]?.includes("/") &&
		line.split("`")[2]?.startsWith(":")
	)
		unmappedImports.set(line.split("`")[1], {
			reason: line.split("`").slice(2).join("`").slice(2),
			reference: `reference/v3-to-v4.md:${index + 1}`,
		});
	if (line.startsWith("### `")) referenceModule = line.split("`")[1];
	if (!referenceModule || !line.startsWith("- `") || !line.includes("` -> `"))
		continue;
	const oldName = line.split("`")[1];
	const name = oldName.slice(oldName.indexOf(".") + 1);
	changedApis.set(`${referenceModule}:${name}`, {
		reason: `No implemented one-to-one rule. ${line.slice(2)}`,
		reference: `reference/v3-to-v4.md:${index + 1}`,
		rule: categoryFor(referenceModule, name),
	});
}

export const transforms = [
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

// All replacements are source ranges obtained from the v3 AST and checker.
// Keeping the original trivia also makes the generated patch reviewable.
export function run({
	root = process.cwd(),
	selected = transforms,
	projects,
	write = false,
} = {}) {
	root = path.resolve(root);
	const enabled = new Set(selected);
	const candidateNames = new Set(enabled.has("testing") ? ["scoped"] : []);
	for (const members of Object.values(renames))
		for (const [name, rule] of Object.entries(members))
			if (enabled.has(rule.rule)) candidateNames.add(name.split(".").at(-1));
	for (const [module, members] of Object.entries(manual))
		for (const [name, rule] of Object.entries(members))
			if (enabled.has(rule.rule ?? categoryFor(module, name)))
				candidateNames.add(name);
	for (const [key, rule] of changedApis)
		if (enabled.has(rule.rule))
			candidateNames.add(
				key
					.slice(key.lastIndexOf(":") + 1)
					.split(".")
					.at(-1),
			);
	const spelling = (node) =>
		ts.isIdentifier(node)
			? node.text
			: ts.isPropertyAccessExpression(node)
				? node.name.text
				: ts.isQualifiedName(node)
					? node.right.text
					: ts.isElementAccessExpression(node) &&
							ts.isStringLiteral(node.argumentExpression)
						? node.argumentExpression.text
						: undefined;
	for (const name of enabled) {
		if (!transforms.includes(name))
			throw new Error(`Unknown transform: ${name}`);
	}
	const entries = [];
	const edits = [];
	const deferredPath = new URL("./deferred.json", import.meta.url);
	const deferred = fs.existsSync(deferredPath)
		? JSON.parse(fs.readFileSync(deferredPath, "utf8"))
		: {};
	const sources = new Map();
	const visited = new Set();
	const configs = projects ?? [
		"tsconfig.json",
		"src/lib/frontend/tsconfig.json",
	];
	const addEntry = (sf, node, rule, reason, reference, status = "skipped") => {
		entries.push({
			file: path.relative(root, sf.fileName),
			line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
			rule,
			status,
			reason,
			reference,
		});
	};
	for (const config of configs) {
		if (process.env["EFFECT_CODEMOD_TRACE"]) console.error(`Reading ${config}`);
		const configPath = path.resolve(root, config);
		const parsed = ts.getParsedCommandLineOfConfigFile(
			configPath,
			{ noEmit: true },
			{
				...ts.sys,
				onUnRecoverableConfigFileDiagnostic: (d) => {
					throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
				},
			},
		);
		if (!parsed || parsed.errors.length)
			throw new Error(`Cannot parse ${configPath}`);
		const program = ts.createProgram(parsed.fileNames, parsed.options);
		if (process.env["EFFECT_CODEMOD_TRACE"])
			console.error(`Checking ${program.getSourceFiles().length} source files`);
		const checker = program.getTypeChecker();
		const alias = (symbol) => {
			const seen = new Set();
			while (
				symbol &&
				symbol.flags & ts.SymbolFlags.Alias &&
				!seen.has(symbol)
			) {
				seen.add(symbol);
				symbol = checker.getAliasedSymbol(symbol);
			}
			return symbol;
		};
		const modulePath = (file) => {
			const normalized = file.split(path.sep).join("/");
			const index = normalized.lastIndexOf("/node_modules/");
			if (index < 0) return undefined;
			const parts = normalized.slice(index + 14).split("/");
			const pkg = parts[0].startsWith("@")
				? parts.splice(0, 2).join("/")
				: parts.shift();
			if (pkg !== "effect" && !pkg.startsWith("@effect/")) return undefined;
			if (parts[0] === "dist" && parts[1] === "dts") parts.splice(0, 2);
			else if (parts[0] === "src") parts.shift();
			else return undefined;
			const tail = parts.join("/");
			return `${pkg}/${tail.endsWith(".d.ts") ? tail.slice(0, -5) : tail.endsWith(".ts") ? tail.slice(0, -3) : tail}`;
		};
		const origins = new Map();
		const exportedSymbols = new Map();
		const origin = (symbol) => {
			symbol = alias(symbol);
			if (!symbol) return undefined;
			if (origins.has(symbol)) return origins.get(symbol);
			let found;
			for (const decl of symbol.declarations ?? []) {
				const sf = decl.getSourceFile();
				const module = modulePath(sf.fileName);
				if (!module || module.includes("/internal/")) continue;
				if (ts.isSourceFile(decl)) {
					found = { module, name: "*" };
					break;
				}
				if (!exportedSymbols.has(sf)) {
					const owner = checker.getSymbolAtLocation(sf);
					exportedSymbols.set(
						sf,
						new Map(
							owner
								? checker
										.getExportsOfModule(owner)
										.map((s) => [alias(s), s.name])
								: [],
						),
					);
				}
				const name = exportedSymbols.get(sf).get(symbol);
				if (name) found = { module, name };
				if (found) break;
			}
			origins.set(symbol, found);
			return found;
		};
		const symbolAt = (node) =>
			ts.isElementAccessExpression(node) &&
			ts.isStringLiteral(node.argumentExpression)
				? checker.getPropertyOfType(
						checker.getTypeAtLocation(node.expression),
						node.argumentExpression.text,
					)
				: checker.getSymbolAtLocation(node);
		const at = (node) => origin(symbolAt(node));
		const stableLocalExport = (symbol) =>
			symbol?.declarations?.some(
				(d) =>
					!modulePath(d.getSourceFile().fileName) &&
					(ts.isExportSpecifier(d) || ts.isImportEqualsDeclaration(d)),
			);
		const is = (node, module, name) => {
			const o = at(node);
			return o?.module === module && o.name === name;
		};
		for (const sf of program.getSourceFiles()) {
			const relative = path.relative(root, sf.fileName);
			if (
				sf.isDeclarationFile ||
				relative.startsWith("..") ||
				relative.includes("node_modules/") ||
				visited.has(sf.fileName)
			)
				continue;
			visited.add(sf.fileName);
			if (fs.readFileSync(sf.fileName, "utf8") !== sf.text) {
				addEntry(
					sf,
					sf,
					"input",
					"Compiler text differs from disk; no source ranges applied.",
					"README.md#safety",
				);
				continue;
			}
			const enabled = new Set(
				selected.filter((name) => !deferred[name]?.[relative]),
			);
			for (const name of selected) {
				const block = deferred[name]?.[relative];
				if (block)
					for (const site of block.sites)
						entries.push({
							file: relative,
							line: site.line,
							rule: name,
							status: "skipped",
							reason: block.reason,
							reference: site.reference,
						});
			}
			if (process.env["EFFECT_CODEMOD_TRACE"]) console.error(relative);
			sources.set(relative, sf.text);
			const localEdits = [];
			const namespaces = new Map();
			const requestedImports = new Map();
			const importedSpellings = new Map();
			const edit = (start, end, after, rule, reference) => {
				if (sf.text.slice(start, end) === after) return;
				localEdits.push({
					file: relative,
					start,
					end,
					before: sf.text.slice(start, end),
					after,
					rule,
					reference,
				});
			};
			const replace = (node, after, rule, reference) =>
				edit(node.getStart(sf), node.end, after, rule, reference);
			const note = (node, rule, reason, reference) =>
				addEntry(sf, node, rule, reason, reference);
			const nameFor = (module, site) => {
				const binding = namespaces.get(module);
				if (
					binding &&
					checker.resolveName(
						binding.name,
						site,
						ts.SymbolFlags.Value,
						false,
					) === binding.symbol
				)
					return binding.name;
				if (requestedImports.has(module)) return requestedImports.get(module);
				const base = `Effect4${module.slice(module.lastIndexOf("/") + 1)}`;
				let name = base;
				let n = 2;
				const names = new Set();
				const collect = (node) => {
					if (ts.isIdentifier(node)) names.add(node.text);
					ts.forEachChild(node, collect);
				};
				collect(sf);
				while (names.has(name) || [...requestedImports.values()].includes(name))
					name = `${base}${n++}`;
				requestedImports.set(module, name);
				return name;
			};
			for (const statement of sf.statements) {
				if (
					!ts.isImportDeclaration(statement) ||
					!statement.importClause ||
					statement.importClause.isTypeOnly
				)
					continue;
				const binding = statement.importClause.namedBindings;
				if (binding && ts.isNamespaceImport(binding)) {
					const o = at(binding.name);
					if (o?.name === "*")
						namespaces.set(o.module, {
							name: binding.name.text,
							symbol: checker.getSymbolAtLocation(binding.name),
						});
				} else if (binding) {
					for (const item of binding.elements) {
						const o = at(item.name);
						if (o) importedSpellings.set(item.name.text, o.name);
						if (o?.name === "*" && !item.isTypeOnly)
							namespaces.set(o.module, {
								name: item.name.text,
								symbol: checker.getSymbolAtLocation(item.name),
							});
					}
				}
			}
			const callSpelling = (node) =>
				ts.isIdentifier(node)
					? (importedSpellings.get(node.text) ?? node.text)
					: spelling(node);
			const transformImport = (node) => {
				const literal = node.moduleSpecifier;
				if (!ts.isStringLiteral(literal)) return;
				const oldPath = literal.text;
				if (
					oldPath !== "effect" &&
					!oldPath.startsWith("effect/") &&
					!oldPath.startsWith("@effect/")
				) {
					const bindings =
						node.importClause?.namedBindings ?? node.exportClause;
					if (
						bindings &&
						(ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
					)
						for (const item of bindings.elements) {
							const o = ts.isExportSpecifier(item)
								? origin(checker.getExportSpecifierLocalTargetSymbol(item))
								: at(item.name);
							if (o) {
								const rule = categoryFor(o.module, o.name);
								if (enabled.has(rule))
									note(
										item,
										rule,
										"Local import/re-export route requires coordinated migration; local names are preserved.",
										"reference/v3-to-v4.md",
									);
							}
						}
					return;
				}
				const symbol = alias(checker.getSymbolAtLocation(literal));
				if (
					!symbol?.declarations?.some((d) =>
						modulePath(d.getSourceFile().fileName),
					)
				) {
					note(
						node,
						"imports",
						"Module does not resolve to an Effect package; unchanged.",
						"reference/MIGRATION.md",
					);
					return;
				}
				if (node.importClause?.name || node.attributes) {
					note(
						node,
						"imports",
						"Default import or import attributes require review; unchanged.",
						"reference/MIGRATION.md",
					);
					return;
				}
				const move = importMoves[oldPath];
				if (unmappedImports.has(oldPath) && enabled.has("imports")) {
					const m = unmappedImports.get(oldPath);
					note(node, "imports", m.reason, m.reference);
				}
				const category =
					oldPath === "effect/Either"
						? "either"
						: oldPath === "effect/TestClock"
							? "testing"
							: "imports";
				if (move && enabled.has(category))
					replace(literal, JSON.stringify(move.path), category, move.reference);
				if (manualImportMoves[oldPath])
					note(
						node,
						"imports",
						manualImportMoves[oldPath].reason,
						manualImportMoves[oldPath].reference,
					);
				const bindings = node.importClause?.namedBindings ?? node.exportClause;
				if (
					!move &&
					[
						"@effect/platform",
						"@effect/rpc",
						"@effect/sql",
						"@effect/experimental",
					].includes(oldPath) &&
					(!bindings || ts.isNamespaceImport(bindings))
				)
					note(
						node,
						"imports",
						"Consolidated package namespace or side-effect import needs manual migration.",
						"reference/MIGRATION.md:25",
					);
				if (
					!bindings ||
					(!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings))
				)
					return;
				const groups = new Map();
				const contributingRules = new Set();
				let rebuild = false;
				for (const item of bindings.elements) {
					const exported = item.propertyName ?? item.name;
					const o = ts.isExportSpecifier(item)
						? origin(checker.getExportSpecifierLocalTargetSymbol(item))
						: at(item.name);
					let dest = move && enabled.has(category) ? move.path : oldPath;
					let name = exported.text;
					let rule;
					let reference;
					if (o?.name === "*" && importMoves[o.module]) {
						const mapped = importMoves[o.module];
						const r =
							o.module === "effect/Either"
								? "either"
								: o.module === "effect/TestClock"
									? "testing"
									: "imports";
						if (enabled.has(r)) {
							dest = mapped.barrel;
							name = mapped.path.slice(mapped.path.lastIndexOf("/") + 1);
							rule = r;
							reference = mapped.reference;
						}
					} else if (o) {
						const r = renames[o.module]?.[o.name];
						if (r && enabled.has(r.rule) && !r.name.includes(".")) {
							name = r.name;
							rule = r.rule;
							reference = r.reference;
						}
					}
					if (
						o?.name === "*" &&
						manualImportMoves[o.module] &&
						enabled.has("imports")
					)
						note(
							item,
							"imports",
							manualImportMoves[o.module].reason,
							manualImportMoves[o.module].reference,
						);
					if (
						o?.name === "*" &&
						unmappedImports.has(o.module) &&
						enabled.has("imports")
					) {
						const m = unmappedImports.get(o.module);
						note(item, "imports", m.reason, m.reference);
					}
					const spec = `${item.isTypeOnly ? "type " : ""}${name}${name !== item.name.text ? ` as ${item.name.text}` : ""}`;
					if (!groups.has(dest)) groups.set(dest, []);
					groups.get(dest).push(spec);
					if (name !== exported.text || dest !== oldPath) {
						rebuild = true;
						contributingRules.add(rule ?? category);
						addEntry(
							sf,
							item,
							rule ?? category,
							`${oldPath}:${exported.text} -> ${dest}:${name}`,
							reference ?? move?.reference,
							"changed",
						);
					}
				}
				if (rebuild) {
					// The statement edit supersedes the earlier module-literal edit.
					const prior = localEdits.findIndex(
						(e) => e.start === literal.getStart(sf),
					);
					if (prior >= 0) localEdits.splice(prior, 1);
					const keyword = ts.isExportDeclaration(node) ? "export" : "import";
					const typeOnly = node.importClause?.isTypeOnly ?? node.isTypeOnly;
					if (node.importClause?.name || node.attributes) {
						note(
							node,
							"imports",
							"Default import or import attributes require review.",
							"reference/MIGRATION.md",
						);
						return;
					}
					replace(
						node,
						[...groups]
							.map(
								([dest, specs]) =>
									`${keyword}${typeOnly ? " type" : ""} { ${specs.join(", ")} } from ${JSON.stringify(dest)};`,
							)
							.join("\n"),
						contributingRules.size === 1 ? [...contributingRules][0] : category,
						move?.reference ?? "reference/v3-to-v4.md",
					);
				}
			};
			const eitherReceiver = (node, property = "_tag") => {
				const type = checker.getTypeAtLocation(node);
				const members = type.isUnion() ? type.types : [type];
				return (
					members.length > 0 &&
					members.every((t) => {
						const tag = checker.getPropertyOfType(t, property);
						const discriminant = checker.getPropertyOfType(t, "_tag");
						// Effect and STM augment v3 Either's yieldable discriminator.
						// All declarations must still be upstream, including augmentations.
						const upstreamTag = (symbol) =>
							symbol?.declarations?.some(
								(d) =>
									modulePath(d.getSourceFile().fileName) === "effect/Either",
							) &&
							symbol.declarations.every((d) =>
								["effect/Either", "effect/Effect", "effect/STM"].includes(
									modulePath(d.getSourceFile().fileName),
								),
							);
						return (
							upstreamTag(discriminant) &&
							tag?.declarations?.length &&
							(property === "_tag"
								? upstreamTag(tag)
								: tag.declarations.every(
										(d) =>
											modulePath(d.getSourceFile().fileName) ===
											"effect/Either",
									))
						);
					})
				);
			};
			const member = (node) =>
				ts.isPropertyAccessExpression(node)
					? node.name
					: ts.isElementAccessExpression(node) &&
							ts.isStringLiteral(node.argumentExpression)
						? node.argumentExpression
						: undefined;
			const renameMember = (node, value, rule, reference) => {
				const token = member(node);
				if (token)
					replace(
						token,
						ts.isStringLiteral(token) ? JSON.stringify(value) : value,
						rule,
						reference,
					);
			};
			const localClassWithoutAccessors = (expression) => {
				const cls = ts.isExpressionWithTypeArguments(expression.parent)
					? expression.parent.parent.parent
					: undefined;
				if (
					!cls ||
					!ts.isClassDeclaration(cls) ||
					!cls.name ||
					cls.members.length ||
					cls.modifiers?.some((m) =>
						[
							ts.SyntaxKind.ExportKeyword,
							ts.SyntaxKind.DefaultKeyword,
						].includes(m.kind),
					)
				)
					return false;
				const symbol = checker.getSymbolAtLocation(cls.name);
				const owner = checker.getSymbolAtLocation(sf);
				if (
					owner &&
					checker.getExportsOfModule(owner).some((s) => alias(s) === symbol)
				)
					return false;
				let safe = true;
				const inspect = (n) => {
					if (
						ts.isIdentifier(n) &&
						n !== cls.name &&
						checker.getSymbolAtLocation(n) === symbol
					) {
						const p = n.parent;
						const typeUse = ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p);
						const yielded = ts.isYieldExpression(p) && p.expression === n;
						const property =
							ts.isPropertyAccessExpression(p) &&
							p.expression === n &&
							["key", "of"].includes(p.name.text);
						const provided =
							ts.isCallExpression(p) &&
							((is(p.expression, "effect/Layer", "succeed") &&
								p.arguments[0] === n) ||
								(is(p.expression, "effect/Effect", "provideService") &&
									p.arguments[p.arguments.length === 3 ? 1 : 0] === n));
						if (!typeUse && !yielded && !property && !provided) safe = false;
					}
					ts.forEachChild(n, inspect);
				};
				inspect(sf);
				return safe;
			};
			const visit = (node) => {
				if (ts.isIdentifier(node) && importedSpellings.has(node.text)) {
					const o = at(node);
					const r = o && renames[o.module]?.[o.name];
					const m =
						o &&
						(manual[o.module]?.[o.name] ??
							changedApis.get(`${o.module}:${o.name}`));
					const rule = o && categoryFor(o.module, o.name);
					if (
						!r &&
						m &&
						enabled.has(rule) &&
						![
							"Union",
							"Tuple",
							"Literal",
							"Record",
							"filter",
							"gen",
							"Tag",
							"Service",
						].includes(o.name)
					)
						note(node, rule, m.reason, m.reference);
				}
				if (enabled.has("either") && ts.isTypeReferenceNode(node)) {
					const o = at(
						ts.isQualifiedName(node.typeName)
							? node.typeName.right
							: node.typeName,
					);
					if (
						o?.module === "effect/Either" &&
						["Left", "Right"].includes(o.name)
					) {
						if (node.typeArguments?.length === 2) {
							// The v3 variants use <E, A>; v4 uses <A, E>.
							const [error, success] = node.typeArguments;
							// Nested type arguments may themselves contain renames. Compose their
							// edits before moving them, instead of overlapping source ranges.
							const render = (type) => {
								const first = localEdits.length;
								visit(type);
								const nested = localEdits.splice(first);
								let text = type.getText(sf);
								for (const e of nested.sort((a, b) => b.start - a.start))
									text =
										text.slice(0, e.start - type.getStart(sf)) +
										e.after +
										text.slice(e.end - type.getStart(sf));
								return text;
							};
							const errorText = render(error);
							const successText = render(success);
							replace(
								error,
								successText,
								"either",
								"reference/v3-to-v4.md:10283",
							);
							replace(
								success,
								errorText,
								"either",
								"reference/v3-to-v4.md:10285",
							);
							visit(node.typeName);
							return;
						}
					}
				}
				const importLiteral =
					ts.isImportTypeNode(node) &&
					ts.isLiteralTypeNode(node.argument) &&
					ts.isStringLiteral(node.argument.literal)
						? node.argument.literal
						: ts.isCallExpression(node) &&
								node.expression.kind === ts.SyntaxKind.ImportKeyword &&
								node.arguments.length === 1 &&
								ts.isStringLiteral(node.arguments[0])
							? node.arguments[0]
							: undefined;
				if (importLiteral && importMoves[importLiteral.text]) {
					const rule =
						importLiteral.text === "effect/Either"
							? "either"
							: importLiteral.text === "effect/TestClock"
								? "testing"
								: "imports";
					if (enabled.has(rule)) {
						if (importLiteral.text === "effect/Either") {
							note(
								node,
								rule,
								"Either import expressions need qualifier, variant generic order and namespace-consumer migration; unchanged.",
								"reference/v3-to-v4.md:10271",
							);
							return;
						}
						const symbol = alias(checker.getSymbolAtLocation(importLiteral));
						if (
							symbol?.declarations?.some((d) =>
								modulePath(d.getSourceFile().fileName),
							)
						)
							replace(
								importLiteral,
								JSON.stringify(importMoves[importLiteral.text].path),
								rule,
								importMoves[importLiteral.text].reference,
							);
						else
							note(
								node,
								rule,
								"Import expression does not resolve to an Effect module.",
								importMoves[importLiteral.text].reference,
							);
					}
				}
				if (
					ts.isImportDeclaration(node) ||
					(ts.isExportDeclaration(node) && node.moduleSpecifier)
				) {
					transformImport(node);
					return;
				}
				if (ts.isCallExpression(node)) {
					const fn = node.expression;
					const o =
						enabled.has("schema") &&
						["Union", "Tuple", "Literal", "Record", "filter"].includes(
							callSpelling(fn),
						)
							? at(fn)
							: undefined;
					const ref = "reference/schema.md";
					if (
						enabled.has("generators") &&
						callSpelling(fn) === "gen" &&
						node.arguments.length === 2 &&
						is(fn, "effect/Effect", "gen")
					) {
						const self = node.arguments[0];
						if (self.kind === ts.SyntaxKind.ThisKeyword)
							replace(
								self,
								"{ self: this }",
								"generators",
								"reference/generators.md:3",
							);
						else if (
							!ts.isObjectLiteralExpression(self) ||
							!self.properties.some((p) => p.name?.getText(sf) === "self")
						) {
							// Arbitrary object expressions might already be v4 options. Only `this` is unambiguous on reruns.
							note(
								node,
								"generators",
								"Non-this binding is ambiguous with v4 options; review manually.",
								"reference/generators.md:3",
							);
						}
					}
					if (
						enabled.has("services") &&
						ts.isCallExpression(fn) &&
						callSpelling(fn.expression) === "Tag" &&
						(is(fn.expression, "effect/Context", "Tag") ||
							is(fn.expression, "effect/Effect", "Tag"))
					) {
						const decl = node.parent;
						if (
							node.typeArguments?.length === 2 &&
							node.arguments.length === 0 &&
							fn.arguments.length === 1 &&
							ts.isExpressionWithTypeArguments(decl)
						) {
							if (stableLocalExport(symbolAt(fn.expression))) {
								note(
									node,
									"services",
									"Local Tag re-export requires coordinated constructor migration; unchanged.",
									"reference/services.md:34",
								);
							} else if (
								is(fn.expression, "effect/Effect", "Tag") &&
								!localClassWithoutAccessors(node)
							) {
								note(
									node,
									"services",
									"Effect.Tag accessor proxy removal requires consumer review.",
									"reference/services.md:61",
								);
							} else {
								if (
									is(fn.expression, "effect/Effect", "Tag") ||
									ts.isIdentifier(fn.expression)
								)
									replace(
										fn.expression,
										`${nameFor("effect/Context", node)}.Service`,
										"services",
										"reference/services.md:34",
									);
								else
									renameMember(
										fn.expression,
										"Service",
										"services",
										"reference/services.md:34",
									);
								edit(
									fn.expression.end,
									fn.end,
									"",
									"services",
									"reference/services.md:34",
								);
								edit(
									node.end,
									node.end,
									`(${fn.arguments[0].getText(sf)})`,
									"services",
									"reference/services.md:34",
								);
							}
						} else
							note(
								node,
								"services",
								"Tag is not the documented two-type-argument class form.",
								"reference/services.md:34",
							);
					}
					if (
						enabled.has("services") &&
						ts.isCallExpression(fn) &&
						callSpelling(fn.expression) === "Service" &&
						is(fn.expression, "effect/Effect", "Service")
					)
						note(
							node,
							"services",
							"Effect.Service generates layers/accessors; constructor and consumers need manual migration.",
							"reference/services.md:133",
						);
					if (enabled.has("schema") && o?.module === "effect/Schema") {
						if (["Union", "Tuple"].includes(o.name)) {
							if (
								node.arguments.some(ts.isSpreadElement) ||
								node.typeArguments?.length ||
								(o.name === "Tuple" &&
									node.arguments.length > 1 &&
									ts.isArrayLiteralExpression(node.arguments[0]))
							)
								note(
									node,
									"schema",
									"Spread, tuple rest overload or explicit generics require review.",
									ref,
								);
							else if (
								!(
									node.arguments.length === 1 &&
									ts.isArrayLiteralExpression(node.arguments[0])
								)
							) {
								edit(
									node.arguments.pos,
									node.arguments.pos,
									"[",
									"schema",
									ref,
								);
								edit(
									node.arguments.end,
									node.arguments.end,
									"]",
									"schema",
									ref,
								);
							}
						} else if (o.name === "Literal") {
							if (
								node.arguments.length === 1 &&
								node.arguments[0].kind === ts.SyntaxKind.NullKeyword
							)
								replace(
									node,
									`${nameFor("effect/Schema", node)}.Null`,
									"schema",
									ref,
								);
							else if (
								node.arguments.length > 1 &&
								!node.arguments.some(
									(a) =>
										ts.isSpreadElement(a) ||
										a.kind === ts.SyntaxKind.NullKeyword,
								) &&
								!node.typeArguments?.length
							) {
								if (ts.isIdentifier(fn))
									replace(
										fn,
										`${nameFor("effect/Schema", node)}.Literals`,
										"schema",
										ref,
									);
								else renameMember(fn, "Literals", "schema", ref);
								edit(
									node.arguments.pos,
									node.arguments.pos,
									"[",
									"schema",
									ref,
								);
								edit(
									node.arguments.end,
									node.arguments.end,
									"]",
									"schema",
									ref,
								);
							} else if (
								node.arguments.some(
									(a) =>
										ts.isSpreadElement(a) ||
										a.kind === ts.SyntaxKind.NullKeyword,
								)
							)
								note(
									node,
									"schema",
									"Mixed null literals or spread values need manual restructuring.",
									ref,
								);
						} else if (o.name === "Record" && node.arguments.length === 1) {
							const arg = node.arguments[0];
							if (
								ts.isObjectLiteralExpression(arg) &&
								arg.properties.length === 2 &&
								arg.properties.every(ts.isPropertyAssignment) &&
								arg.properties[0].name.getText(sf) === "key" &&
								arg.properties[1].name.getText(sf) === "value"
							) {
								const [key, value] = arg.properties;
								edit(
									arg.getStart(sf),
									key.initializer.getStart(sf),
									"",
									"schema",
									ref,
								);
								edit(
									key.initializer.end,
									value.initializer.getStart(sf),
									", ",
									"schema",
									ref,
								);
								edit(value.initializer.end, arg.end, "", "schema", ref);
							} else
								note(
									node,
									"schema",
									"Record requires an explicit key/value object in evaluation order.",
									ref,
								);
						} else if (o.name === "filter") {
							const predicate = node.arguments[0];
							const signatures = predicate
								? checker.getSignaturesOfType(
										checker.getTypeAtLocation(predicate),
										ts.SignatureKind.Call,
									)
								: [];
							const refinement =
								signatures.length === 1 &&
								checker.getTypePredicateOfSignature(signatures[0]);
							const boolean =
								signatures.length === 1 &&
								checker.getReturnTypeOfSignature(signatures[0]).flags &
									(ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral);
							if (
								node.arguments.length === 1 &&
								signatures[0]?.parameters.length <= 1 &&
								refinement
							) {
								if (ts.isIdentifier(fn))
									replace(
										fn,
										`${nameFor("effect/Schema", node)}.refine`,
										"schema",
										ref,
									);
								else renameMember(fn, "refine", "schema", ref);
							} else if (
								node.arguments.length === 1 &&
								signatures[0]?.parameters.length <= 1 &&
								boolean
							) {
								const ns = nameFor("effect/Schema", node);
								if (ts.isIdentifier(fn))
									replace(fn, `${ns}.check`, "schema", ref);
								else renameMember(fn, "check", "schema", ref);
								edit(
									node.arguments.pos,
									node.arguments.pos,
									`${ns}.makeFilter(`,
									"schema",
									ref,
								);
								edit(
									node.arguments.end,
									node.arguments.end,
									")",
									"schema",
									ref,
								);
							} else
								note(
									node,
									"schema",
									"Filter options, issue outputs or overloaded predicates need manual migration.",
									ref,
								);
						}
					}
				}
				if (
					(ts.isPropertyAccessExpression(node) ||
						ts.isElementAccessExpression(node)) &&
					member(node) &&
					candidateNames.has(member(node).text)
				) {
					const token = member(node);
					const text = token.text;
					if (
						enabled.has("either") &&
						["left", "right"].includes(text) &&
						eitherReceiver(node.expression, text)
					)
						renameMember(
							node,
							text === "left" ? "failure" : "success",
							"either",
							"reference/v3-to-v4.md",
						);
					// Export renames apply to namespace members. Resolving arbitrary
					// instance methods can force unrelated generic call inference.
					const receiver =
						ts.isIdentifier(node.expression) ||
						ts.isPropertyAccessExpression(node.expression)
							? alias(symbolAt(node.expression))
							: undefined;
					const raw = receiver?.declarations?.some(
						(d) => ts.isSourceFile(d) || ts.isModuleDeclaration(d),
					)
						? symbolAt(node)
						: undefined;
					const o = raw && !stableLocalExport(raw) ? origin(raw) : undefined;
					const r = o && renames[o.module]?.[o.name];
					if (r && enabled.has(r.rule))
						renameMember(node, r.name, r.rule, r.reference);
					if (o && manual[o.module]?.[o.name]) {
						const m = manual[o.module][o.name];
						const rule = m.rule ?? categoryFor(o.module, o.name);
						if (enabled.has(rule)) note(node, rule, m.reason, m.reference);
					}
					const unsupported = o && changedApis.get(`${o.module}:${o.name}`);
					if (
						unsupported &&
						enabled.has(unsupported.rule) &&
						!r &&
						!manual[o.module]?.[o.name] &&
						![
							"Tag",
							"Service",
							"Union",
							"Tuple",
							"Record",
							"Literal",
							"filter",
							"gen",
						].includes(o.name)
					)
						note(
							node,
							unsupported.rule,
							unsupported.reason,
							unsupported.reference,
						);
					if (
						enabled.has("testing") &&
						["scoped", "scopedLive"].includes(text) &&
						at(node.expression)?.module === "@effect/vitest/index" &&
						at(node.expression)?.name === "it" &&
						checker
							.getSymbolAtLocation(token)
							?.declarations?.some(
								(d) =>
									modulePath(d.getSourceFile().fileName) ===
									"@effect/vitest/index",
							)
					)
						renameMember(
							node,
							text === "scoped" ? "effect" : "live",
							"testing",
							text === "scoped"
								? "reference/v3-to-v4.md:8685"
								: "reference/v3-to-v4.md:8687",
						);
				}
				if (ts.isQualifiedName(node) && candidateNames.has(node.right.text)) {
					const o = at(node.right);
					const r = o && renames[o.module]?.[o.name];
					if (
						r &&
						enabled.has(r.rule) &&
						!stableLocalExport(checker.getSymbolAtLocation(node.right))
					)
						replace(node.right, r.name, r.rule, r.reference);
					if (
						node.right.text === "Service" &&
						ts.isQualifiedName(node.left) &&
						node.left.right.text === "Tag" &&
						is(node.left.right, "effect/Context", "Tag") &&
						enabled.has("services") &&
						!stableLocalExport(checker.getSymbolAtLocation(node.left.right))
					)
						replace(
							node,
							`${node.left.left.getText(sf)}.Service.Shape`,
							"services",
							"reference/v3-to-v4.md:9549",
						);
					else if (
						ts.isQualifiedName(node.left) &&
						node.left.right.text === "Tag" &&
						is(node.left.right, "effect/Context", "Tag") &&
						enabled.has("services")
					)
						note(
							node,
							"services",
							"Nested Tag utility has no proven mechanical mapping.",
							"reference/services.md",
						);
				}
				if (
					enabled.has("either") &&
					ts.isBinaryExpression(node) &&
					[
						ts.SyntaxKind.EqualsEqualsEqualsToken,
						ts.SyntaxKind.ExclamationEqualsEqualsToken,
						ts.SyntaxKind.EqualsEqualsToken,
						ts.SyntaxKind.ExclamationEqualsToken,
					].includes(node.operatorToken.kind)
				) {
					for (const [access, literal] of [
						[node.left, node.right],
						[node.right, node.left],
					]) {
						if (
							(ts.isPropertyAccessExpression(access) ||
								ts.isElementAccessExpression(access)) &&
							member(access)?.text === "_tag" &&
							eitherReceiver(access.expression) &&
							ts.isStringLiteral(literal) &&
							["Left", "Right"].includes(literal.text)
						)
							replace(
								literal,
								JSON.stringify(literal.text === "Left" ? "Failure" : "Success"),
								"either",
								"reference/v3-to-v4.md",
							);
					}
				}
				if (enabled.has("either") && ts.isSwitchStatement(node)) {
					const access = node.expression;
					if (
						(ts.isPropertyAccessExpression(access) ||
							ts.isElementAccessExpression(access)) &&
						member(access)?.text === "_tag" &&
						eitherReceiver(access.expression)
					) {
						for (const clause of node.caseBlock.clauses)
							if (
								ts.isCaseClause(clause) &&
								ts.isStringLiteral(clause.expression) &&
								["Left", "Right"].includes(clause.expression.text)
							)
								replace(
									clause.expression,
									JSON.stringify(
										clause.expression.text === "Left" ? "Failure" : "Success",
									),
									"either",
									"reference/v3-to-v4.md",
								);
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(sf);
			if (requestedImports.size) {
				const pos = sf.statements[0]?.getStart(sf) ?? sf.end;
				edit(
					pos,
					pos,
					[...requestedImports]
						.map(
							([module, name]) =>
								`import * as ${name} from ${JSON.stringify(module)};\n`,
						)
						.join(""),
					"schema",
					"reference/MIGRATION.md",
				);
			}
			// Abort rather than emitting a partially overlapping, potentially corrupt patch.
			localEdits.sort(
				(a, b) =>
					a.start - b.start || a.end - b.end || a.after.localeCompare(b.after),
			);
			for (let i = 1; i < localEdits.length; i++)
				if (localEdits[i].start < localEdits[i - 1].end)
					throw new Error(
						`Overlapping edits in ${relative}:${localEdits[i].start}`,
					);
			for (const e of localEdits) {
				if (
					!entries.some(
						(item) =>
							item.file === relative &&
							item.line ===
								sf.getLineAndCharacterOfPosition(e.start).line + 1 &&
							item.rule === e.rule &&
							item.status === "changed",
					)
				)
					entries.push({
						file: relative,
						line: sf.getLineAndCharacterOfPosition(e.start).line + 1,
						rule: e.rule,
						status: "changed",
						reason: `${e.before || "(insert)"} -> ${e.after || "(remove)"}`,
						reference: e.reference,
					});
			}
			edits.push(...localEdits);
		}
	}
	// Svelte scripts have no checker-backed program here. Parse script ASTs only to inventory sites.
	const svelteFiles = ts.sys
		.readDirectory(
			root,
			[".svelte"],
			["**/node_modules/**", "**/.git/**", "**/dist/**"],
			["src/**/*.svelte", "test/**/*.svelte"],
		)
		.sort();
	for (const file of svelteFiles) {
		const text = fs.readFileSync(file, "utf8");
		// Svelte's existing parser owns script boundaries; no text matching or rewriting.
		const ast = svelteParser.parse(text, { filename: file, modern: true });
		for (const script of [ast.instance, ast.module]) {
			if (!script) continue;
			const start = script.content.start;
			const sf = ts.createSourceFile(
				file,
				text.slice(start, script.content.end),
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS,
			);
			const names = new Set();
			for (const statement of sf.statements)
				if (
					ts.isImportDeclaration(statement) &&
					ts.isStringLiteral(statement.moduleSpecifier) &&
					(statement.moduleSpecifier.text === "effect" ||
						statement.moduleSpecifier.text.startsWith("effect/") ||
						statement.moduleSpecifier.text.startsWith("@effect/"))
				) {
					const collect = (node) => {
						if (ts.isIdentifier(node)) names.add(node.text);
						ts.forEachChild(node, collect);
					};
					collect(statement);
				}
			const visit = (node) => {
				if (ts.isIdentifier(node) && names.has(node.text))
					entries.push({
						file: path.relative(root, file),
						line: text.slice(0, start + node.getStart(sf)).split("\n").length,
						rule: "svelte",
						status: "skipped",
						reason:
							"Svelte script has no TypeScript checker context; unchanged.",
						reference: "README.md#safety",
					});
				ts.forEachChild(node, visit);
			};
			visit(sf);
		}
	}
	const outputs = new Map();
	for (const [file, before] of sources) {
		let after = before;
		for (const e of edits
			.filter((e) => e.file === file)
			.sort((a, b) => b.start - a.start || b.end - a.end))
			after = after.slice(0, e.start) + e.after + after.slice(e.end);
		if (before !== after) {
			outputs.set(file, after);
			if (write) fs.writeFileSync(path.join(root, file), after);
		}
	}
	entries.sort(
		(a, b) =>
			a.file.localeCompare(b.file) ||
			a.line - b.line ||
			a.rule.localeCompare(b.rule) ||
			a.reason.localeCompare(b.reason),
	);
	return {
		transforms: [...enabled].sort(),
		projects: configs,
		files: outputs.size,
		edits,
		entries,
		outputs,
		sources,
	};
}

// Imported once from the repository's existing Svelte dependency.
import * as svelteParser from "svelte/compiler";

function patchFor(result) {
	// Whole-file hunks keep patch generation dependency-free and deterministic.
	return [...result.outputs]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([file, after]) => {
			const before = result.sources.get(file);
			const lines = (text) =>
				text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
			return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,${lines(before).length} +1,${lines(after).length} @@\n${lines(
				before,
			)
				.map((line) => `-${line}`)
				.join(
					"\n",
				)}\n${before.endsWith("\n") ? "" : "\\ No newline at end of file\n"}${lines(
				after,
			)
				.map((line) => `+${line}`)
				.join(
					"\n",
				)}\n${after.endsWith("\n") ? "" : "\\ No newline at end of file\n"}`;
		})
		.join("");
}

function main() {
	const args = process.argv.slice(2);
	const options = { selected: [], projects: [] };
	let report = "test-results/effect4-codemod-report.md";
	let patch;
	while (args.length) {
		const arg = args.shift();
		if (arg === "--help") {
			console.log(
				"pnpm codemod:effect4 [--transform name[,name]] [--report path.md] [--patch path] [--write] [--root path] [--project tsconfig.json]\nTransforms: " +
					transforms.join(", "),
			);
			return;
		}
		if (arg === "--write") {
			options.write = true;
			continue;
		}
		const value = args.shift();
		if (!value || value.startsWith("--"))
			throw new Error(`Missing value for ${arg}`);
		if (arg === "--transform") options.selected.push(...value.split(","));
		else if (arg === "--project") options.projects.push(value);
		else if (arg === "--root") options.root = value;
		else if (arg === "--report") report = value;
		else if (arg === "--patch") patch = value;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!options.selected.length) options.selected = transforms;
	if (!options.projects.length) delete options.projects;
	const result = run(options);
	const { outputs, sources, ...json } = result;
	const jsonPath = report.endsWith(".md")
		? `${report.slice(0, -3)}.json`
		: `${report}.json`;
	fs.mkdirSync(path.dirname(report), { recursive: true });
	fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`);
	fs.writeFileSync(
		report,
		`# Effect 4 codemod report\n\n${result.files} files, ${result.edits.length} edits. Mode: ${options.write ? "write" : "dry run"}.\n\nTransforms: ${result.transforms.join(", ")}.\n\n| File:line | Rule | Status | Reason | Reference |\n| --- | --- | --- | --- | --- |\n${result.entries.map((e) => `| ${e.file}:${e.line} | ${e.rule} | ${e.status} | ${e.reason.split("\n").join(" ").split("|").join("\\|")} | ${e.reference ?? ""} |`).join("\n")}\n`,
	);
	if (patch) {
		fs.mkdirSync(path.dirname(patch), { recursive: true });
		fs.writeFileSync(patch, patchFor(result));
	}
	console.log(
		`${result.files} files, ${result.edits.length} edits; ${result.entries.filter((e) => e.status === "skipped").length} skipped sites. Report: ${report}`,
	);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main();
