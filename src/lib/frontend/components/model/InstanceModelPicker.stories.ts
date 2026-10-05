import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import {
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
} from "../../stores/chat.svelte.js";
import {
	clearDiscoveryState,
	discoveryState,
	handleContextWindowInfo,
	handleDefaultModelInfo,
	handleModelInfo,
	handleModelList,
	handleVariantInfo,
} from "../../stores/discovery.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import type { ProviderInfo } from "../../types.js";
import InstanceModelPicker from "./InstanceModelPicker.svelte";

const contextWindows = [
	{ value: "200k", label: "200K", isDefault: true },
	{ value: "1m", label: "1M" },
];
const variants = ["low", "medium", "high", "xhigh", "max"];

const anthropic: ProviderInfo = {
	id: "claude",
	name: "Anthropic",
	configured: true,
	models: [
		{
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			provider: "claude",
			contextWindowOptions: contextWindows,
		},
		{
			id: "claude-opus-4-1",
			name: "Claude Opus 4.1",
			provider: "claude",
			contextWindowOptions: contextWindows,
		},
	],
};
const opencode: ProviderInfo = {
	id: "opencode",
	name: "OpenCode",
	configured: true,
	models: [
		{
			id: "gpt-5",
			name: "GPT-5",
			provider: "opencode",
			limit: { context: 200_000 },
		},
	],
};

/** Keep the desktop drop-up on screen and the phone sheet bottom-anchored. */
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
	handleModelList({ providers: [anthropic] });
	handleModelInfo({
		type: "model_info",
		model: "claude-sonnet-4-5",
		provider: "claude",
	});
	handleDefaultModelInfo({
		model: "claude-sonnet-4-5",
		provider: "claude",
		variant: "",
	});
	handleContextWindowInfo({
		type: "context_window_info",
		contextWindow: "",
		options: contextWindows,
	});
	handleVariantInfo({ type: "variant_info", variant: "high", variants });
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
	await expect(
		within(picker).getByRole("heading", { name: "Harness & model" }),
	).toBeVisible();
	await expect(within(picker).getByTestId("picker-row-harness")).toBeVisible();
	await expect(within(picker).getByTestId("picker-row-model")).toBeVisible();
	// userEvent.click leaves the pointer on the trigger. Its background has a
	// 150ms transition, so a hovered trigger is a flaky thing to bake into a
	// baseline, and the hover is incidental to what these stories document.
	await userEvent.unhover(trigger);
	return picker;
}

async function drillModel(picker: HTMLElement) {
	await userEvent.click(within(picker).getByTestId("picker-row-model"));
	// Phones focus Back instead, so the keyboard does not cover the list.
	const phone = (picker.ownerDocument.defaultView?.innerWidth ?? 1024) < 768;
	await expect(
		await within(picker).findByTestId(
			phone ? "picker-back" : "model-picker-search",
		),
	).toHaveFocus();
	await expect(
		within(picker).getByRole("heading", { name: "Model" }),
	).toBeVisible();
}

async function rootControls(canvasElement: HTMLElement) {
	const picker = await openPicker(canvasElement);
	const sheet = within(picker);
	await expect(sheet.getByTestId("picker-row-context")).toHaveTextContent(
		"200K",
	);
	await expect(sheet.getByRole("radiogroup", { name: "Effort" })).toBeVisible();
	await expect(sheet.getByTestId("picker-context-option-200k")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(
		sheet
			.getAllByRole("radio")
			.slice(2)
			.map((radio) => radio.textContent),
	).toEqual(["low", "med", "high", "xhigh", "max"]);
	await userEvent.click(sheet.getByTestId("picker-row-harness"));
	await expect(sheet.getByTestId("picker-back")).toHaveFocus();
	await userEvent.click(sheet.getByTestId("picker-back"));
	await expect(sheet.getByTestId("picker-row-harness")).toHaveFocus();
	await drillModel(picker);
	await expect(picker.querySelectorAll(".model-item-context")).toHaveLength(2);
	await expect(picker.querySelector(".model-item-context")).toHaveTextContent(
		"200K / 1M",
	);
	await userEvent.click(sheet.getByTestId("picker-back"));
	await expect(sheet.getByTestId("picker-row-model")).toBeVisible();
	await expect(sheet.getByTestId("picker-row-harness")).toHaveFocus();
	await userEvent.click(sheet.getByTestId("picker-context-option-1m"));
	await expect(sheet.getByTestId("picker-context-option-1m")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(picker).toBeVisible();
	await expect(
		within(canvasElement).getByTestId("model-picker-trigger"),
	).toHaveAccessibleName(/context 1M/);
	await userEvent.click(sheet.getByTestId("picker-effort-option-xhigh"));
	await expect(sheet.getByTestId("picker-effort-option-xhigh")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(picker).toBeVisible();
	await expect(
		within(canvasElement).getByTestId("variant-badge"),
	).toHaveAccessibleName(/Extra high/);
	const phone =
		(canvasElement.ownerDocument.defaultView?.innerWidth ?? 1024) < 768;
	await expect(
		within(canvasElement).getByTestId("variant-badge"),
	).toHaveTextContent(phone ? "XHIGH" : "Extra high");
}

const meta = {
	title: "Model/InstanceModelPicker",
	component: InstanceModelPicker,
	tags: ["autodocs"],
	parameters: { layout: "padded", docs: { story: { inline: false } } },
	beforeEach: () => {
		// Reset state for each story. `selectedInstanceId` is normally rehydrated
		// from localStorage, so it has to be pinned or a stale draft leaks in.
		clearDiscoveryState();
		discoveryState.selectedInstanceId = "claude";
		// An active session locks the harness selection.
		sessionState.currentId = null;
	},
} satisfies Meta<typeof InstanceModelPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Trigger only — the popover is closed. */
export const Closed: Story = {
	beforeEach: seedClaude,
};

/** Root view, with in-place context and effort choices. */
export const Open: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		await expect(
			within(picker).getByTestId("picker-row-context"),
		).toBeVisible();
		await expect(
			within(picker).getByTestId("picker-effort-option-xhigh"),
		).toBeVisible();
	},
};

export const RootControls: Story = {
	...Open,
	// Storybook reads tags statically; a spread does not carry them.
	tags: ["viewport-capture"],
	globals: { theme: "dark" },
	play: async ({ canvasElement }) => rootControls(canvasElement),
};
export const RootControlsLight: Story = {
	...RootControls,
	// Storybook reads tags statically; a spread does not carry them.
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const DefaultEffort: Story = {
	...Open,
	// Storybook reads tags statically; a spread does not carry them.
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		handleVariantInfo({ type: "variant_info", variant: "", variants });
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		const radios = within(picker)
			.getByRole("radiogroup", { name: "Effort" })
			.querySelectorAll('[aria-checked="true"]');
		await expect(radios).toHaveLength(0);
	},
};
export const DefaultEffortLight: Story = {
	...DefaultEffort,
	// Storybook reads tags statically; a spread does not carry them.
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const SingleContextWindow: Story = {
	...Open,
	// Storybook reads tags statically; a spread does not carry them.
	tags: ["viewport-capture"],
	beforeEach: () => {
		handleModelList({ providers: [opencode] });
		handleModelInfo({
			type: "model_info",
			model: "gpt-5",
			provider: "opencode",
		});
		handleDefaultModelInfo({
			model: "gpt-5",
			provider: "opencode",
			variant: "",
		});
		discoveryState.selectedInstanceId = "opencode";
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		const row = within(picker).getByTestId("picker-row-context");
		await expect(row).toHaveTextContent("200K");
		await expect(within(row).queryByRole("radio")).toBeNull();
		await expect(
			within(picker).queryByRole("radiogroup", { name: "Effort" }),
		).toBeNull();
	},
};
export const SingleContextWindowLight: Story = {
	...SingleContextWindow,
	// Storybook reads tags statically; a spread does not carry them.
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const PremiumContextDefault: Story = {
	...Open,
	// Storybook reads tags statically; a spread does not carry them.
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		const premiumOptions = contextWindows.map((option) => ({
			...option,
			isDefault: option.value === "1m",
		}));
		handleModelList({
			providers: [
				{
					...anthropic,
					models: anthropic.models.map((model) => ({
						...model,
						contextWindowOptions: premiumOptions,
					})),
				},
			],
		});
		handleContextWindowInfo({
			type: "context_window_info",
			contextWindow: "",
			options: premiumOptions,
		});
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		await expect(
			within(picker).getByTestId("picker-context-option-1m"),
		).toHaveAttribute("aria-checked", "true");
		await expect(
			within(picker).getByTestId("picker-context-option-200k"),
		).toHaveAttribute("aria-checked", "false");
	},
};

export const ContextUsage: Story = {
	...Open,
	// Storybook reads tags statically; a spread does not carry them.
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		const id = "picker-context-usage";
		// currentChat() is a frozen empty state until the session has activity.
		getOrCreateSessionActivity(id);
		getOrCreateSessionMessages(id).contextPercent = 37;
		sessionState.currentId = id;
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		await expect(
			within(picker).getByTestId("picker-context-usage"),
		).toHaveTextContent("37% used");
	},
};

export const UnlockedHarnesses: Story = {
	...Open,
	// Storybook reads tags statically; a spread does not carry them.
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		handleModelList({ providers: [anthropic, opencode] });
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		await userEvent.click(within(picker).getByTestId("picker-row-harness"));
		await expect(
			within(picker).getByTestId("picker-instance-opencode"),
		).not.toHaveAttribute("aria-disabled", "true");
	},
};

/** Thinking-level variants available, with "high" selected. */
export const WithVariants: Story = {
	beforeEach: () => {
		seedClaude();
		handleVariantInfo({
			type: "variant_info",
			variant: "high",
			variants: ["low", "medium", "high"],
		});
	},
};

/** Favorites stay available in the Model view. */
export const FavoritesOn: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		await drillModel(picker);
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
		handleModelList({
			providers: [
				{
					...anthropic,
					models: [
						{
							id: "claude-sonnet-4-5",
							name: "Claude Sonnet 4.5",
							provider: "claude",
							routingOptions: [
								{
									value: "claude-sonnet-4-5",
									label: "global",
									isDefault: true,
								},
								{ value: "claude-sonnet-4-5-eu", label: "eu" },
								{ value: "claude-sonnet-4-5-us", label: "us" },
							],
						},
					],
				},
			],
		});
		handleModelInfo({
			type: "model_info",
			provider: "claude",
			model: "claude-sonnet-4-5-eu",
		});
		handleDefaultModelInfo({
			provider: "claude",
			model: "claude-sonnet-4-5",
			variant: "",
		});
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		await drillModel(picker);
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
 * Locked mode: a session is already bound to an instance, so every other harness
 * entry is soft-disabled and says why inline (phones cannot hover).
 */
export const Locked: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		handleModelList({
			providers: [
				anthropic,
				{
					id: "opencode",
					name: "OpenCode",
					configured: true,
					models: [{ id: "gpt-5", name: "GPT-5", provider: "opencode" }],
				},
			],
		});
		sessionState.currentId = "session-1";
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		await userEvent.click(within(picker).getByTestId("picker-row-harness"));
		const other = within(picker).getByTestId("picker-instance-opencode");
		await expect(other).toHaveAttribute("aria-disabled", "true");
		await expect(other).toHaveTextContent(/Harness is fixed for this session/);
		await userEvent.click(other);
		await expect(
			within(picker).getByRole("heading", { name: "Harness" }),
		).toBeVisible();
	},
};
export const LockedLight: Story = {
	...Locked,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

/**
 * A provider the user has not set up yet. This state ships and had no visual
 * coverage at all, so it went unnoticed: the "(not
 * configured)" suffix was a `::after` recipe in style.css, and moving it into
 * the markup would have been unverifiable against a suite that never renders
 * an unconfigured provider.
 *
 * The suffix is asserted as real text rather than by screenshot alone. That
 * is the point of moving it: pseudo-element `content` cannot be selected,
 * cannot be translated, and is announced inconsistently, so a query that
 * finds it in the accessibility tree is proof the fix did what it claimed.
 */
export const UnconfiguredProvider: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		// Every non-claude provider maps to the `opencode` instance
		// (instanceIdForProviderId is a two-way split), and the picker lists only
		// the selected instance's groups -- so selecting opencode is what puts a
		// configured and an unconfigured group side by side. That pairing is the
		// real shape: an OpenCode instance exposes whatever providers it knows
		// about, set up or not.
		handleModelList({
			providers: [
				anthropic,
				{
					id: "google",
					name: "Google",
					configured: true,
					models: [{ id: "gemini-3", name: "Gemini 3", provider: "google" }],
				},
				{
					id: "openai",
					name: "OpenAI",
					configured: false,
					models: [{ id: "gpt-5", name: "GPT-5", provider: "openai" }],
				},
			],
		});
		discoveryState.selectedInstanceId = "opencode";
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		await drillModel(picker);
		// Queried by class rather than by text: the provider name also appears
		// on the instance rail, so a text query would match two elements and
		// fail for a reason that has nothing to do with what is being proved.
		const headers = [
			...picker.querySelectorAll<HTMLElement>(".model-provider-header"),
		].map((node) => node.textContent?.trim());
		await expect(headers.sort()).toEqual(["Google", "OpenAI (not configured)"]);
	},
};
