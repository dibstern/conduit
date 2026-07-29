import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import StepDone from "./StepDone.svelte";

const meta = {
	title: "Setup/StepDone",
	component: StepDone,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: {
		ongotodone: fn(),
	},
} satisfies Meta<typeof StepDone>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
