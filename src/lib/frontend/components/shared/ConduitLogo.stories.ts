import type { Meta, StoryObj } from "@storybook/svelte-vite";
import ConduitLogo from "./ConduitLogo.svelte";

const meta = {
	title: "Shared/ConduitLogo",
	component: ConduitLogo,
	tags: ["autodocs"],
	argTypes: {
		size: {
			control: "select",
			options: ["standard", "loading", "sidebar", "inline"],
		},
		animated: { control: "boolean" },
		showText: { control: "boolean" },
	},
} satisfies Meta<typeof ConduitLogo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Standard: Story = { args: { size: "standard", showText: true } };
export const Loading: Story = {
	args: { size: "loading", animated: true, showText: true },
};
export const Sidebar: Story = { args: { size: "sidebar", showText: true } };
export const InlineSpinner: Story = {
	args: { size: "inline", animated: true, showText: false },
};
export const StandardAnimated: Story = {
	args: { size: "standard", animated: true, showText: true },
};
