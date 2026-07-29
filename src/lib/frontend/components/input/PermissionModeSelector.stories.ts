import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { userEvent, within } from "storybook/test";
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
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("permission-mode-badge"),
		);
	},
};
