import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import StepPush from "./StepPush.svelte";

const meta = {
	title: "Setup/StepPush",
	component: StepPush,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: {
		totalSteps: 4,
		currentIdx: 3,
		pushNeedsHttps: false,
		pushEnabled: false,
		pushBusy: false,
		pushStatus: null,
		pushMessage: "",
		onnextstep: fn(),
		onenablepush: fn(),
	},
} satisfies Meta<typeof StepPush>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const RequestingPermission: Story = {
	args: {
		pushBusy: true,
	},
};

export const HttpsRequired: Story = {
	args: {
		pushNeedsHttps: true,
	},
};

export const Enabled: Story = {
	args: {
		pushEnabled: true,
		pushStatus: "ok",
		pushMessage: "Push notifications enabled!",
	},
};

export const PermissionDenied: Story = {
	args: {
		pushStatus: "warn",
		pushMessage:
			"Notification permission was denied. Enable it in browser settings.",
	},
};
