import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps pane state, geometry and file preview presentation out of the layout and UI store", () => {
	const layout = readFileSync(
		"src/lib/frontend/components/layout/ChatLayout.svelte",
		"utf8",
	);
	const ui = readFileSync("src/lib/frontend/stores/ui.svelte.ts", "utf8");
	expect(layout).toContain("<RightPane>");
	expect(layout).not.toMatch(
		/filesPane|filesOpen|fileViewer|paneDrag|paneWidth|setRightPane/,
	);
	expect(ui).not.toMatch(/fileViewer|rightPane|filesPane/);
});
