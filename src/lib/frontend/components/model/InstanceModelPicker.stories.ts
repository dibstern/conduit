import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { discoveryState } from "../../stores/discovery.svelte.js";
import type { ProviderInfo } from "../../types.js";
import InstanceModelPicker from "./InstanceModelPicker.svelte";

// The real composer anchors this picker to the bottom of the screen and the
// popover opens upward. Stories deliberately keep it at the top of the frame:
// at phone widths the popover switches to `fixed inset-x-2 bottom-2 h-[70vh]`,
// so a bottom-anchored story would have the open popover cover its own trigger
// and variant badge, making the interaction specs unrunnable on mobile.

const anthropic: ProviderInfo = {
	id: "claude",
	name: "Anthropic",
	configured: true,
	models: [
		{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "claude" },
		{ id: "claude-opus-4-1", name: "Claude Opus 4.1", provider: "claude" },
	],
};

/** Anchor the story frame bottom-right, the way the composer anchors the
 *  picker, so an open popover renders on screen instead of above the frame.
 *  Only safe for stories that never click the trigger again once open: at
 *  phone widths the popover is `fixed` over the bottom 70% of the viewport,
 *  covering the trigger and the variant badge. */
function bottomRightFrame(): () => void {
	const root = document.getElementById("storybook-root");
	root?.setAttribute(
		"style",
		"display:flex;align-items:flex-end;justify-content:flex-end;min-height:100vh;padding:16px;box-sizing:border-box",
	);
	return () => root?.removeAttribute("style");
}

/** Seed a single configured Anthropic provider with Sonnet selected. */
function seedClaude(): void {
	discoveryState.providers = [anthropic];
	discoveryState.currentProviderId = "claude";
	discoveryState.currentModelId = "claude-sonnet-4-5";
	discoveryState.defaultProviderId = "claude";
	discoveryState.defaultModelId = "claude-sonnet-4-5";
}

const meta = {
	title: "Model/InstanceModelPicker",
	component: InstanceModelPicker,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
	beforeEach: () => {
		// Reset state for each story. `selectedInstanceId` is normally rehydrated
		// from localStorage, so it has to be pinned or a stale draft leaks in.
		discoveryState.providers = [];
		discoveryState.currentProviderId = "";
		discoveryState.currentModelId = "";
		discoveryState.defaultProviderId = "";
		discoveryState.defaultModelId = "";
		discoveryState.currentVariant = "";
		discoveryState.availableVariants = [];
		discoveryState.currentContextWindow = "";
		discoveryState.availableContextWindowOptions = [];
		discoveryState.hiddenModels = [];
		discoveryState.selectedInstanceId = "claude";
	},
} satisfies Meta<typeof InstanceModelPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Trigger only — the popover is closed. */
export const Closed: Story = {
	beforeEach: seedClaude,
};

/** Popover open, showing the instance rail and the provider's models. */
export const Open: Story = {
	// The dropdown is `absolute` on desktop but `max-sm:fixed`, so at mobile width it
	// escapes #storybook-root — which is the element this suite screenshots. Without
	// this tag the mobile baseline would capture the trigger and no menu at all.
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		await new Promise((r) => setTimeout(r, 50));
		const btn = canvasElement.querySelector(".model-btn") as HTMLElement | null;
		btn?.click();
	},
};

/** Thinking-level variants available, with "high" selected. */
export const WithVariants: Story = {
	beforeEach: () => {
		seedClaude();
		discoveryState.availableVariants = ["low", "medium", "high"];
		discoveryState.currentVariant = "high";
	},
};
