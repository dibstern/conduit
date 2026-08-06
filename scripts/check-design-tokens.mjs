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

const INTERACTION_STATE_RULES = [
	{
		name: "HARD raw Tailwind palette color in interaction state",
		pattern:
			/\b(?:hover|focus|focus-visible|active|disabled):(?:bg|text|border|ring|outline|fill|stroke|decoration|divide|accent|caret|shadow|from|via|to)-(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/(?:\[[0-9.]+%?\]|\d{1,3}))?/,
	},
	{
		name: "HARD raw white/black opacity tint in interaction state",
		pattern:
			/\b(?:hover|focus|focus-visible|active|disabled):(?:bg|text|border|ring|outline|fill|stroke|decoration|divide|accent|caret|shadow|from|via|to)-(?:white|black)\/(?:\[[0-9.]+%?\]|\d{1,3})/,
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

const MAX_WAIVER_LOOKBACK = 10;

// HTML forbids a comment between a tag's name and its own attributes, so when the
// flagged attribute is not the tag's own line (a multi-line Svelte/HTML element with
// class on its own line), the marker can't legally sit directly above that attribute
// line — it has to sit directly above the *tag's opening line* instead. This checks the
// immediately preceding line first (covers .ts files and single-line tags), then falls
// back to walking backward to the enclosing tag's opening line and checking just above
// that, bounded so it can't scan an entire file.
function extractWaiverReason(line) {
	const trimmed = line.trim();
	const htmlMatch = trimmed.match(
		/^<!--\s*design-token-waiver:\s*(.+?)\s*-->$/,
	);
	if (htmlMatch) return htmlMatch[1];
	const lineMatch = trimmed.match(/^\/\/\s*design-token-waiver:\s*(.+)$/);
	if (lineMatch) return lineMatch[1];
	return null;
}

// A line only counts as "this tag's still-open opening line" if it starts a tag and
// does not also close it — `<button` with no `>` yet continues onto later attribute
// lines, but `<button class="...">...</button>` is a fully self-contained sibling
// element and must not be mistaken for an ancestor of a later, unrelated violation.
function isUnclosedTagStartLine(line) {
	return /^\s*<[a-zA-Z][\w-]*(?:\s|$)/.test(line) && !line.includes(">");
}

function findWaiverReason(lines, matchIndex) {
	if (matchIndex > 0) {
		const direct = extractWaiverReason(lines[matchIndex - 1]);
		if (direct) return direct;
	}

	for (
		let i = matchIndex - 1, steps = 0;
		i > 0 && steps < MAX_WAIVER_LOOKBACK;
		i--, steps++
	) {
		if (isUnclosedTagStartLine(lines[i])) {
			return extractWaiverReason(lines[i - 1]);
		}
		// Anything with `<` or `>` that isn't our own tag's opening line is a boundary —
		// a closing tag, a self-contained sibling, or another nested element. Stop
		// rather than risk walking past it into an unrelated element's waiver comment.
		if (lines[i].includes("<") || lines[i].includes(">")) {
			break;
		}
	}

	return null;
}

let hardCount = 0;
let warningCount = 0;
let waivedCount = 0;

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

		for (const rule of INTERACTION_STATE_RULES) {
			if (rule.pattern.test(line)) {
				const waiverReason = findWaiverReason(lines, index);
				if (waiverReason) {
					waivedCount++;
					console.log(
						`${displayPath(file)}:${index + 1}: WAIVED (${rule.name}) — ${waiverReason}`,
					);
				} else {
					hardCount++;
					console.error(
						`${displayPath(file)}:${index + 1}: ${rule.name} — ${line.trim()}`,
					);
				}
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
	`Design token check: ${hardCount} hard violation(s), ${warningCount} warning(s), ${waivedCount} waived.`,
);
process.exit(hardCount > 0 ? 1 : 0);
