import { parse } from "svelte/compiler";

interface Ban {
	readonly what: string;
	// Literal text every match contains. Omitting comments only turns characters
	// into spaces, so a source without it cannot match and skips the Svelte parse.
	readonly word: RegExp;
	readonly pattern: RegExp;
}

const banned: readonly Ban[] = [
	// `$state.snapshot` is Svelte's rune for a plain copy of reactive state.
	{
		what: "the envelope tags",
		word: /snapshot|upsert|synchronized/i,
		pattern: /(?<!\$state\.)\b(snapshot|upsert|synchronized)\b/i,
	},
	{ what: "a discriminator off the wire", word: /_tag/, pattern: /_tag/ },
	{ what: "a wire sequence", word: /sequence/i, pattern: /\bsequence\b/i },
	{
		what: "the subscription that owns the map",
		word: /subscription/,
		pattern: /from\s+["'][^"']*transport\/(session-)?subscription[^"']*["']/,
	},
	{
		what: "the wire contract",
		word: /contracts\/ws-rpc/,
		pattern: /from\s+["'][^"']*contracts\/ws-rpc[^"']*["']/,
	},
];

export const violations = (source: string): readonly string[] => {
	if (!banned.some(({ word }) => word.test(source))) return [];
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
