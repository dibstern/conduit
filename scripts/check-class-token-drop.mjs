#!/usr/bin/env node

/**
 * Every appearance regression this design-system migration has produced has had
 * exactly one shape: a Tailwind token that was in a call site's as-found
 * `class="..."` string and is in no version of the migrated call site.
 *
 * `font-brand` and `py-3` vanished from AttachMenu when it moved onto ui/Menu,
 * which shrank a thumb target by 27% and changed the composer's typeface. Both
 * were invisible to `pnpm check`, `pnpm lint` and the ownership checker, and
 * cost two full storybook-build-and-capture cycles to find in a screenshot.
 * A diff can see them for free, before any screenshot exists.
 *
 * There is no automatic pass for "it lives in the primitive now". A blanket
 * search of components/ui would excuse `font-brand` and `py-3`, which are the
 * exact two this check exists to catch -- style.css declares `--font-brand`, so
 * a substring search finds it whether or not any call site still wears it.
 * Instead a move is a waiver that names its destination and its trigger, and
 * the checker re-proves both on every run:
 *
 *   "AttachMenu.svelte :: gap-2.5,px-4,py-3": {
 *     "movedTo": "src/lib/frontend/components/ui/floating-styles.ts",
 *     "requires": "density=\"touch\"",
 *     "reason": "..."
 *   }
 *
 * The waiver holds only while `movedTo` still contains the token AND the call
 * site still contains `requires`. Delete the `density="touch"` prop and the
 * waiver stops applying, so the drop is reported again. A waiver that is just a
 * string is an outright deletion, which has nowhere to point.
 *
 * This is deliberately a DIFF check rather than a whole-tree check: the
 * question is not "does this file use good classes", it is "did this edit drop
 * a class nobody decided to drop". So it only ever looks at what changed.
 *
 * Usage:
 *   node scripts/check-class-token-drop.mjs            # uncommitted vs HEAD
 *   node scripts/check-class-token-drop.mjs --since main   # whole branch
 *
 * To clear a report: either put the token back, or add the `file :: token`
 * entry to the waiver manifest with a reason saying where the appearance went.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MANIFEST = resolve("scripts/class-token-drop-waivers.json");

// Tokens whose whole job was the hand-rolled plumbing the primitive replaces.
// Dropping these is the POINT of a migration, so reporting them is pure noise.
const PLUMBING = new Set([
	"relative",
	"absolute",
	"fixed",
	"inset-0",
	"block",
	"inline-block",
	"w-full",
	"text-left",
	"overflow-hidden",
	"shrink-0",
]);

// `+` is in the class because arbitrary values contain it
// (`bottom-[calc(100%+8px)]`); it is safe here because tokenizing only ever
// runs on text already extracted from inside a class string, never on the raw
// diff line whose first character is a `+`.
const TOKEN_PATTERN = /[A-Za-z][\w:./[\]()#%,+-]*/g;

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });
}

// A keyed property value counts as a class list only in a file that actually
// declares class recipes. `selected: "border-accent text-text"` and
// `testId: "diff-view-toggle"` are the same shape to a regex, and a gate that
// reports a renamed label or test id as a dropped utility is a gate people
// learn to waive without reading -- which is the failure this check exists to
// prevent, arriving by the other door.
const RECIPE_PATH = /-(?:styles|recipes)\.ts$/;
const RECIPE_DECLARATION =
	/\bconst\s+[A-Z][A-Z0-9_]*_(?:CLASSES|VARIANTS|RECIPES)\b|Record<[^>]*,\s*string>/;
const recipeFileCache = new Map();
function declaresRecipes(file) {
	if (RECIPE_PATH.test(file)) return true;
	let known = recipeFileCache.get(file);
	if (known === undefined) {
		known =
			existsSync(file) && RECIPE_DECLARATION.test(readFileSync(file, "utf8"));
		recipeFileCache.set(file, known);
	}
	return known;
}

// Only tokens inside a `class` attribute, recipe string, or -- in a recipe
// file -- a keyed recipe value.
// Scanning whole lines would pull in prop names, ids and prose.
function classStrings(line, keyedValues = false) {
	const out = [];
	const attr =
		/class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{"([^"]*)"\})/g;
	for (const m of line.matchAll(attr)) {
		out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
	}
	// Recipe constants and the `"a " + "b"` continuation lines they wrap onto.
	if (/^[+-]\s*(?:"[^"]*"|`[^`]*`)\s*[+,]?\s*$/.test(line)) {
		const quoted = line.match(/"([^"]*)"|`([^`]*)`/);
		if (quoted) out.push(quoted[1] ?? quoted[2]);
	}
	// A whole keyed recipe property, never an inline prop or surrounding prose.
	const property =
		keyedValues &&
		line.match(
			/^[+-]\s*(?:[A-Za-z_$][\w$]*|"[^"]*"|'[^']*')\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)\s*,?\s*$/,
		);
	if (property) out.push(property[1] ?? property[2] ?? property[3]);
	return out;
}

// Comments are stripped before any whole-file scan. Both the prose in this
// repo and the doc comments on the recipes quote class names in backticks --
// AttachMenu's own comment explains where `font-brand` went -- and a mention is
// not a wearing. Counting one as the other is a false negative in exactly the
// place the check is supposed to be loud.
function stripComments(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/^\s*\/\/.*$/gm, " ");
}

// `${OTHER_CLASSES}` is a reference to another recipe, not a utility. Left in,
// its identifier tokenizes into a bogus class name.
const classTokens = (value) =>
	value.replace(/\$\{[^}]*\}/g, " ").match(TOKEN_PATTERN) ?? [];

function tokensOf(lines, keyedValues = false) {
	const set = new Set();
	for (const line of lines) {
		for (const value of classStrings(line, keyedValues)) {
			for (const token of classTokens(value)) set.add(token);
		}
	}
	return set;
}

const sinceIndex = process.argv.indexOf("--since");
const since = sinceIndex === -1 ? null : process.argv[sinceIndex + 1];
const diffArgs = since
	? ["diff", "--unified=0", `${since}...HEAD`, "--", "*.svelte", "*.ts"]
	: ["diff", "--unified=0", "HEAD", "--", "*.svelte", "*.ts"];

const diff = git(diffArgs);
if (diff.trim() === "") {
	console.log("class-token-drop: no changed markup to check.");
	process.exit(0);
}

const perFile = new Map();
let current = null;
for (const line of diff.split("\n")) {
	const header = line.match(/^\+\+\+ b\/(.+)$/);
	if (header) {
		current = header[1];
		if (!perFile.has(current)) perFile.set(current, { removed: [], added: [] });
		continue;
	}
	if (!current || line.startsWith("+++") || line.startsWith("---")) continue;
	if (line.startsWith("-")) perFile.get(current).removed.push(line);
	else if (line.startsWith("+")) perFile.get(current).added.push(line);
}

const waivers = existsSync(MANIFEST)
	? JSON.parse(readFileSync(MANIFEST, "utf8"))
	: {};

// A waiver key is `path :: token` or `path :: tokenA,tokenB` for one decision
// that moved a group.
const waiverIndex = new Map();
for (const [key, value] of Object.entries(waivers)) {
	const [path, tokens] = key.split(" :: ");
	for (const token of tokens.split(",")) {
		waiverIndex.set(`${path} :: ${token.trim()}`, value);
	}
}

// Every quoted literal in a file, which is what a recipe file is made of. Also
// unioned into a call site's after-set, so a class the migration lifted into a
// local constant in the same file still counts as kept.
function recipeTokens(path) {
	const set = new Set();
	if (!existsSync(path)) return set;
	const text = stripComments(readFileSync(path, "utf8"));
	for (const m of text.matchAll(/"([^"]*)"|`([^`]*)`/g)) {
		for (const token of classTokens(m[1] ?? m[2])) set.add(token);
	}
	return set;
}

function isWaived(file, token, afterText, after) {
	const waiver = waiverIndex.get(`${file} :: ${token}`);
	if (waiver === undefined) return false;
	if (typeof waiver === "string") return true;
	// A rename holds only while this file still carries the replacement token.
	if (waiver.renamedTo !== undefined) return after.has(waiver.renamedTo);
	// Whole-token: the destination must really carry this class, not merely
	// mention the characters somewhere. `requires` is a literal source snippet
	// the author wrote, so that one is a substring on purpose.
	const dest = recipeTokens(waiver.movedTo);
	if (!dest.has(token)) return false;
	return waiver.requires === undefined || afterText.includes(waiver.requires);
}

const findings = [];
for (const [file, { removed, added }] of perFile) {
	if (!file.endsWith(".svelte") && !file.endsWith(".ts")) continue;
	const keyedValues = declaresRecipes(file);
	const gone = tokensOf(removed, keyedValues);
	const kept = tokensOf(added, keyedValues);
	const afterText = existsSync(file) ? readFileSync(file, "utf8") : "";
	// Only what the file still puts on an element, extracted exactly the way the
	// diff side is. A raw text search would match prose and be whole-token by
	// accident rather than by construction.
	const after = tokensOf(stripComments(afterText).split("\n"), keyedValues);
	for (const token of recipeTokens(file)) after.add(token);
	for (const token of gone) {
		if (kept.has(token) || PLUMBING.has(token)) continue;
		if (after.has(token)) continue;
		if (isWaived(file, token, afterText, after)) continue;
		findings.push(`${file} :: ${token}`);
	}
}

if (findings.length === 0) {
	console.log(
		`class-token-drop: 0 undeclared drop(s) across ${perFile.size} changed file(s).`,
	);
	process.exit(0);
}

console.error(
	`class-token-drop: ${findings.length} class token(s) left a call site and landed nowhere.\n` +
		"Each is either an appearance regression or a decision that belongs in\n" +
		`${MANIFEST} with a reason.\n`,
);
for (const finding of findings.sort()) console.error(`  ${finding}`);
process.exit(1);
