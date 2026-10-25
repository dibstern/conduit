import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect } from "storybook/test";
import SkillHighlightBackdrop from "./SkillHighlightBackdrop.svelte";

const commandNames = new Set(["review", "systematic-debugging", "test"]);

const meta = {
	title: "Input/SkillHighlightBackdrop",
	component: SkillHighlightBackdrop,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	args: {
		text: "Review the authentication flow before changing it.",
		commandNames,
	},
} satisfies Meta<typeof SkillHighlightBackdrop>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const RecognizedSkill: Story = {
	args: {
		text: "Use /systematic-debugging to isolate the connection failure.",
	},
	play: async ({ canvasElement, args }) => {
		await document.fonts.ready;
		const mirror = canvasElement.querySelector<HTMLElement>(".mirror");
		if (!mirror) throw new Error("Skill mirror is missing");
		await expect(mirror.textContent).toBe(args["text"]);
		const box = mirror.getBoundingClientRect();
		const plain = mirror.cloneNode(false) as HTMLElement;
		plain.textContent = args["text"];
		plain.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;visibility:hidden`;
		canvasElement.append(plain);
		const glyphs = (root: Node) => {
			const positions: DOMRect[] = [];
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				const node = walker.currentNode;
				for (let index = 0; index < (node.textContent?.length ?? 0); index++) {
					const range = document.createRange();
					range.setStart(node, index);
					range.setEnd(node, index + 1);
					positions.push(range.getBoundingClientRect());
				}
			}
			return positions;
		};
		try {
			const expected = glyphs(plain);
			for (const [index, glyph] of glyphs(mirror).entries()) {
				// Separate inline runs round to the browser's 1/64px layout unit.
				await expect(
					Math.abs(glyph.x - (expected[index]?.x ?? NaN)),
				).toBeLessThanOrEqual(1 / 64);
				await expect(
					Math.abs(glyph.y - (expected[index]?.y ?? NaN)),
				).toBeLessThanOrEqual(1 / 64);
			}
		} finally {
			plain.remove();
		}
	},
};

/** URLs take the link colour without moving a glyph out from under the caret. */
export const Url: Story = {
	args: {
		text: "See https://studio.example.ts.net/review/, then reload the page.",
	},
	play: async (context) => {
		await RecognizedSkill.play?.(context);
		await expect(
			context.canvasElement.querySelector(".composer-url")?.textContent,
		).toBe("https://studio.example.ts.net/review/");
	},
};

export const UnknownSkill = {
	args: {
		// 352e7835 leaves unrelated slash tokens plain; exercise a real typo.
		text: "Run /reviev after the checks pass.",
	},
	play: async ({ canvasElement }) => {
		await expect(
			canvasElement.querySelector(".skill-unknown")?.textContent,
		).toBe("/reviev");
	},
} satisfies Story;

export const MixedSkills: Story = {
	args: {
		text: "Use /review, then run /reviev before /test.",
	},
	play: UnknownSkill.play,
};
