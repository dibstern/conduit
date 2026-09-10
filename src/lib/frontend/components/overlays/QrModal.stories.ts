import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, waitFor, within } from "storybook/test";
import QrModal from "./QrModal.svelte";

const noop = () => {};

/**
 * Shape mirrors the daemon's real `/health` payload (see `daemon-handle.ts`):
 * a non-Tailscale LAN address plus the port the daemon listens on.
 */
const LAN_HEALTH = {
	ok: true,
	port: 2633,
	host: "0.0.0.0",
	lanIP: "192.168.1.42",
	tlsEnabled: false,
};

/** The origin QrModal should rewrite the share URL to, given LAN_HEALTH. */
const SHARE_ORIGIN = "http://192.168.1.42:2633";

const meta = {
	title: "Overlays/QrModal",
	component: QrModal,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
		// Modal uses fixed inset-0; needs own iframe viewport.
		docs: { story: { inline: false, height: "400px" } },
	},
	// This stub is what makes the QR baseline capturable at all, for two reasons.
	//
	// 1. DETERMINISM. The QR encodes `window.location.href` verbatim, so with no
	//    LAN host the baseline bakes in Storybook's port — and that port is
	//    deliberately overridable (STORYBOOK_PORT) so two worktrees can run the
	//    suite at once. Running on any other port rewrote ~16,700 QR pixels and
	//    failed the suite for reasons that had nothing to do with the change under
	//    test. Answering /health rewrites the origin to a FIXED one, so the encoded
	//    URL no longer depends on where the story server happens to be listening.
	// 2. COVERAGE. The LAN-rewrite branch of getShareUrl() is the interesting half
	//    of this component and had none: every previous baseline showed the
	//    localhost fallback, because the component swallows fetch failures
	//    (`catch {}`) and the suite never noticed it was documenting the sad path.
	//
	// Anything other than /health is rejected, so a new request can't silently
	// reintroduce network dependence. See conduit-test-afp and conduit-test-de3.33.
	beforeEach: () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			return url.endsWith("/health")
				? Promise.resolve(
						new Response(JSON.stringify(LAN_HEALTH), {
							status: 200,
							headers: { "content-type": "application/json" },
						}),
					)
				: Promise.reject(new TypeError("Failed to fetch"));
		};
		return () => {
			globalThis.fetch = realFetch;
		};
	},
} satisfies Meta<typeof QrModal>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Modal visible with QR code rendering the current page URL.
 * Click the URL text to copy, click backdrop or press Escape to close.
 */
export const Visible: Story = {
	args: {
		visible: true,
		onClose: noop,
	},
	// Both assertions guard the screenshot below, and both have already been wrong
	// in a committed baseline:
	//
	// - The QR is generated asynchronously and its wrapper renders `{#if
	//   qrCodeIsVisible}`, so until generation resolves the card shows an EMPTY
	//   white box. Nothing waits for it, so on a slow schedule the capture froze a
	//   blank panel — and a blank panel is a perfectly stable thing to compare.
	// - Before that, the component renders a "Detecting network..." placeholder
	//   while /health is in flight, which is a third distinct frame this story
	//   could have captured.
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);

		await waitFor(() => {
			expect(
				canvasElement.querySelector("svg"),
				"QR code SVG never rendered — the capture would be a blank white box",
			).not.toBeNull();
		});

		// The share URL must be the rewritten LAN origin, never the Storybook one.
		// This is the assertion that keeps the baseline port-independent: if the
		// rewrite ever stops applying, the URL falls back to localhost:<port> and
		// this fails loudly instead of at recapture time on someone else's port.
		const shareUrl = await canvas.findByRole("button", { name: /^http/ });
		expect(shareUrl.textContent).toContain(SHARE_ORIGIN);
		expect(shareUrl.textContent).not.toContain("localhost");
	},
};

/**
 * Modal hidden — nothing renders when visible is false.
 */
export const Hidden: Story = {
	args: {
		visible: false,
		onClose: noop,
	},
};

export const Hover: Story = {
	...Visible,
	parameters: { pseudo: { hover: true } },
};
