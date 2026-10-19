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
import { describe, expect, it } from "vitest";
import { violations } from "./envelope-vocabulary-checker.js";

const COMPONENTS = join(process.cwd(), "src/lib/frontend/components");

const componentFiles = (dir: string): readonly string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return componentFiles(path);
		return entry.isFile() && entry.name.endsWith(".svelte") ? [path] : [];
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
