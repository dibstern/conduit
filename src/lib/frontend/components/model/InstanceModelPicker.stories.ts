import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { discoveryState } from "../../stores/discovery.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
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

/**
 * Open the popover and assert it really opened. Shared by every story below,
 * because a silent no-op click would bless a baseline of a CLOSED picker and
 * nothing in the screenshot would say so.
 */
async function openPicker(canvasElement: HTMLElement) {
	const canvas = within(canvasElement);
	const trigger = await canvas.findByTestId("model-picker-trigger");
	await userEvent.click(trigger);
	const picker = await canvas.findByTestId("model-picker");
	await canvas.findByTestId("model-picker-list");
	// Opening the picker must land the caret in the search box. This is an
	// assertion, not a setup step: the focus used to come from an `autofocus`
	// attribute, which the HTML spec ignores once the document's
	// autofocus-processed flag is set -- i.e. for anything rendered after load.
	// It was inert, so the picker opened with focus nowhere and typing did
	// nothing (conduit-test-de3.35.6).
	await expect(await canvas.findByTestId("model-picker-search")).toHaveFocus();
	// userEvent.click leaves the pointer on the trigger. Its background has a
	// 150ms transition, so a hovered trigger is a flaky thing to bake into a
	// baseline, and the hover is incidental to what these stories document.
	await userEvent.unhover(trigger);
	return picker;
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
		// Locked mode keys off an active session, so leaving this set would dim
		// the rail in every story that ran after `Locked`.
		sessionState.currentId = null;
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
		await openPicker(canvasElement);
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

// ─── Controls migrated onto ui/Button in conduit-test-de3.35.6 ───────────────
// Four of the seven had no baseline at all: the favourites toggle in its lit
// state, the geo-routing chips, and the whole locked-mode rail. `Open` covers
// the rest (search row, model rows, the set-default star, the reload footer).

/** Favourites filter engaged — the rail toggle lit via `data-active`. */
export const FavoritesOn: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		const favorites = within(picker).getByTestId("picker-favorites");
		await userEvent.click(favorites);
		await expect(favorites).toHaveAttribute("aria-pressed", "true");
		// The lit colour comes from the variant's `data-[active]:text-accent`,
		// not from a class at the call site: a call-site `text-accent` loses to
		// `toolbar`'s own `text-text-dimmer` on stylesheet order.
		await expect(favorites).toHaveAttribute("data-active");
		await userEvent.unhover(favorites);
	},
};

/** A model with geo-routing scopes, one of them currently selected. */
export const RoutingOptions: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		discoveryState.providers = [
			{
				...anthropic,
				models: [
					{
						id: "claude-sonnet-4-5",
						name: "Claude Sonnet 4.5",
						provider: "claude",
						routingOptions: [
							{ value: "claude-sonnet-4-5", label: "global", isDefault: true },
							{ value: "claude-sonnet-4-5-eu", label: "eu" },
							{ value: "claude-sonnet-4-5-us", label: "us" },
						],
					},
				],
			},
		];
		discoveryState.currentProviderId = "claude";
		discoveryState.currentModelId = "claude-sonnet-4-5-eu";
		discoveryState.defaultProviderId = "claude";
		discoveryState.defaultModelId = "claude-sonnet-4-5";
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		const chips = within(picker).getAllByRole("button", {
			name: /^(global|eu|us)$/,
		});
		expect(chips).toHaveLength(3);
		// `getByRole` rather than indexing the array: it raises its own failure if
		// the chip is missing, which keeps a hand-written plain-Error throw out of
		// this file. test/unit/effect/runtime-boundary-grep.test.ts scans stories
		// too, and it matches source text -- including comments, which is how the
		// first draft of THIS comment failed the suite.
		await expect(
			within(picker).getByRole("button", { name: "eu" }),
		).toHaveAttribute("data-active");
	},
};

/**
 * Locked mode: a session is already bound to an instance, so every other rail
 * entry is soft-disabled. Soft, not `disabled`, because the hover tooltip is
 * the only thing that explains the lock and a real disabled button fires no
 * `mouseenter`.
 */
export const Locked: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		discoveryState.providers = [
			anthropic,
			{
				id: "opencode",
				name: "OpenCode",
				configured: true,
				models: [{ id: "gpt-5", name: "GPT-5", provider: "opencode" }],
			},
		];
		sessionState.currentId = "session-1";
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		const other = within(picker).getByTestId("picker-instance-opencode");
		await expect(other).toHaveAttribute("aria-disabled", "true");
	},
};

/**
 * The rail's hover tooltip, which had no visual coverage before
 * conduit-test-ee6y replaced the hand-written one with `ui/Tooltip`.
 *
 * This is the first real consumer of that primitive -- until now only a
 * fixture used it -- and it is the story that proves two things the unit
 * tests cannot: that the tooltip escapes the picker's clip by portalling to
 * <body>, and that a `side="right"` surface actually casts a shadow. It did
 * not before; nothing had ever asked for a side-anchored one.
 *
 * The explicit timeout is not padding. `ui/Tooltip` keeps Bits' 700ms open
 * delay on purpose, and testing-library's default `findBy` timeout is 1000ms,
 * which leaves 300ms of slack on a loaded CI box. A flaky gate teaches people
 * to rerun until green, which is worse than no gate.
 */
export const RailTooltip: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		await openPicker(canvasElement);
		const body = canvasElement.ownerDocument.body;
		const rail = body.querySelector<HTMLElement>(
			'[data-testid^="picker-instance-"]',
		);
		await expect(rail).not.toBeNull();
		await userEvent.hover(rail as HTMLElement);
		const tip = await within(body).findByRole("tooltip", undefined, {
			timeout: 3000,
		});
		// Parent, not visibility: a body-scoped query finds the tooltip whether
		// or not it portalled, so only the parent distinguishes the two.
		await expect(tip.closest("body")).toBe(body);
		await expect(tip).toBeVisible();
	},
};
