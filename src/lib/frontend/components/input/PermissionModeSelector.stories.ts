import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { discoveryState } from "../../stores/discovery.svelte.js";
import PermissionModeSelector from "./PermissionModeSelector.svelte";

const meta = {
	title: "Input/PermissionModeSelector",
	component: PermissionModeSelector,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	beforeEach: () => {
		discoveryState.permissionMode = "ask";
		discoveryState.pendingPermissionMode = null;
	},
} satisfies Meta<typeof PermissionModeSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AcceptEdits: Story = {
	beforeEach: () => {
		discoveryState.permissionMode = "acceptEdits";
	},
};

export const AutoApprove: Story = {
	beforeEach: () => {
		discoveryState.permissionMode = "auto";
	},
};

export const DropdownOpen: Story = {
	tags: ["viewport-capture"],
	// The menu is portaled out of the story canvas by ui/Menu, so the panel is
	// only reachable from document.body -- the trigger is still in the canvas.
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("permission-mode-badge"),
		);
		const menu = within(document.body).getByTestId("permission-mode-dropdown");
		await expect(menu).toBeVisible();
		// The radio pairing is the point of the migration: a plain menu of four
		// buttons said nothing about which mode was current.
		await expect(menu).toHaveAttribute("role", "menu");
		await expect(
			within(menu).getByRole("menuitemradio", { name: "Ask" }),
		).toHaveAttribute("aria-checked", "true");
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
