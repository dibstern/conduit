import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import SettingsRow from "./SettingsRow.svelte";

const meta = {
	title: "UI/SettingsRow",
	component: SettingsRow,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: {
		label: "Browser alerts",
		checked: false,
		onchange: fn(),
		disabled: false,
	},
	argTypes: {
		checked: { control: "boolean" },
		disabled: { control: "boolean" },
	},
} satisfies Meta<typeof SettingsRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithDescription: Story = {
	args: {
		description: "Show a desktop notification when a task completes.",
	},
};

export const Checked: Story = {
	args: { checked: true, onchange: meta.args.onchange },
};

export const Disabled: Story = {
	args: { disabled: true },
};

export const DisabledChecked: Story = {
	args: { checked: true, disabled: true, onchange: meta.args.onchange },
};

export const DefaultLight: Story = { globals: { theme: "light" } };
export const CheckedLight: Story = { ...Checked, globals: { theme: "light" } };
