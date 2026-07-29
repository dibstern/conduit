import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import StepCertificate from "./StepCertificate.svelte";

const meta = {
	title: "Setup/StepCertificate",
	component: StepCertificate,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: {
		totalSteps: 4,
		currentIdx: 1,
		isIOS: false,
		isAndroid: false,
		certStatus: "pending",
		certMessage: "Checking HTTPS connection...",
		onnextstep: fn(),
		onretryhttps: fn(),
	},
} satisfies Meta<typeof StepCertificate>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const IOSInstructions: Story = {
	args: {
		isIOS: true,
	},
};

export const AndroidInstructions: Story = {
	args: {
		isAndroid: true,
	},
};

export const CertificateNotTrusted: Story = {
	args: {
		certStatus: "warn",
		certMessage: "Certificate not trusted yet. Install it above, then retry.",
	},
};

export const Verified: Story = {
	args: {
		certStatus: "ok",
		certMessage: "HTTPS connection verified. Certificate is trusted.",
	},
};
