import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import {
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
} from "../../stores/chat.svelte.js";
import {
	applyGetModelsResponse,
	chooseContextWindow,
	chooseModel,
	chooseVariant,
	clearDiscoveryState,
	handleDefaultModelInfo,
	handleModelList,
	selectInstance,
} from "../../stores/discovery.svelte.js";
import { instanceState } from "../../stores/instance.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../stores/session.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import type { OpenCodeInstance, ProviderInfo } from "../../types.js";
import InstanceModelPicker from "./InstanceModelPicker.svelte";

const contextWindows = [
	{ value: "200k", label: "200K", isDefault: true },
	{ value: "1m", label: "1M" },
];
const variants = ["low", "medium", "high", "xhigh", "max"];

const claudeAccount = {
	id: "claude",
	name: "Claude",
	driver: "claude",
	isDefault: true,
	port: 0,
	managed: false,
	status: "healthy",
	restartCount: 0,
	createdAt: 0,
} satisfies OpenCodeInstance;
const opencodeAccount = {
	id: "opencode",
	name: "OpenCode",
	driver: "opencode",
	isDefault: true,
	port: 4096,
	managed: true,
	status: "healthy",
	restartCount: 0,
	createdAt: 0,
} satisfies OpenCodeInstance;

const anthropic: ProviderInfo = {
	id: "claude",
	name: "Anthropic",
	configured: true,
	models: [
		{
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			provider: "claude",
			variants,
			contextWindowOptions: contextWindows,
		},
		{
			id: "claude-opus-4-1",
			name: "Claude Opus 4.1",
			provider: "claude",
			variants,
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
function seedClaude(
	availableVariants = variants,
	options = contextWindows,
): void {
	instanceState.instances = [claudeAccount];
	handleModelList({
		providers: [
			{
				...anthropic,
				models: anthropic.models.map((model) => ({
					...model,
					variants: availableVariants,
					contextWindowOptions: options,
				})),
			},
		],
	});
	selectInstance("claude");
	chooseModel({ modelId: "claude-sonnet-4-5", providerId: "claude" });
	chooseVariant("high");
	chooseContextWindow(options.find((option) => option.isDefault)?.value ?? "");
	handleDefaultModelInfo({
		model: "claude-sonnet-4-5",
		provider: "claude",
		variant: "",
	});
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
		within(sheet.getByRole("radiogroup", { name: "Effort" }))
			.getAllByRole("radio")
			.map((radio) => radio.textContent),
	).toEqual(["low", "med", "high", "xhigh", "max"]);
	const rootFocusTestId = sheet.queryByTestId("picker-harness-claude")
		? "picker-harness-claude"
		: "picker-row-model";
	await expect(sheet.getByTestId(rootFocusTestId)).toHaveFocus();
	await drillModel(picker);
	await expect(picker.querySelectorAll(".model-item-context")).toHaveLength(2);
	await expect(picker.querySelector(".model-item-context")).toHaveTextContent(
		"200K / 1M",
	);
	await userEvent.click(sheet.getByTestId("picker-back"));
	await expect(sheet.getByTestId("picker-row-model")).toBeVisible();
	await expect(sheet.getByTestId(rootFocusTestId)).toHaveFocus();
	await userEvent.click(sheet.getByTestId("picker-context-option-1m"));
	await expect(sheet.getByTestId("picker-context-option-1m")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(picker).toBeVisible();
	await expect(
		within(canvasElement).getByTestId("model-picker-trigger"),
	).toHaveAttribute("data-shown-context-window", "1m");
	await userEvent.click(sheet.getByTestId("picker-effort-option-xhigh"));
	await expect(sheet.getByTestId("picker-effort-option-xhigh")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(picker).toBeVisible();
	await expect(
		within(canvasElement).getByTestId("model-picker-trigger"),
	).toHaveAttribute("data-shown-effort", "xhigh");
}

const meta = {
	title: "Model/InstanceModelPicker",
	component: InstanceModelPicker,
	tags: ["autodocs"],
	parameters: { layout: "padded", docs: { story: { inline: false } } },
	beforeEach: () => {
		const compact = sessionViewState.compact;
		const composerWidth = sessionViewState.composerWidth;
		sessionViewState.compact = window.innerWidth < 768;
		sessionViewState.composerWidth = window.innerWidth;
		// Reset state for each story.
		clearDiscoveryState();
		clearSessionState();
		instanceState.instances = [];
		// An active session locks the harness selection.
		sessionState.currentId = null;
		return () => {
			sessionViewState.compact = compact;
			sessionViewState.composerWidth = composerWidth;
		};
	},
} satisfies Meta<typeof InstanceModelPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Trigger only — the popover is closed. */
export const Closed: Story = {
	beforeEach: () => seedClaude(),
	play: async ({ canvasElement }) => {
		const trigger = within(canvasElement).getByTestId("model-picker-trigger");
		await expect(trigger).toHaveAttribute("data-shown-provider", "claude");
		await expect(trigger).toHaveAttribute(
			"data-shown-model",
			"claude-sonnet-4-5",
		);
		await expect(trigger).toHaveAttribute("data-shown-effort", "high");
		await expect(trigger).toHaveAttribute("data-shown-context-window", "200k");
		await expect(trigger).toHaveAttribute("data-shown-permission-mode", "ask");
		await expect(trigger).toHaveTextContent(/Sonnet 4\.5/);
		await expect(
			within(canvasElement).queryByTestId("composer-harness-trigger"),
		).not.toBeInTheDocument();
	},
};

export const ClosedLight: Story = { ...Closed, globals: { theme: "light" } };

/** Root view, with in-place context and effort choices. */
export const Open: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		if (sessionViewState.compact) {
			await expect(picker.closest("[data-sheet-chrome]")).not.toBeNull();
			const handle = picker
				.closest("[data-sheet-chrome]")
				?.querySelector("[data-sheet-handle]");
			if (!handle) throw new Error("The picker sheet handle is missing");
			await expect(handle.getBoundingClientRect().width).toBe(36);
			await expect(handle.getBoundingClientRect().height).toBe(5);
		}
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
		chooseVariant("");
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
		instanceState.instances = [opencodeAccount];
		handleModelList({ providers: [opencode] });
		selectInstance("opencode");
		applyGetModelsResponse({
			projectSlug: "story",
			instanceId: "opencode",
			providers: [opencode],
			active: { model: "gpt-5", provider: "opencode" },
			variant: { variant: "", variants: [] },
			contextWindow: { contextWindow: "", options: [] },
			permissionMode: "ask",
		});
		handleDefaultModelInfo({
			model: "gpt-5",
			provider: "opencode",
			variant: "",
		});
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
		const premiumOptions = contextWindows.map((option) => ({
			...option,
			isDefault: option.value === "1m",
		}));
		seedClaude(variants, premiumOptions);
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
		applySessionChange({
			_tag: "snapshot",
			sequence: 1,
			rows: [
				{
					id,
					title: "Context usage",
					projectSlug: "conduit",
					status: "idle",
					accountId: "claude",
				},
			],
		});
		// currentChat() is a frozen empty state until the session has activity.
		getOrCreateSessionActivity(id);
		getOrCreateSessionMessages(id).contextPercent = 37;
		sessionState.currentId = id;
		applyGetModelsResponse(
			{
				projectSlug: "story",
				instanceId: "claude",
				providers: [
					{
						...anthropic,
						models: anthropic.models.map((model) => ({ ...model, variants })),
					},
				],
				active: { model: "claude-sonnet-4-5", provider: "claude" },
				variant: { variant: "high", variants },
				contextWindow: { contextWindow: "200k", options: contextWindows },
				permissionMode: "ask",
			},
			id,
		);
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
		instanceState.instances = [claudeAccount, opencodeAccount];
		handleModelList({
			providers: [
				{
					...anthropic,
					models: anthropic.models.map((model) => ({ ...model, variants })),
				},
				opencode,
			],
		});
		applyGetModelsResponse({
			projectSlug: "story",
			instanceId: "opencode",
			providers: [opencode],
		});
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		await expect(
			within(picker).getByTestId("picker-harness-opencode"),
		).not.toHaveAttribute("aria-disabled", "true");
	},
};

/** Thinking-level variants available, with "high" selected. */
export const WithVariants: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude(["low", "medium", "high"]);
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		// The closed trigger does not name the effort, so open it to show the variants.
		const picker = await openPicker(canvasElement);
		await expect(
			within(picker).getByTestId("picker-effort-option-high"),
		).toHaveAttribute("aria-checked", "true");
		await expect(
			within(picker).queryByTestId("picker-effort-option-xhigh"),
		).not.toBeInTheDocument();
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
		instanceState.instances = [claudeAccount];
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
		selectInstance("claude");
		chooseModel({ providerId: "claude", modelId: "claude-sonnet-4-5-eu" });
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
 * tab is disabled and announces why.
 */
export const Locked: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		seedClaude();
		instanceState.instances = [claudeAccount, opencodeAccount];
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
		applySessionChange({
			_tag: "snapshot",
			sequence: 1,
			rows: [
				{
					id: "session-1",
					title: "Locked session",
					projectSlug: "conduit",
					status: "idle",
					accountId: "claude",
				},
			],
		});
		sessionState.currentId = "session-1";
		applyGetModelsResponse(
			{
				projectSlug: "story",
				instanceId: "claude",
				providers: [
					{
						...anthropic,
						models: anthropic.models.map((model) => ({ ...model, variants })),
					},
					opencode,
				],
				active: { model: "claude-sonnet-4-5", provider: "claude" },
				variant: { variant: "high", variants },
				contextWindow: { contextWindow: "200k", options: contextWindows },
				permissionMode: "ask",
			},
			"session-1",
		);
		return bottomRightFrame();
	},
	play: async ({ canvasElement }) => {
		const picker = await openPicker(canvasElement);
		const other = within(picker).getByTestId("picker-harness-opencode");
		await expect(other).toHaveAttribute("aria-disabled", "true");
		await expect(other).toHaveAccessibleDescription(
			"Harness is fixed for this session",
		);
		await userEvent.click(other);
		await expect(
			within(picker).getByRole("heading", { name: "Harness & model" }),
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
		instanceState.instances = [claudeAccount, opencodeAccount];
		// The OpenCode account exposes both configured and unconfigured providers.
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
		selectInstance("opencode");
		applyGetModelsResponse({
			projectSlug: "story",
			instanceId: "opencode",
			providers: [
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
			active: { model: "gemini-3", provider: "google" },
			variant: { variant: "", variants: [] },
			contextWindow: { contextWindow: "", options: [] },
			permissionMode: "ask",
		});
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
