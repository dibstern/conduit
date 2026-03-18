import type { Meta, StoryObj } from "@storybook/svelte-vite";
import SetupPage from "./SetupPage.svelte";

// ─── Meta ───────────────────────────────────────────────────────────────────

const meta = {
	title: "Pages/SetupPage",
	component: SetupPage,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
	},
} satisfies Meta<typeof SetupPage>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Shared setup info ──────────────────────────────────────────────────────

const defaultSetupInfo = {
	httpsUrl: "https://100.64.0.1:7080",
	httpUrl: "http://100.64.0.1:7080",
	hasCert: true,
	lanMode: false,
};

// ─── Stories ────────────────────────────────────────────────────────────────

/** Tailscale step with warn status (not on Tailscale network). */
export const TailscaleStep: Story = {
	args: {
		initialSetupInfo: defaultSetupInfo,
	},
};

/** Certificate step (has cert, not on HTTPS). */
export const CertificateStep: Story = {
	args: {
		initialSetupInfo: {
			httpsUrl: "https://100.64.0.1:7080",
			httpUrl: "http://100.64.0.1:7080",
			hasCert: true,
			lanMode: false,
		},
	},
};

/** PWA installation step (iOS-style). */
export const PWAStep: Story = {
	args: {
		initialSetupInfo: {
			httpsUrl: "https://100.64.0.1:7080",
			httpUrl: "http://100.64.0.1:7080",
			hasCert: false,
			lanMode: true,
		},
	},
};

/** Completion screen with checkmark and "All set!" message. */
export const DoneStep: Story = {
	args: {
		initialSetupInfo: {
			httpsUrl: "https://100.64.0.1:7080",
			httpUrl: "http://100.64.0.1:7080",
			hasCert: false,
			lanMode: true,
		},
	},
};
