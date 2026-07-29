import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import Toggle from "./Toggle.svelte";

const meta = {
	title: "UI/Toggle",
	component: Toggle,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: {
		label: "Browser alerts",
		checked: false,
		onchange: fn(),
		disabled: false,
		dimmed: false,
	},
	argTypes: {
		checked: { control: "boolean" },
		disabled: { control: "boolean" },
		dimmed: { control: "boolean" },
	},
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithDescriptionAndIcon: Story = {
	args: {
		icon: "bell",
		description: "Show a desktop notification when a task completes.",
	},
};

export const Checked: Story = {
	args: { checked: true },
};

export const Disabled: Story = {
	args: { disabled: true },
};

export const Dimmed: Story = {
	args: { checked: true, dimmed: true },
};
