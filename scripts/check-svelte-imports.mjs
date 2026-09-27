#!/usr/bin/env node

// Svelte's ambient `declare module '*.svelte'` lets missing components pass
// svelte-check. Deleted or moved components can therefore break at runtime
// unless relative imports are checked against the filesystem as well.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const ROOT = resolve("src/lib/frontend");

function collectSourceFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...collectSourceFiles(path));
		else if (entry.isFile() && /\.(svelte|ts|js)$/.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

// Skip comments and quoted examples, as in the other source-pattern gates.
const PATTERN =
	/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|(?<![\w$.])(?:(?:import|export)\s+(?:[^;"'`]*?\bfrom\s*)?|import\s*\(\s*)(["'])(\.{1,2}\/[^"'\r\n]*\.svelte)\1/g;

let missingCount = 0;
let checkedCount = 0;
for (const file of collectSourceFiles(ROOT).sort()) {
	const source = readFileSync(file, "utf8");
	for (const match of source.matchAll(PATTERN)) {
		const specifier = match[2];
		if (!specifier) continue;
		checkedCount++;
		if (!existsSync(resolve(dirname(file), specifier))) {
			missingCount++;
			const path = relative(process.cwd(), file).split(sep).join("/");
			const line = source.slice(0, match.index).split("\n").length;
			console.error(`${path}:${line}: ${specifier}`);
		}
	}
}

console.log(
	`Svelte imports: ${missingCount} missing file(s), ${checkedCount} relative import(s) checked.`,
);
process.exit(missingCount > 0 ? 1 : 0);
