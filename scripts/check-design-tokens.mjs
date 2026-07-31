#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const ROOT = resolve("src/lib/frontend");
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	".svelte-kit",
	"dist",
	"build",
]);

const HARD_RULES = [
	{
		name: "HARD numeric z-index",
		pattern: /z-\[[+-]?\d/,
	},
	{
		name: "HARD arbitrary rgba shadow",
		pattern: /shadow-\[[^\]]*rgba\(/i,
	},
];

const WARNING_RULES = [
	{
		name: "WARN raw hex color",
		pattern: /(?<!&)#[0-9a-fA-F]{3,8}\b/,
	},
	{
		name: "WARN arbitrary radius",
		pattern: /rounded-\[/,
	},
];

// Both extensions are scanned: class strings are increasingly hoisted into shared
// `.ts` constants (e.g. components/ui/floating-styles.ts), and a scanner that reads
// only `.svelte` would let a token violation escape simply by being extracted.
const SCANNED_EXTENSIONS = [".svelte", ".ts"];

function collectSourceFiles(directory) {
	const files = [];

	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name)) {
				files.push(...collectSourceFiles(resolve(directory, entry.name)));
			}
		} else if (
			entry.isFile() &&
			SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
		) {
			files.push(resolve(directory, entry.name));
		}
	}

	return files;
}

function displayPath(file) {
	return relative(process.cwd(), file).split(sep).join("/");
}

let hardCount = 0;
let warningCount = 0;

for (const file of collectSourceFiles(ROOT).sort()) {
	const lines = readFileSync(file, "utf8").split(/\r?\n/);

	for (const [index, line] of lines.entries()) {
		for (const rule of HARD_RULES) {
			if (rule.pattern.test(line)) {
				hardCount++;
				console.error(
					`${displayPath(file)}:${index + 1}: ${rule.name} — ${line.trim()}`,
				);
			}
		}

		for (const rule of WARNING_RULES) {
			if (rule.pattern.test(line)) {
				warningCount++;
				console.warn(
					`${displayPath(file)}:${index + 1}: ${rule.name} — ${line.trim()}`,
				);
			}
		}
	}
}

console.log(
	`Design token check: ${hardCount} hard violation(s), ${warningCount} warning(s).`,
);
process.exit(hardCount > 0 ? 1 : 0);
