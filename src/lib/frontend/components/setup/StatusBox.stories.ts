import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { createRawSnippet } from "svelte";
import StatusBox from "./StatusBox.svelte";

/** Pass plain text as StatusBox's `children` snippet from a .stories.ts. */
const content = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

const meta = {
	title: "Setup/StatusBox",
	component: StatusBox,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: {
		status: "pending",
		children: content("Checking HTTPS connection..."),
	},
	argTypes: {
		status: {
			control: "inline-radio",
			options: ["ok", "warn", "pending"],
		},
	},
} satisfies Meta<typeof StatusBox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Success: Story = {
	args: {
		status: "ok",
		children: content("HTTPS connection verified. Certificate is trusted."),
	},
};

export const Warning: Story = {
	args: {
		status: "warn",
		children: content(
			"Certificate not trusted yet. Install it above, then retry.",
		),
	},
};
