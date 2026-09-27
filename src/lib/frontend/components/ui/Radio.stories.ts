import type { Meta, StoryObj } from "@storybook/svelte-vite";
import Radio from "./Radio.svelte";

const meta = {
	title: "UI/Radio",
	component: Radio,
	tags: ["autodocs"],
	args: { "aria-label": "Option", name: "demo", value: "a" },
	argTypes: {
		checked: { control: "boolean" },
		disabled: { control: "boolean" },
	},
} satisfies Meta<typeof Radio>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = {
	args: { checked: true },
};

export const Disabled: Story = {
	args: { checked: true, disabled: true },
};

export const FocusVisible: Story = {
	args: { checked: true },
	parameters: { pseudo: { focusVisible: true } },
};
