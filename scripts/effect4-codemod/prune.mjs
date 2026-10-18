#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const names = [
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
	transforms: [],
	reports: path.join(root, "test-results/effect4-codemod-measurements"),
	output: path.join(root, "scripts/effect4-codemod/deferred.json"),
	dryRun: false,
	allNew: false,
	combined: false,
};
for (let index = 0; index < args.length; index++) {
	const argument = args[index];
	if (argument === "--dry-run") options.dryRun = true;
	else if (argument === "--all-new") options.allNew = true;
	else if (argument === "--combined") options.combined = true;
	else if (["--transform", "--reports", "--output"].includes(argument)) {
		const value = args[++index];
		if (!value || value.startsWith("--"))
			throw new Error(`${argument} needs a value`);
		if (argument === "--transform") {
			if (!names.includes(value))
				throw new Error(`Unknown transform: ${value}`);
			options.transforms.push(value);
		} else options[argument.slice(2)] = path.resolve(value);
	} else if (argument === "--help") {
		console.log(
			"node scripts/effect4-codemod/prune.mjs [--transform NAME] [--reports DIR] [--output FILE] [--dry-run]",
		);
		process.exit(0);
	} else throw new Error(`Unknown argument: ${argument}`);
}

const importers = new Map();
const visited = new Set();
for (const project of ["tsconfig.json", "src/lib/frontend/tsconfig.json"]) {
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
	const resolutionCache = ts.createModuleResolutionCache(
		root,
		(file) => file,
		config.options,
	);
	const pending = [...config.fileNames];
	while (pending.length) {
		const file = path.resolve(pending.pop());
		if (
			visited.has(file) ||
			!file.startsWith(`${root}${path.sep}`) ||
			file.includes(`${path.sep}node_modules${path.sep}`)
		)
			continue;
		visited.add(file);
		const source = ts.sys.readFile(file);
		if (source === undefined) continue;
		const relative = path.relative(root, file).split(path.sep).join("/");
		for (const specifier of ts.preProcessFile(source, true, true)
			.importedFiles) {
			const resolved = ts.resolveModuleName(
				specifier.fileName,
				file,
				config.options,
				ts.sys,
				resolutionCache,
			).resolvedModule;
			if (!resolved || resolved.isExternalLibraryImport) continue;
			const dependency = path.resolve(resolved.resolvedFileName);
			if (!dependency.startsWith(`${root}${path.sep}`)) continue;
			const key = path.relative(root, dependency).split(path.sep).join("/");
			const dependents = importers.get(key) ?? new Set();
			dependents.add(relative);
			importers.set(key, dependents);
			pending.push(dependency);
		}
	}
}

function reachable(file) {
	const seen = new Set();
	const pending = [file];
	while (pending.length) {
		const current = pending.pop();
		if (seen.has(current)) continue;
		seen.add(current);
		for (const importer of importers.get(current) ?? []) pending.push(importer);
	}
	return seen;
}

let manifest = {};
try {
	manifest = JSON.parse(await readFile(options.output, "utf8"));
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
for (const name of options.transforms.length ? options.transforms : names) {
	let report;
	let introduced;
	try {
		report = JSON.parse(
			await readFile(path.join(options.reports, `${name}.json`), "utf8"),
		);
		introduced = JSON.parse(
			await readFile(
				path.join(
					options.reports,
					`${options.combined ? "combined" : name}-introduced.json`,
				),
				"utf8",
			),
		);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		console.log(`${name}: cached evidence incomplete; skipped`);
		continue;
	}
	const outside =
		options.allNew || options.combined
			? introduced
			: introduced.filter((diagnostic) => diagnostic.category !== name);
	let deferred = 0;
	for (const file of [
		...new Set(report.edits.map((edit) => edit.file)),
	].sort()) {
		const dependents = reachable(file);
		const failures = outside.filter((diagnostic) =>
			dependents.has(diagnostic.file),
		);
		if (!failures.length) continue;
		const sites = report.entries
			.filter((entry) => entry.file === file && entry.status === "changed")
			.map((entry) => ({ line: entry.line, reference: entry.reference }));
		const uniqueSites = [
			...new Map(sites.map((site) => [JSON.stringify(site), site])).values(),
		].sort((a, b) => a.line - b.line || a.reference.localeCompare(b.reference));
		manifest[name] ??= {};
		manifest[name][file] = {
			reason: `${options.combined ? "Combined" : "Independent"} v4 measurement introduced ${failures.length} diagnostic(s) ${options.allNew || options.combined ? "while measuring" : "outside"} ${name} in this file or its transitive importers; this file did not satisfy the measurement gate.`,
			sites: uniqueSites,
		};
		deferred++;
	}
	console.log(
		`${name}: ${outside.length} new outside-category diagnostics; ${deferred} changed files deferred`,
	);
}
const sorted = Object.fromEntries(
	Object.keys(manifest)
		.sort()
		.map((name) => [
			name,
			Object.fromEntries(
				Object.entries(manifest[name]).sort(([a], [b]) => a.localeCompare(b)),
			),
		]),
);
if (!options.dryRun)
	await writeFile(options.output, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(
	options.dryRun
		? "Dry run: manifest unchanged"
		: `Wrote ${path.relative(root, options.output)}`,
);
