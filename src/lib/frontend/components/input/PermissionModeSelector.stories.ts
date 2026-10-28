import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { tick } from "svelte";
import { approvals } from "../../stores/composer-settings.svelte.js";
import {
	applyGetModelsResponse,
	chooseModel,
	choosePermissionMode,
	clearDiscoveryState,
	discoveryState,
	handleModelList,
	selectInstance,
} from "../../stores/discovery.svelte.js";
import { instanceState } from "../../stores/instance.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { mockClaudeAccount, mockOpenCodeAccount } from "../../stories/mocks.js";
import { openSessionForSetup } from "../../stories/session-setup.js";
import type { SessionPermissionMode } from "../../types.js";
import PermissionModeSelector from "./PermissionModeSelector.svelte";

function viewport(width: number): () => void {
	const previous = Object.getOwnPropertyDescriptor(window, "innerWidth");
	const compact = sessionViewState.compact;
	const composerWidth = sessionViewState.composerWidth;
	sessionViewState.compact = width < 768;
	sessionViewState.composerWidth = width;
	Object.defineProperty(window, "innerWidth", {
		configurable: true,
		value: width,
	});
	window.dispatchEvent(new Event("resize"));
	return () => {
		sessionViewState.compact = compact;
		sessionViewState.composerWidth = composerWidth;
		if (previous) Object.defineProperty(window, "innerWidth", previous);
		else Reflect.deleteProperty(window, "innerWidth");
		window.dispatchEvent(new Event("resize"));
	};
}

function setMode(mode: SessionPermissionMode): void {
	choosePermissionMode(mode);
}

function seedModel(provider: "claude" | "opencode"): void {
	const providers = [
		{
			id: provider,
			name: provider,
			configured: true,
			models: [{ id: "story-model", name: "Story model", provider }],
		},
	];
	instanceState.instances = [mockClaudeAccount, mockOpenCodeAccount];
	handleModelList({ providers });
	selectInstance(provider);
	applyGetModelsResponse({
		projectSlug: "story",
		instanceId: provider,
		providers,
	});
	chooseModel({ modelId: "story-model", providerId: provider });
}

function pendingApprovals(): () => void {
	const previous = Object.getOwnPropertyDescriptor(approvals, "pending");
	Object.defineProperty(approvals, "pending", {
		configurable: true,
		get: () => true,
	});
	return () => {
		if (previous) Object.defineProperty(approvals, "pending", previous);
		else Reflect.deleteProperty(approvals, "pending");
	};
}

const ranked = [
	["dontAsk", "Never ask", "Denies anything not pre-approved", true],
	["plan", "Plan", "Reads and plans, changes nothing", true],
	["ask", "Ask before edits", "The default", false],
	["acceptEdits", "Auto-accept edits", "Still asks before commands", false],
	["auto", "Auto", "A model approves or denies each action", true],
	["full", "Full access", "Never asks. Use in a sandbox", false],
] as const;

async function assertMode(
	canvasElement: HTMLElement,
	mode: SessionPermissionMode,
) {
	await waitFor(() => expect(discoveryState.permissionMode).toBe(mode));
	await tick();
	const badge = within(canvasElement).queryByTestId("permission-mode-badge");
	await expect(badge).toBeVisible();
	await expect(badge?.textContent?.trim()).toBe("");
	await expect(badge?.querySelector("svg")).toBeInTheDocument();
	const label = ranked.find(([value]) => value === mode)?.[1];
	await expect(badge).toHaveAccessibleName(
		new RegExp(`Permissions:? ${label}\\. Open options`),
	);
}

async function selectMode(
	canvasElement: HTMLElement,
	mode: SessionPermissionMode,
) {
	const canvas = within(canvasElement);
	const body = within(canvasElement.ownerDocument.body);
	await userEvent.click(canvas.getByTestId("permission-mode-badge"));
	await userEvent.click(
		await body.findByTestId(`permission-mode-option-${mode}`),
	);
	await waitFor(() =>
		expect(
			body.queryByTestId("permission-mode-dropdown"),
		).not.toBeInTheDocument(),
	);
	await assertMode(canvasElement, mode);
}

const meta = {
	title: "Input/PermissionModeSelector",
	component: PermissionModeSelector,
	tags: ["autodocs"],
	globals: { theme: "dark" },
	parameters: { layout: "centered" },
	beforeEach: () => {
		const previousSession = sessionState.currentId;
		const previousInstances = instanceState.instances;
		const restoreViewport = viewport(1280);
		clearDiscoveryState();
		openSessionForSetup(null);
		seedModel("claude");
		setMode("ask");
		return () => {
			restoreViewport();
			clearDiscoveryState();
			openSessionForSetup(previousSession);
			instanceState.instances = previousInstances;
		};
	},
} satisfies Meta<typeof PermissionModeSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement }) => {
		await assertMode(canvasElement, "ask");
	},
};

export const AcceptEdits: Story = {
	beforeEach: () => {
		setMode("acceptEdits");
	},
	play: async ({ canvasElement }) => {
		await assertMode(canvasElement, "acceptEdits");
	},
};

export const AutoApprove: Story = {
	beforeEach: () => {
		setMode("auto");
	},
	play: async ({ canvasElement }) => {
		await assertMode(canvasElement, "auto");
	},
};

export const DropdownOpen: Story = {
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("permission-mode-badge"),
		);
		const menu = within(canvasElement.ownerDocument.body).getByTestId(
			"permission-mode-dropdown",
		);
		await expect(menu).toBeVisible();
		await expect(menu).toHaveAttribute("role", "menu");
		await expect(within(menu).getAllByRole("separator")).toHaveLength(1);
		await expect(
			within(menu).getByTestId("permission-mode-option-ask"),
		).toHaveAttribute("aria-checked", "true");
		await expect(
			within(menu)
				.getAllByRole("menuitemradio")
				.map((item) => item.getAttribute("data-testid")),
		).toEqual(ranked.map(([mode]) => `permission-mode-option-${mode}`));
		for (const [mode, label, description, claudeOnly] of ranked) {
			const item = within(menu).getByTestId(`permission-mode-option-${mode}`);
			await expect(within(item).getByText(label)).toBeVisible();
			await expect(within(item).getByText(description)).toBeVisible();
			await expect(within(item).queryByText("Claude") !== null).toBe(
				claudeOnly,
			);
		}
		const colours = ranked.map(([mode]) => {
			const icon = within(menu)
				.getByTestId(`permission-mode-option-${mode}`)
				.querySelector("svg");
			if (!icon) throw new Error(`Missing permission icon for ${mode}`);
			return getComputedStyle(icon).color;
		});
		await expect(new Set(colours).size).toBe(6);
		const selected = within(menu).getByTestId("permission-mode-option-ask");
		await expect(getComputedStyle(menu).paddingTop).toBe("6px");
		await expect(getComputedStyle(menu).borderRadius).toBe("16px");
		await expect(getComputedStyle(selected).borderRadius).toBe("10px");
		const probe = document.createElement("span");
		probe.style.cssText =
			"color:var(--color-text);background:color-mix(in oklab, var(--color-accent) 14%, transparent)";
		menu.append(probe);
		await expect(getComputedStyle(selected).color).toBe(
			getComputedStyle(probe).color,
		);
		await expect(getComputedStyle(selected).backgroundColor).toBe(
			getComputedStyle(probe).backgroundColor,
		);
		probe.remove();
		const masks = new Set<string>();
		for (const [mode] of ranked) {
			const icon = within(menu)
				.getByTestId(`permission-mode-option-${mode}`)
				.querySelector("svg");
			const body = icon?.querySelector('[data-part="body"]');
			const mask = icon?.querySelector("mask");
			if (!icon || !body || !mask)
				throw new Error(`Missing filled permission icon for ${mode}`);
			await expect(getComputedStyle(body).fill).toBe(
				getComputedStyle(icon).color,
			);
			await expect(body.getAttribute("mask")).toBe(`url(#${mask.id})`);
			masks.add(mask.id);
		}
		await expect(masks.size).toBe(6);
	},
};

export const DropdownOpenLight: Story = {
	...DropdownOpen,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};

export const PhoneDefault: Story = {
	beforeEach: () => viewport(393),
	play: async ({ canvasElement }) => {
		await assertMode(canvasElement, "ask");
	},
};

export const PhoneDefaultLight: Story = {
	...PhoneDefault,
	globals: { theme: "light" },
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};

export const Light: Story = {
	globals: { theme: "light" },
	play: async ({ canvasElement }) => {
		await assertMode(canvasElement, "ask");
	},
};

export const PhoneClaudeCycle: Story = {
	beforeEach: () => {
		setMode("plan");
		return viewport(393);
	},
	play: async ({ canvasElement }) => {
		await assertMode(canvasElement, "plan");
		for (const mode of [
			"acceptEdits",
			"auto",
			"full",
			"dontAsk",
			"plan",
		] as const)
			await selectMode(canvasElement, mode);
	},
};

export const PhoneOpenCodeCycle: Story = {
	beforeEach: () => {
		seedModel("opencode");
		setMode("acceptEdits");
		return viewport(393);
	},
	play: async ({ canvasElement }) => {
		await assertMode(canvasElement, "acceptEdits");
		await selectMode(canvasElement, "full");
		await selectMode(canvasElement, "ask");
	},
};

export const PhoneHoldMenu: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => {
		setMode("acceptEdits");
		return viewport(393);
	},
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(badge);
		const menu = body.getByTestId("permission-mode-dropdown");
		await expect(menu).toBeVisible();
		await assertMode(canvasElement, "acceptEdits");
		await expect(menu).toBeVisible();
		await expect(
			within(menu)
				.getAllByRole("menuitemradio")
				.map((item) => item.getAttribute("data-testid")),
		).toEqual(ranked.map(([mode]) => `permission-mode-option-${mode}`));
		for (const [mode, label, description, claudeOnly] of ranked) {
			const item = within(menu).getByTestId(`permission-mode-option-${mode}`);
			await expect(within(item).getByText(label)).toBeVisible();
			await expect(within(item).getByText(description)).toBeVisible();
			await expect(within(item).queryByText("Claude") !== null).toBe(
				claudeOnly,
			);
		}
	},
};

export const PhoneSelectCloses: Story = {
	beforeEach: () => {
		setMode("acceptEdits");
		return viewport(393);
	},
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		const body = within(canvasElement.ownerDocument.body);
		badge.focus();
		await userEvent.keyboard("{Enter}");
		await expect(body.getByTestId("permission-mode-dropdown")).toBeVisible();
		await userEvent.click(body.getByTestId("permission-mode-option-full"));
		await assertMode(canvasElement, "full");
		await waitFor(() =>
			expect(
				body.queryByTestId("permission-mode-dropdown"),
			).not.toBeInTheDocument(),
		);
		await waitFor(async () => {
			await expect(badge).toHaveFocus();
		});
	},
};

export const PhoneKeyboard: Story = {
	beforeEach: () => {
		setMode("acceptEdits");
		return viewport(393);
	},
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		const body = within(canvasElement.ownerDocument.body);
		badge.focus();
		await userEvent.keyboard("{Enter}");
		await expect(body.getByTestId("permission-mode-dropdown")).toBeVisible();
		await assertMode(canvasElement, "acceptEdits");
		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(
				body.queryByTestId("permission-mode-dropdown"),
			).not.toBeInTheDocument(),
		);
		await userEvent.keyboard(" ");
		await expect(body.getByTestId("permission-mode-dropdown")).toBeVisible();
		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(
				body.queryByTestId("permission-mode-dropdown"),
			).not.toBeInTheDocument(),
		);
	},
};

export const PhoneLight: Story = {
	globals: { theme: "light" },
	beforeEach: () => {
		setMode("plan");
		return viewport(393);
	},
	play: async ({ canvasElement }) => {
		await assertMode(canvasElement, "plan");
		for (const mode of [
			"acceptEdits",
			"auto",
			"full",
			"dontAsk",
			"plan",
		] as const)
			await selectMode(canvasElement, mode);
	},
};

export const Responsive: Story = {
	beforeEach: () => viewport(393),
	play: async ({ canvasElement }) => {
		await assertMode(canvasElement, "ask");
		for (const width of [296, 366, 395, 768, 1280]) {
			viewport(width);
			await assertMode(canvasElement, "ask");
		}
	},
};

export const OpenCodeNormalizesAuto: Story = {
	beforeEach: () => {
		seedModel("opencode");
		setMode("auto");
	},
	play: async ({ canvasElement }) => {
		await assertMode(canvasElement, "ask");
	},
};

export const Pending: Story = {
	// play() ends with the menu open to show its disabled options.
	tags: ["viewport-capture"],
	beforeEach: () => pendingApprovals(),
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		const body = within(canvasElement.ownerDocument.body);
		await expect(badge).toHaveAttribute("aria-busy", "true");
		await expect(badge).toHaveAttribute("aria-disabled", "true");
		await userEvent.click(badge);
		await assertMode(canvasElement, "ask");
		const menu = body.getByTestId("permission-mode-dropdown");
		await expect(menu).toBeVisible();
		for (const item of within(menu).getAllByRole("menuitemradio")) {
			await expect(item).toHaveAttribute("aria-disabled", "true");
		}
		body.getByTestId("permission-mode-option-full").click();
		await tick();
		await assertMode(canvasElement, "ask");
	},
};

export const PhonePending: Story = {
	beforeEach: () => {
		setMode("plan");
		const restoreViewport = viewport(393);
		const restorePending = pendingApprovals();
		return () => {
			restorePending();
			restoreViewport();
		};
	},
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		const body = within(canvasElement.ownerDocument.body);
		await expect(badge).toHaveAttribute("aria-busy", "true");
		await userEvent.click(badge);
		await assertMode(canvasElement, "plan");
		const menu = body.getByTestId("permission-mode-dropdown");
		await expect(menu).toBeVisible();
		for (const item of within(menu).getAllByRole("menuitemradio"))
			await expect(item).toHaveAttribute("aria-disabled", "true");
		body.getByTestId("permission-mode-option-full").click();
		await assertMode(canvasElement, "plan");
		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(
				body.queryByTestId("permission-mode-dropdown"),
			).not.toBeInTheDocument(),
		);
	},
};
