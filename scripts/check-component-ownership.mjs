#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const ROOT = resolve("src/lib/frontend/components");
const STYLE = resolve("src/lib/frontend/style.css");
const MANIFEST = resolve("scripts/component-ownership-exceptions.json");
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	".svelte-kit",
	"dist",
	"build",
	"ui",
	"__fixtures__",
]);

const HARD_RULES = [
	{
		name: "native-control-bypass",
		pattern: /^<(?:button|select|textarea|input)(?=[\s/>])/g,
	},
	{
		name: "anchor-wearing-button-recipe",
		pattern: /(?:^|[\s"'`])bg-accent(?=$|[\s"'`])/g,
	},
	{
		name: "appearance-override",
		pattern:
			/(?:^|[\s"'`])(?:[\w-]+:|\[[^\]\s]+\]:)*-?(?:(?:bg|text|border|rounded|shadow|ring|outline|opacity|z|p[xysetblr]?|m[xysetblr]?|gap|space-[xy]|w|h|min-w|max-w|min-h|max-h|size|flex|grid|col|row|items|justify|content|self|overflow|font|leading|tracking|fill|stroke|top|right|bottom|left|inset|translate|scale|rotate|duration|delay|transition|cursor|pointer-events|select|decoration|underline-offset|order|basis|grow|shrink)-[\w./%()[\],:#-]+|block|inline|inline-block|flex|inline-flex|grid|hidden|relative|absolute|fixed|sticky|rounded|border|shadow|truncate|underline|italic|grow|shrink)!(?=\s|["'`])/g,
	},
	{
		name: "private-recipe-import",
		pattern:
			/\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]+\}\s*from\s*["']([^"']+)["']/g,
	},
	{
		name: "component-class-recipe",
		pattern:
			/^\.([\w-]+(?:-btn|-button|-toggle|-badge|-item)|header-icon-btn|model-provider-disabled|rewind-point)(?=[\s.:#[>+~]|$)/,
	},
];

function collectSourceFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name)) {
				files.push(...collectSourceFiles(resolve(directory, entry.name)));
			}
		} else if (
			entry.isFile() &&
			/\.(svelte|ts)$/.test(entry.name) &&
			!entry.name.endsWith(".stories.ts")
		) {
			files.push(resolve(directory, entry.name));
		}
	}
	return files;
}

function displayPath(file) {
	return relative(process.cwd(), file).split(sep).join("/");
}

const STRING = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gs;

// Keep strings intact while removing comments: URLs and quoted class examples
// must not turn the rest of a file into a comment or executable markup.
function withoutComments(source) {
	return source.replace(
		new RegExp(`${STRING.source}|/\\*[\\s\\S]*?\\*/|//[^\\n]*`, "g"),
		(match) => (match.startsWith("/") ? " " : match),
	);
}

// Expressions can contain nested objects and quoted braces. Stopping at the first
// closing brace would miss overrides in conditional class lists.
function expressionEnd(source, start) {
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		if ("\"'`".includes(source[i])) {
			const quote = source[i];
			while (++i < source.length) {
				if (source[i] === "\\") i++;
				else if (source[i] === quote) break;
			}
		} else if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0) return i + 1;
	}
	return source.length;
}

function classValues(tag) {
	const values = [];
	const attributes = /\sclass\s*=\s*/g;
	for (let match = attributes.exec(tag); match; match = attributes.exec(tag)) {
		const start = attributes.lastIndex;
		if (tag[start] === "{") {
			const end = expressionEnd(tag, start);
			// Only strings are class text; non-null assertions remain code.
			values.push(...(tag.slice(start, end).match(STRING) ?? []));
			attributes.lastIndex = end;
		} else if (tag[start] === '"' || tag[start] === "'") {
			const quote = tag[start];
			let end = start + 1;
			while (end < tag.length && tag[end] !== quote) {
				if (tag[end] === "{") end = expressionEnd(tag, end);
				else end++;
			}
			values.push(tag.slice(start, end + 1));
			attributes.lastIndex = end + 1;
		}
	}
	return values;
}

function openingTags(source) {
	const tags = [];
	const starts = /<[a-zA-Z][\w.-]*(?=[\s/>])/g;
	for (let match = starts.exec(source); match; match = starts.exec(source)) {
		let end = starts.lastIndex;
		while (end < source.length && source[end] !== ">") {
			if (source[end] === "{") end = expressionEnd(source, end);
			else if ("\"'".includes(source[end])) {
				const quote = source[end++];
				while (end < source.length && source[end] !== quote) {
					if (source[end] === "{") end = expressionEnd(source, end);
					else end++;
				}
				end++;
			} else end++;
		}
		tags.push(source.slice(match.index, end + 1));
		starts.lastIndex = end + 1;
	}
	return tags;
}

const actual = {};
for (const file of [...collectSourceFiles(ROOT), STYLE].sort()) {
	const source = readFileSync(file, "utf8");
	const counts = {};
	const [native, anchor, appearance, imports, recipe] = HARD_RULES;
	if (file === STYLE) {
		const names = new Set();
		const parents = [];
		// At-rules such as @layer do not change ownership. Only the first class
		// in a selector owns the recipe; descendant markdown/diff styling does not.
		for (const block of source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.matchAll(/([^{}]*)([{}])/g)) {
			if (block[2] === "}") {
				parents.pop();
				continue;
			}
			const nested = parents.some((parent) => !parent.startsWith("@"));
			parents.push(block[1].trim());
			if (nested) continue;
			for (const selector of block[1].split(",")) {
				const match = selector.trim().match(recipe.pattern);
				if (
					match &&
					!/^\.(?:markdown|diff-table)(?:[\s.:-]|$)/.test(selector.trim())
				)
					names.add(match[1]);
			}
		}
		counts[recipe.name] = names.size;
	} else {
		const code = withoutComments(
			file.endsWith(".svelte")
				? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
						.map((match) => match[1])
						.join("\n")
				: source,
		);
		counts[imports.name] = [...code.matchAll(imports.pattern)].filter(
			(match) => {
				const path = match[1].startsWith(".")
					? displayPath(resolve(dirname(file), match[1]))
					: match[1].replace(/^\$lib\//, "src/lib/");
				return path.includes("components/ui/");
			},
		).length;
		let classes = [];
		if (file.endsWith(".svelte")) {
			const markup = source.replace(
				/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g,
				"",
			);
			const tags = openingTags(markup);
			counts[native.name] = tags.reduce(
				(sum, tag) => sum + [...tag.matchAll(native.pattern)].length,
				0,
			);
			counts[anchor.name] = tags.filter(
				(tag) =>
					/^<a(?=[\s/>])/.test(tag) &&
					classValues(tag).some(
						(value) => [...value.matchAll(anchor.pattern)].length > 0,
					),
			).length;
			classes = tags.flatMap(classValues);
		} else {
			// A class-like assignment or an all-utility list is evidence of class
			// intent. Ordinary prose and TypeScript assertions are not.
			classes = [...code.matchAll(STRING)]
				.filter((match) => {
					const before = code.slice(
						Math.max(0, match.index - 100),
						match.index,
					);
					return (
						/\b[\w$]*(?:class|styles)[\w$]*\s*(?:=|:)\s*$/i.test(before) ||
						match[0]
							.slice(1, -1)
							.trim()
							.split(/\s+/)
							.every(
								(token) =>
									[
										...`${token.replace(/!$/, "")}! `.matchAll(
											appearance.pattern,
										),
									].length === 1,
							)
					);
				})
				.map((match) => match[0]);
		}
		counts[appearance.name] = classes.reduce(
			(sum, value) => sum + [...value.matchAll(appearance.pattern)].length,
			0,
		);
	}
	const remaining = Object.fromEntries(
		HARD_RULES.filter((rule) => counts[rule.name] > 0).map((rule) => [
			rule.name,
			counts[rule.name],
		]),
	);
	if (Object.keys(remaining).length) actual[displayPath(file)] = remaining;
}

const update = process.argv.includes("--update");
if (update) {
	writeFileSync(
		MANIFEST,
		`${JSON.stringify(
			{
				$comment:
					"Generated by node scripts/check-component-ownership.mjs --update. Lock in improvements; review any increases before accepting them.",
				exceptions: actual,
			},
			null,
			"\t",
		)}\n`,
	);
}
const { exceptions: allowed } = JSON.parse(readFileSync(MANIFEST, "utf8"));
let newCount = 0;
let staleCount = 0;
let knownCount = 0;

for (const file of [
	...new Set([...Object.keys(actual), ...Object.keys(allowed)]),
].sort()) {
	for (const name of new Set([
		...Object.keys(actual[file] ?? {}),
		...Object.keys(allowed[file] ?? {}),
	])) {
		const count = actual[file]?.[name] ?? 0;
		const limit = allowed[file]?.[name] ?? 0;
		knownCount += Math.min(count, limit);
		if (count > limit) {
			newCount += count - limit;
			console.error(
				`${file}: HARD ${name} — ${count - limit} new violation(s) (${limit} allowed, ${count} actual)`,
			);
		} else if (count < limit) {
			staleCount++;
			console.error(
				`${file}: HARD ${name} — count improved from ${limit} to ${count}; re-run with --update to lock in the gain.`,
			);
		}
	}
}

for (const rule of HARD_RULES) {
	const counts = Object.values(actual).map((rules) => rules[rule.name] ?? 0);
	console.log(
		`${rule.name}: ${counts.reduce((sum, count) => sum + count, 0)} violation(s) in ${counts.filter((count) => count > 0).length} file(s).`,
	);
}
console.log(
	`Component ownership: ${newCount} new violation(s), ${staleCount} stale exception(s), ${knownCount} known violation(s) remaining.`,
);
process.exit(newCount > 0 || staleCount > 0 ? 1 : 0);
