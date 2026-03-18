import type { Meta, StoryObj } from "@storybook/svelte-vite";
import PinPage from "./PinPage.svelte";

const meta = {
	title: "Pages/PinPage",
	component: PinPage,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
	},
} satisfies Meta<typeof PinPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default state: empty PIN input, no error. */
export const Default: Story = {};

/** Showing an error message after a wrong PIN attempt. */
export const WithError: Story = {
	args: {
		initialError: "Wrong PIN (2 left)",
	},
};

/** Locked out after too many attempts. Input is disabled. */
export const LockedOut: Story = {
	args: {
		initialError: "Too many attempts. Try again in 5 min",
		initialDisabled: true,
	},
};
