import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { within } from "storybook/test";
import SetupPage from "./SetupPage.svelte";

// ─── Meta ───────────────────────────────────────────────────────────────────

const meta = {
	title: "Pages/SetupPage",
	component: SetupPage,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
	},
	// SetupPage probes `${httpsUrl}/info` with a real fetch on mount. httpsUrl is
	// an unroutable CGNAT address, so the settled state arrives whenever the OS
	// gives up — and the two platforms disagreed: the committed darwin baseline
	// froze mid-probe ("Checking HTTPS connection...") while the linux one froze
	// settled. Every story here passes initialSetupInfo, so this probe is the only
	// fetch the page makes; failing it immediately makes the render deterministic
	// and keeps the suite off the network.
	beforeEach: () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (_input: RequestInfo | URL, _init?: RequestInit) =>
			Promise.reject(new TypeError("Failed to fetch"));
		return () => {
			globalThis.fetch = realFetch;
		};
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
	// Assert the probe has settled before the screenshot: the stub above makes
	// this immediate, and it fails loudly rather than capturing a pending frame.
	play: async ({ canvasElement }) => {
		await within(canvasElement).findByText(
			"Certificate not trusted yet. Install it above, then retry.",
		);
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
