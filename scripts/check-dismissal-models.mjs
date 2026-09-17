#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const ROOT = resolve("src/lib/frontend");
const MANIFEST = resolve("scripts/dismissal-model-allowlist.json");

function collectSourceFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...collectSourceFiles(path));
		else if (entry.isFile() && /\.(svelte|ts)$/.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

// Skip comments and quoted examples before matching direct global registrations.
// This is a source-pattern check, not alias or computed-event-name analysis.
const PATTERN =
	/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|(?<![\w$.])(?:document|window)\s*\.\s*addEventListener\s*\(\s*(["'`])(pointerdown|mousedown|click|keydown|focusin)\1\s*,/g;

const actual = new Set();
for (const file of collectSourceFiles(ROOT).sort()) {
	const source = readFileSync(file, "utf8");
	const code = file.endsWith(".svelte")
		? [
				...source
					.replace(/<!--[\s\S]*?-->/g, "")
					.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
			]
				.map((match) => match[1])
				.join("\n")
		: source;
	const path = relative(process.cwd(), file).split(sep).join("/");
	for (const match of code.matchAll(PATTERN)) {
		if (match[2]) actual.add(`${path} :: ${match[2]}`);
	}
}

const allowed = JSON.parse(readFileSync(MANIFEST, "utf8"));
let newCount = 0;
let staleCount = 0;
let invalidCount = 0;
for (const key of [...new Set([...actual, ...Object.keys(allowed)])].sort()) {
	if (!Object.hasOwn(allowed, key)) {
		newCount++;
		console.error(
			`${key}: unpinned global listener; use the existing dismissal owner or record a reviewed reason in scripts/dismissal-model-allowlist.json.`,
		);
	} else {
		if (typeof allowed[key] !== "string" || !allowed[key].trim()) {
			invalidCount++;
			console.error(`${key}: allowlist reason must be a non-empty string.`);
		}
		if (!actual.has(key)) {
			staleCount++;
			console.error(
				`${key}: stale allowlist entry; remove it to lock in the improvement.`,
			);
		}
	}
}

console.log(
	`Dismissal models: ${newCount} unpinned listener(s), ${staleCount} stale entry(s), ${invalidCount} invalid reason(s), ${actual.size - newCount} pinned site(s).`,
);
process.exit(newCount > 0 || staleCount > 0 || invalidCount > 0 ? 1 : 0);
