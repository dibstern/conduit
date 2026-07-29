import type { Meta, StoryObj } from "@storybook/svelte-vite";
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
};

export const UnknownSkill: Story = {
	args: {
		text: "Run /deploy-production after the checks pass.",
	},
};

export const MixedSkills: Story = {
	args: {
		text: "Use /review, then run /missing-skill before /test.",
	},
};
