import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect } from "storybook/test";
import Icon from "./Icon.svelte";

const meta = {
	title: "UI/Icon",
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
				"pause",
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

export const Pause: Story = {
	args: { name: "pause", size: 12, class: "text-status-violet" },
	play: async ({ canvasElement }) => {
		const icon = canvasElement.querySelector("svg");
		await expect(icon).toBeVisible();
		if (!icon) throw new Error("Pause icon is missing");
		await expect(icon.getBoundingClientRect().width).toBe(12);
		const style = getComputedStyle(icon);
		const expected = new Option().style;
		expected.color = style.getPropertyValue("--color-status-violet");
		await expect(style.color).toBe(expected.color);
	},
};

export const PauseLight: Story = { ...Pause, globals: { theme: "light" } };

export const ClaudeMark: Story = {
	args: { name: "claude", size: 32 },
};

/** Drawn from the text colour, so it is also captured in light mode. */
export const OpenCodeMark: Story = {
	args: { name: "opencode", size: 32 },
};
