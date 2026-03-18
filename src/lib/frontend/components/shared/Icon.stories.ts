import type { Meta, StoryObj } from "@storybook/svelte-vite";
import Icon from "./Icon.svelte";

const meta = {
	title: "Shared/Icon",
	component: Icon,
	tags: ["autodocs"],
	argTypes: {
		name: {
			control: "select",
			options: [
				"plus",
				"search",
				"arrow-up",
				"check",
				"x",
				"menu",
				"send",
				"square-terminal",
				"folder-tree",
				"link",
				"share",
				"settings",
				"trash",
				"copy",
				"eye",
				"file",
				"download",
				"loader",
				"circle-check",
				"circle-x",
				"circle-alert",
				"chevron-right",
				"chevron-down",
				"arrow-left",
				"arrow-right",
				"panel-left-open",
				"panel-left-close",
				"bug",
				"zap",
				"info",
			],
		},
		size: { control: { type: "range", min: 12, max: 48, step: 2 } },
		class: { control: "text" },
	},
} satisfies Meta<typeof Icon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { name: "plus", size: 16 },
};

export const Large: Story = {
	args: { name: "search", size: 32 },
};

export const Small: Story = {
	args: { name: "check", size: 12 },
};
