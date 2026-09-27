import type { Meta, StoryObj } from "@storybook/svelte-vite";
import StepHeader from "./StepHeader.svelte";

const meta = {
	title: "Setup/StepHeader",
	component: StepHeader,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: {
		totalSteps: 4,
		currentIdx: 1,
		title: "Install certificate",
		description: "Encrypt traffic between this device and the Conduit relay.",
	},
} satisfies Meta<typeof StepHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SingleStep: Story = {
	args: {
		totalSteps: 1,
		currentIdx: 0,
		title: "Confirm setup",
		description: "Review the configuration before opening Conduit.",
	},
};
