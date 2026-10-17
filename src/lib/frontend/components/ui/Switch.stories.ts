import type { Meta, StoryObj } from "@storybook/svelte-vite";
import Switch from "./Switch.svelte";

const meta = {
	title: "UI/Switch",
	component: Switch,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: { checked: false },
} satisfies Meta<typeof Switch>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SmallOff: Story = {};
export const SmallOn: Story = { args: { checked: true } };
export const LargeOff: Story = { args: { size: "lg" } };
export const LargeOn: Story = { args: { size: "lg", checked: true } };
export const SmallOffLight: Story = { globals: { theme: "light" } };
export const SmallOnLight: Story = { ...SmallOn, globals: { theme: "light" } };
export const LargeOffLight: Story = {
	...LargeOff,
	globals: { theme: "light" },
};
export const LargeOnLight: Story = { ...LargeOn, globals: { theme: "light" } };
