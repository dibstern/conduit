// ─── Envelope vocabulary stops at the transport ──────────────────────────────
// A component may know that there are sessions and that one of them is the one
// on screen. It may not know that the server said so with a `snapshot` at a
// `sequence`, or that a row left by `remove` rather than by `upsert`. Those are
// the transport's words for how state travels; a component that learns them
// starts making decisions on how a fact arrived instead of on the fact.
//
// So: the words are checked where a user's browser renders them — the `.svelte`
// files. The `.stories.ts` fixtures beside them are not components; they drive
// the store's apply door on purpose, to put rows on screen without a server.
//
// `remove` is not banned as a bare word, and the import ban is why it does not
// need to be: it is ordinary English (`removeEventListener`, a diff's removed
// line), and the only way a component could mean the ENVELOPE's remove is by
// reaching for the applier, the subscription or the contract — all three of
// which are blocked below — or by writing a `_tag`, which nothing in a
// component has any other reason to do.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const COMPONENTS = join(process.cwd(), "src/lib/frontend/components");

const componentFiles = (dir: string): readonly string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return componentFiles(path);
		return entry.isFile() && entry.name.endsWith(".svelte") ? [path] : [];
	});

interface Ban {
	readonly what: string;
	readonly pattern: RegExp;
}

const banned: readonly Ban[] = [
	{ what: "the envelope tags", pattern: /\b(snapshot|upsert|synchronized)\b/i },
	{ what: "a discriminator off the wire", pattern: /_tag/ },
	{ what: "a wire sequence", pattern: /\bsequence\b/i },
	{
		what: "the subscription that owns the map",
		pattern: /from\s+["'][^"']*transport\/(session-)?subscription[^"']*["']/,
	},
	{
		what: "the wire contract",
		pattern: /from\s+["'][^"']*contracts\/ws-rpc[^"']*["']/,
	},
];

const violations = (source: string): readonly string[] => {
	const characters = source.split("");
	const omit = (start: number, end: number): void => {
		for (let i = start; i < end; i++) characters[i] = " ";
	};
	// The parser distinguishes comments from strings, regexes and markup text.
	const omitComments = (node: unknown): void => {
		if (node === null || typeof node !== "object") return;
		if (
			"type" in node &&
			node.type === "Comment" &&
			"start" in node &&
			typeof node.start === "number" &&
			"end" in node &&
			typeof node.end === "number"
		) {
			omit(node.start, node.end);
			return;
		}
		for (const child of Object.values(node)) omitComments(child);
	};
	const ast = parse(source, { modern: true });
	for (const comment of ast.comments) omit(comment.start, comment.end);
	omitComments(ast.fragment);
	// Svelte's CSS AST omits comments. Match strings as tokens too, so comment
	// delimiters inside quoted CSS values remain visible to the guard.
	if (ast.css) {
		const { start, styles } = ast.css.content;
		for (const token of styles.matchAll(
			/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\//g,
		)) {
			if (token[0].startsWith("/*"))
				omit(start + token.index, start + token.index + token[0].length);
		}
	}
	const code = characters.join("");
	return banned.filter((ban) => ban.pattern.test(code)).map((ban) => ban.what);
};

describe("the vocabulary guard", () => {
	it("detects multiline transport imports", () => {
		expect(
			violations(`<script lang="ts">import { reduce } from
"../../transport/subscription-state.js";</script>`),
		).toContain("the subscription that owns the map");
	});
	it("ignores script and markup comments", () => {
		expect(
			violations(`<script lang="ts">
// snapshot sequence
/* import { reduce } from "../../transport/subscription-state.js"; */
const title = "safe";
</script>
	<div><!-- upsert synchronized _tag --></div>`),
		).toEqual([]);
	});
	it("keeps comment-like text in strings visible", () => {
		expect(
			violations(`<script>const title = "// snapshot";</script>`),
		).toContain("the envelope tags");
	});
	it("ignores CSS comments without hiding quoted CSS values", () => {
		expect(
			violations(`<style>/* snapshot sequence */ p { color: red; }</style>`),
		).toEqual([]);
		expect(
			violations(`<style>p::after { content: "/* snapshot */"; }</style>`),
		).toContain("the envelope tags");
	});
});

describe("a component", () => {
	it("never speaks the transport's vocabulary", () => {
		const found = componentFiles(COMPONENTS).flatMap((path) =>
			violations(readFileSync(path, "utf8")).map(
				(what) => `${relative(process.cwd(), path)}: ${what}`,
			),
		);
		expect(found).toEqual([]);
	});
});
