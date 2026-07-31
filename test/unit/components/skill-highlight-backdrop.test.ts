import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import SkillHighlightBackdrop from "../../../src/lib/frontend/components/input/SkillHighlightBackdrop.svelte";

const commandNames = new Set(["commit", "effect-ts"]);

function mount(text: string) {
	return render(SkillHighlightBackdrop, {
		props: { text, commandNames },
	}).container;
}

describe("SkillHighlightBackdrop", () => {
	afterEach(cleanup);

	it("renders a recognised skill as a pill", () => {
		const c = mount("run /commit now");
		const pill = c.querySelector(".skill-pill");
		expect(pill?.textContent).toBe("/commit");
		expect(c.querySelector(".skill-unknown")).toBeNull();
	});

	it("renders an unknown slash token as an error span", () => {
		const c = mount("run /comit now");
		expect(c.querySelector(".skill-pill")).toBeNull();
		expect(c.querySelector(".skill-unknown")?.textContent).toBe("/comit");
	});

	it("does not highlight file paths", () => {
		const c = mount("open /etc/hosts");
		expect(c.querySelector(".skill-pill")).toBeNull();
		expect(c.querySelector(".skill-unknown")).toBeNull();
	});

	it("renders the text losslessly (no stray whitespace) so the caret stays aligned", () => {
		const text = "a /commit and /effect-ts and /comit end";
		const c = mount(text);
		// The mirror's textContent must equal the raw input exactly, or the
		// transparent textarea's caret would drift from the visible glyphs.
		expect(c.firstElementChild?.textContent).toBe(text);
	});
});
