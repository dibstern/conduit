import { describe, expect, it } from "vitest";
import { violations } from "./envelope-vocabulary-checker.js";

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
	it("allows Svelte's $state.snapshot rune but not a bare snapshot", () => {
		expect(
			violations(`<script>const copy = $state.snapshot(draft);</script>`),
		).toEqual([]);
		expect(
			violations(`<script>const copy = store.snapshot(draft);</script>`),
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
