import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, waitFor } from "storybook/test";
import { routerState, syncSlugState } from "../../stores/router.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import { connectedSocket } from "../../stories/sockets.js";
import ChatLayout from "./ChatLayout.svelte";

const PROJECT_PATH = "/p/test-project/";

/**
 * A deliberately fake version string, not the one from package.json. It renders
 * in the sidebar footer, so reading the real version would rebake the version
 * number into every baseline here and break them all on the next release bump.
 */
const STUB_VERSION = "0.0.0-storybook";

/**
 * Connecting is not enough to get off the network: ChatLayout also fetches the
 * relay status and the daemon version. Both are left unstubbed by default, which
 * the de3.33 guard rejects — see its message for why a racing request makes a
 * baseline platform-dependent.
 */
function stubProjectFetches(): () => void {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		const body = url.endsWith("/info")
			? { version: STUB_VERSION }
			: url.endsWith("/api/status")
				? { status: "ready" }
				: null;
		return body
			? Promise.resolve(
					new Response(JSON.stringify(body), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				)
			: Promise.reject(new TypeError("Failed to fetch"));
	};
	return () => {
		globalThis.fetch = realFetch;
	};
}

const meta = {
	title: "Layout/ChatLayout",
	component: ChatLayout,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		// Reset state for each story
		uiState.sidebarCollapsed = false;
		uiState.rewindActive = false;
		routerState.path = PROJECT_PATH;
		// ChatLayout's connect effect reads slugState, NOT routerState.path, and
		// bails on a null slug. Writing the path alone left the slug null, so
		// connect() was never called at all — which is the first of the two reasons
		// these baselines were pictures of ConnectOverlay rather than of this
		// layout. router.svelte.ts documents this export as being for exactly this
		// case. See conduit-test-732b.
		syncSlugState(PROJECT_PATH);
		// The second reason: Storybook is served by a static file server, so the
		// socket connect() opens never completes and the overlay never lifts.
		const restoreSocket = connectedSocket();
		const restoreFetch = stubProjectFetches();
		return () => {
			restoreFetch();
			restoreSocket();
		};
	},
} satisfies Meta<typeof ChatLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Guards the whole file. The overlay is `fixed inset-0 bg-bg`, so while it is
 * mounted the screenshot shows nothing but the overlay — and a screenshot of the
 * overlay is perfectly stable, which is precisely why this went unnoticed.
 * Asserting its absence is the difference between "the capture succeeded" and
 * "the capture is of this component".
 */
const expectLayoutVisible: NonNullable<Story["play"]> = async ({
	canvasElement,
}) => {
	await waitFor(
		() => {
			expect(
				canvasElement.querySelector("#connect-overlay"),
				"ConnectOverlay never went away — this baseline is a picture of the overlay, not of ChatLayout",
			).toBeNull();
		},
		// The overlay fades for CONNECT_FADEOUT_MS (600ms) after connecting before
		// it unmounts, which is longer than waitFor's default budget.
		{ timeout: 5000 },
	);
	expect(canvasElement.querySelector("#app")).not.toBeNull();
};

export const Default: Story = { play: expectLayoutVisible };

export const SidebarCollapsed: Story = {
	beforeEach: () => {
		uiState.sidebarCollapsed = true;
	},
	play: expectLayoutVisible,
};

/**
 * Rewind mode is activated AFTER mount, not in `beforeEach`. ChatLayout's connect
 * effect calls `resetProjectUI()`, which sets `rewindActive` back to false, so a
 * value seeded before render is wiped before the first paint — which is why this
 * story's baseline was byte-identical to Default's even after the ConnectOverlay
 * fix. `sidebarCollapsed` survives the same path only because `resetProjectUI()`
 * does not touch it. See conduit-test-732b.
 */
export const WithRewindBanner: Story = {
	play: async (context) => {
		await expectLayoutVisible(context);
		uiState.rewindActive = true;
		await waitFor(() => {
			expect(
				context.canvasElement.querySelector(".rewind-banner"),
				"rewind banner never rendered — this baseline is indistinguishable from Default",
			).not.toBeNull();
		});
	},
};
