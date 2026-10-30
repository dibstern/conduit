import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it.each([
	"components/chat/TurnActivity.svelte",
	"components/chat/TurnLog.svelte",
	"components/chat/SurfacingMessageCard.svelte",
	"stores/turn-panel.svelte.ts",
	"stores/reveal.svelte.ts",
	"components/chat/MessageList.svelte",
])("keeps transcript writes in the controller: %s", (file) => {
	const source = readFileSync(
		new URL(`../../../src/lib/frontend/${file}`, import.meta.url),
		"utf8",
	);
	expect(
		source.match(
			/\bscrollTop\s*\+?=(?!=)|\bscrollTo\s*\(|\bscrollIntoView\b/g,
		) ?? [],
	).toEqual([]);
});
