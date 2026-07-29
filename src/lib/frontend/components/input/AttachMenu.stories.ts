import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import AttachMenu from "./AttachMenu.svelte";

const meta = {
	title: "Input/AttachMenu",
	component: AttachMenu,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: {
		open: false,
		onToggle: fn(),
		onCamera: fn(),
		onPhotos: fn(),
	},
} satisfies Meta<typeof AttachMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Open: Story = {
	tags: ["viewport-capture"],
	args: { open: true },
};
