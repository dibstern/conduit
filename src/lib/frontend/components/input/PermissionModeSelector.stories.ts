import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { tick } from "svelte";
import { approvals } from "../../stores/composer-settings.svelte.js";
import {
	clearDiscoveryState,
	discoveryState,
	handleModelInfo,
	handlePermissionModeInfo,
} from "../../stores/discovery.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import type { SessionPermissionMode } from "../../types.js";
import PermissionModeSelector from "./PermissionModeSelector.svelte";

function viewport(width: number): () => void {
	const previous = Object.getOwnPropertyDescriptor(window, "innerWidth");
	Object.defineProperty(window, "innerWidth", {
		configurable: true,
		value: width,
	});
	window.dispatchEvent(new Event("resize"));
	return () => {
		if (previous) Object.defineProperty(window, "innerWidth", previous);
		else Reflect.deleteProperty(window, "innerWidth");
		window.dispatchEvent(new Event("resize"));
	};
}

function setMode(mode: SessionPermissionMode): void {
	handlePermissionModeInfo({ mode });
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

const pointer = (node: HTMLElement, type: string) =>
	node.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			pointerId: 1,
			isPrimary: true,
			pointerType: "touch",
			button: 0,
		}),
	);

const ranked = [
	["dontAsk", "Never ask", "Denies anything not pre-approved.", true],
	["plan", "Plan", "Reads and proposes. No edits.", true],
	["ask", "Ask", "Asks before each edit or command.", false],
	["acceptEdits", "Edits", "File edits run without asking.", false],
	["auto", "Auto", "A model approves or denies each action.", true],
	["full", "Full access", "Everything runs. No prompts.", false],
] as const;

const meta = {
	title: "Input/PermissionModeSelector",
	component: PermissionModeSelector,
	tags: ["autodocs"],
	globals: { theme: "dark" },
	parameters: { layout: "centered" },
	beforeEach: () => {
		const previousSession = sessionState.currentId;
		const restoreViewport = viewport(1280);
		clearDiscoveryState();
		handleModelInfo({
			model: "story-model",
			provider: "claude",
		});
		sessionState.currentId = null;
		setMode("ask");
		discoveryState.pendingPermissionMode = null;
		return () => {
			restoreViewport();
			clearDiscoveryState();
			sessionState.currentId = previousSession;
		};
	},
} satisfies Meta<typeof PermissionModeSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		await expect(within(badge).getByText("Ask")).toBeVisible();
		await expect(getComputedStyle(badge).color).toBe("rgb(168, 175, 187)");
		await expect(getComputedStyle(badge).flexDirection).toBe("row");
		await expect(badge.querySelectorAll("svg path")).toHaveLength(2);
		await expect(badge.querySelector("svg circle")).not.toBeNull();
	},
};

export const AcceptEdits: Story = {
	beforeEach: () => {
		setMode("acceptEdits");
	},
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		await expect(within(badge).getByText("Edits")).toBeVisible();
		await expect(getComputedStyle(badge).color).toBe("rgb(244, 183, 64)");
	},
};

export const AutoApprove: Story = {
	beforeEach: () => {
		setMode("auto");
	},
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		await expect(within(badge).getByText("Auto")).toBeVisible();
		await expect(getComputedStyle(badge).color).toBe("rgb(255, 138, 76)");
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
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};

export const Light: Story = {
	globals: { theme: "light" },
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		await expect(getComputedStyle(badge).color).toBe("rgb(75, 82, 94)");
	},
};

export const PhoneClaudeCycle: Story = {
	beforeEach: () => {
		setMode("plan");
		return viewport(393);
	},
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		const body = within(canvasElement.ownerDocument.body);
		await expect(within(badge).getByText("PLAN")).toBeVisible();
		await waitFor(() =>
			expect(getComputedStyle(badge).color).toBe("rgb(90, 169, 245)"),
		);
		await expect(getComputedStyle(badge).flexDirection).toBe("column");
		await expect(badge.querySelectorAll("svg path")).toHaveLength(1);
		await expect(badge.querySelector("svg circle")).toBeNull();
		for (const [label, colour, tinted] of [
			["ASK", "rgb(168, 175, 187)", false],
			["EDITS", "rgb(244, 183, 64)", true],
			["AUTO", "rgb(255, 138, 76)", true],
			["FULL", "rgb(244, 96, 122)", true],
			["NEVER", "rgb(79, 209, 197)", false],
			["PLAN", "rgb(90, 169, 245)", false],
		] as const) {
			await userEvent.click(badge);
			await expect(within(badge).getByText(label)).toBeVisible();
			await waitFor(() => expect(getComputedStyle(badge).color).toBe(colour));
			await expect(badge).toHaveAttribute("data-tinted", String(tinted));
			await expect(
				body.queryByTestId("permission-mode-dropdown"),
			).not.toBeInTheDocument();
		}
	},
};

export const PhoneOpenCodeCycle: Story = {
	beforeEach: () => {
		handleModelInfo({
			model: "story-model",
			provider: "opencode",
		});
		return viewport(393);
	},
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		const body = within(canvasElement.ownerDocument.body);
		for (const label of ["EDITS", "FULL", "ASK"]) {
			pointer(badge, "pointerdown");
			pointer(badge, "pointerup");
			badge.click();
			await tick();
			await expect(within(badge).getByText(label)).toBeVisible();
			await expect(
				body.queryByTestId("permission-mode-dropdown"),
			).not.toBeInTheDocument();
		}
	},
};

export const PhoneHoldMenu: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => viewport(393),
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		const body = within(canvasElement.ownerDocument.body);
		pointer(badge, "pointerdown");
		await new Promise((resolve) => setTimeout(resolve, 500));
		const menu = body.getByTestId("permission-mode-dropdown");
		await expect(menu).toBeVisible();
		pointer(badge, "pointerup");
		badge.click();
		await tick();
		await expect(within(badge).getByText("ASK")).toBeVisible();
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
	beforeEach: () => viewport(393),
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		const body = within(canvasElement.ownerDocument.body);
		badge.focus();
		await userEvent.keyboard("{Shift>}{F10}{/Shift}");
		await expect(body.getByTestId("permission-mode-dropdown")).toBeVisible();
		await userEvent.click(body.getByTestId("permission-mode-option-full"));
		await expect(within(badge).getByText("FULL")).toBeVisible();
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
	beforeEach: () => viewport(393),
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		const body = within(canvasElement.ownerDocument.body);
		badge.focus();
		await userEvent.keyboard("{Enter}");
		await expect(within(badge).getByText("EDITS")).toBeVisible();
		await userEvent.keyboard(" ");
		await expect(within(badge).getByText("AUTO")).toBeVisible();
		await expect(
			body.queryByTestId("permission-mode-dropdown"),
		).not.toBeInTheDocument();
		await userEvent.keyboard("{ContextMenu}");
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
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		await waitFor(() =>
			expect(getComputedStyle(badge).color).toBe("rgb(15, 98, 192)"),
		);
		for (const [label, colour] of [
			["ASK", "rgb(75, 82, 94)"],
			["EDITS", "rgb(138, 85, 0)"],
			["AUTO", "rgb(194, 65, 12)"],
			["FULL", "rgb(193, 29, 64)"],
			["NEVER", "rgb(11, 125, 116)"],
			["PLAN", "rgb(15, 98, 192)"],
		] as const) {
			await userEvent.click(badge);
			await expect(within(badge).getByText(label)).toBeVisible();
			await waitFor(() => expect(getComputedStyle(badge).color).toBe(colour));
		}
	},
};

export const Responsive: Story = {
	beforeEach: () => viewport(393),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			within(canvas.getByTestId("permission-mode-badge")).getByText("ASK"),
		).toBeVisible();
		const restoreViewport = viewport(768);
		try {
			await waitFor(async () => {
				await expect(
					within(canvas.getByTestId("permission-mode-badge")).getByText("Ask"),
				).toBeVisible();
			});
		} finally {
			restoreViewport();
		}
		await waitFor(async () => {
			await expect(
				within(canvas.getByTestId("permission-mode-badge")).getByText("ASK"),
			).toBeVisible();
		});
	},
};

export const OpenCodeNormalizesAuto: Story = {
	beforeEach: () => {
		handleModelInfo({
			model: "story-model",
			provider: "opencode",
		});
		setMode("auto");
		return viewport(393);
	},
	play: async ({ canvasElement }) => {
		const badge = within(canvasElement).getByTestId("permission-mode-badge");
		await waitFor(async () => {
			await expect(within(badge).getByText("ASK")).toBeVisible();
		});
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
		await expect(
			body.queryByTestId("permission-mode-dropdown"),
		).not.toBeInTheDocument();
		await expect(within(badge).getByText("Ask")).toBeVisible();
		badge.focus();
		await userEvent.keyboard("{ArrowDown}");
		const menu = body.getByTestId("permission-mode-dropdown");
		await expect(menu).toBeVisible();
		for (const item of within(menu).getAllByRole("menuitemradio")) {
			await expect(item).toHaveAttribute("aria-disabled", "true");
		}
		body.getByTestId("permission-mode-option-full").click();
		await tick();
		await expect(within(badge).getByText("Ask")).toBeVisible();
	},
};

export const PhonePending: Story = {
	beforeEach: () => {
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
		await expect(within(badge).getByText("ASK")).toBeVisible();
		pointer(badge, "pointerdown");
		await new Promise((resolve) => setTimeout(resolve, 500));
		pointer(badge, "pointerup");
		badge.click();
		await tick();
		await expect(within(badge).getByText("ASK")).toBeVisible();
		await expect(
			body.queryByTestId("permission-mode-dropdown"),
		).not.toBeInTheDocument();
	},
};
