import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import DirectoryAutocomplete from "./DirectoryAutocomplete.svelte";

const meta = {
	title: "Project/DirectoryAutocomplete",
	component: DirectoryAutocomplete,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	args: {
		value: "",
		placeholder: "/path/to/project",
		onsubmit: fn(),
	},
} satisfies Meta<typeof DirectoryAutocomplete>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithPath: Story = {
	args: {
		value: "/Users/dev/src/conduit",
	},
};
