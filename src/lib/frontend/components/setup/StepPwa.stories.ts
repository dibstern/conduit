import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import StepPwa from "./StepPwa.svelte";

const meta = {
	title: "Setup/StepPwa",
	component: StepPwa,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: {
		totalSteps: 4,
		currentIdx: 2,
		isIOS: false,
		isAndroid: false,
		isDesktop: true,
		isSafari: false,
		isIPad: false,
		onnextstep: fn(),
	},
} satisfies Meta<typeof StepPwa>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const IOSSafari: Story = {
	args: {
		isIOS: true,
		isDesktop: false,
		isSafari: true,
	},
};

export const IOSIPad: Story = {
	args: {
		isIOS: true,
		isDesktop: false,
		isSafari: true,
		isIPad: true,
	},
};

export const IOSRequiresSafari: Story = {
	args: {
		isIOS: true,
		isDesktop: false,
	},
};

export const Android: Story = {
	args: {
		isAndroid: true,
		isDesktop: false,
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
