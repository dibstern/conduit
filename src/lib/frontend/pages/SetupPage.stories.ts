import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import SetupPage from "./SetupPage.svelte";

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

// There is deliberately NO "Tailscale step" story here. buildStepList() only
// includes the "tailscale" step when
// `!platform.isTailscale && !isLocal && !lanMode`, and Storybook serves from
// localhost, so `isLocal` is always true and the step can never be reached from
// this page no matter what args a story passes. The story that used to claim
// otherwise rendered the certificate step under a Tailscale name, and its
// baseline was byte-identical to CertificateStep's. The step's own UI is covered
// six ways over in Setup/StepTailscale; what is not covered is the wizard chrome
// around it, which is a known and accepted gap.

/** Certificate step (has cert, not on HTTPS). */
export const CertificateStep: Story = {
	args: {
		initialSetupInfo: {
			httpsUrl: "https://100.64.0.1:7080",
			httpUrl: "http://100.64.0.1:7080",
			hasCert: true,
			lanMode: false,
			publicUrl: null,
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
			publicUrl: null,
		},
	},
};

/**
 * Tailscale Serve mode. Tailscale holds the certificate, so conduit reports no
 * cert of its own and there is no Certificate step. The PWA step warns that an
 * app added from an older address has to be added again.
 */
export const TailscaleServe: Story = {
	args: {
		initialSetupInfo: {
			httpsUrl: "https://conduit-mac.tail1234.ts.net:2633",
			httpUrl: "http://conduit-mac.tail1234.ts.net:2633",
			hasCert: false,
			lanMode: false,
			publicUrl: "https://conduit-mac.tail1234.ts.net:2633",
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(/Already added Conduit from another address\?/);
		expect(canvas.queryByText(/certificate/i)).toBeNull();
	},
};

// There is deliberately NO "done step" story here either.
// SetupPage always starts at step index 0, and the story that used to sit here
// passed args byte-identical to PWAStep's, so it captured the PWA step under the
// name "Done" — a baseline identical to PWAStep's and an assertion of nothing.
// Reaching the real Done screen from this page needs three scripted clicks and a
// stubbed service-worker failure, which would make the story a test of the
// wizard's navigation rather than a picture of its completion screen. The
// completion UI itself is covered by Setup/StepDone; the wizard chrome around it
// is the same known, accepted gap recorded above for Tailscale.
