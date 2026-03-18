import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { uiState } from "../../stores/ui.svelte.js";
import ConfirmModal from "./ConfirmModal.svelte";

const meta = {
	title: "Overlays/ConfirmModal",
	component: ConfirmModal,
} satisfies Meta<ConfirmModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Visible: Story = {
	play: () => {
		uiState.confirmDialog = {
			text: "Are you sure you want to delete this session? This action cannot be undone.",
			actionLabel: "Confirm",
			resolve: (result: boolean) => {
				console.log("Confirm result:", result);
				uiState.confirmDialog = null;
			},
		};
	},
};

export const WithCustomAction: Story = {
	play: () => {
		uiState.confirmDialog = {
			text: "This will permanently delete the selected session and all associated data.",
			actionLabel: "Delete",
			resolve: (result: boolean) => {
				console.log("Delete result:", result);
				uiState.confirmDialog = null;
			},
		};
	},
};

export const Hidden: Story = {
	play: () => {
		uiState.confirmDialog = null;
	},
};
