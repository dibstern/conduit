import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import { uiState } from "../../stores/ui.svelte.js";
import ConfirmModal from "./ConfirmModal.svelte";

const meta = {
	title: "Overlays/ConfirmModal",
	component: ConfirmModal,
	tags: ["autodocs"],
	parameters: {
		docs: { story: { inline: false, height: "300px" } },
	},
	beforeEach: () => {
		uiState.confirmDialog = null;
	},
} satisfies Meta<typeof ConfirmModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Visible: Story = {
	beforeEach: () => {
		uiState.confirmDialog = {
			text: "Are you sure you want to delete this session? This action cannot be undone.",
			actionLabel: "Confirm",
			resolve: (result: boolean) => {
				console.log("Confirm result:", result);
				uiState.confirmDialog = null;
			},
		};
	},
	play: async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog");
		await expect(dialog).toBeVisible();
		expect(dialog.matches(":modal")).toBe(true);
		await expect(
			within(dialog).getByTestId("confirm-modal-cancel"),
		).toBeVisible();
	},
};

export const WithCustomAction: Story = {
	beforeEach: () => {
		uiState.confirmDialog = {
			text: "This will permanently delete the selected session and all associated data.",
			actionLabel: "Delete",
			resolve: (result: boolean) => {
				console.log("Delete result:", result);
				uiState.confirmDialog = null;
			},
		};
	},
	play: async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog");
		expect(dialog.matches(":modal")).toBe(true);
		await expect(
			within(dialog).getByTestId("confirm-modal-action"),
		).toHaveTextContent("Delete");
	},
};

export const Hidden: Story = {};

export const Hover: Story = {
	...Visible,
	parameters: { pseudo: { hover: true } },
};

export const CleanWorktree: Story = {
	beforeEach: () => {
		uiState.confirmDialog = {
			text: 'Delete "Finished work"? This session and its history will be permanently removed.',
			actionLabel: "Delete",
			resolve: () => {
				uiState.confirmDialog = null;
			},
			worktreeChoice: {
				removeWorktrees: true,
				worktrees: [
					{
						folder: "/workspace/app",
						path: "/conduit/worktrees/app/finished/app",
						reasons: [],
						inUse: false,
					},
				],
			},
		};
	},
	play: async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog");
		await expect(
			within(dialog).getByText("No unfinished work found."),
		).toBeVisible();
		await expect(
			within(dialog).getByRole("radio", {
				name: "Remove worktrees",
			}),
		).toBeChecked();
	},
};

export const UnfinishedWorktrees: Story = {
	beforeEach: () => {
		uiState.confirmDialog = {
			text: 'Delete "API migration"? This session and its history will be permanently removed.',
			actionLabel: "Delete",
			resolve: () => {
				uiState.confirmDialog = null;
			},
			worktreeChoice: {
				removeWorktrees: false,
				worktrees: [
					{
						folder: "/workspace/app",
						path: "/conduit/worktrees/app/migration/app",
						reasons: ["Uncommitted changes", "Unpushed commits"],
						inUse: false,
					},
					{
						folder: "/workspace/api",
						path: "/conduit/worktrees/app/migration/api",
						reasons: ["Commits not merged into main"],
						inUse: false,
					},
				],
			},
		};
	},
	play: async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog");
		await expect(within(dialog).getByText("Uncommitted changes")).toBeVisible();
		await expect(
			within(dialog).getByText("Commits not merged into main"),
		).toBeVisible();
		await expect(
			within(dialog).getByRole("radio", {
				name: "Keep worktrees",
			}),
		).toBeChecked();
	},
};

export const WorktreeInUse: Story = {
	beforeEach: () => {
		uiState.confirmDialog = {
			text: 'Delete "Parent session"? This session and its history will be permanently removed.',
			actionLabel: "Delete",
			resolve: () => {
				uiState.confirmDialog = null;
			},
			worktreeChoice: {
				removeWorktrees: false,
				worktrees: [
					{
						folder: "/workspace/app",
						path: "/conduit/worktrees/app/parent/app",
						reasons: [],
						inUse: true,
					},
				],
			},
		};
	},
	play: async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByRole("dialog");
		await expect(
			within(dialog).getByText(
				"Kept because another session uses this worktree.",
			),
		).toBeVisible();
		await expect(
			within(dialog).getByRole("radio", {
				name: "Remove worktrees",
			}),
		).toBeDisabled();
	},
};
