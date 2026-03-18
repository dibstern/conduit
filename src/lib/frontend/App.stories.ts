import type { Meta, StoryObj } from "@storybook/svelte-vite";
import App from "./App.svelte";

const meta = {
	title: "App",
	component: App,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
	},
} satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
