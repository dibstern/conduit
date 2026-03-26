import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { resetNotifState } from "../../stores/notification-reducer.svelte.js";
import { permissionsState } from "../../stores/permissions.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import type { Toast as ToastType } from "../../types.js";
import NotificationStack from "./NotificationStack.svelte";

const meta = {
	title: "Overlays/Toast",
	component: NotificationStack,
	tags: ["autodocs"],
	parameters: {
		docs: { story: { inline: false, height: "200px" } },
	},
	beforeEach: () => {
		uiState.toasts = [];
		permissionsState.pendingPermissions = [];
		resetNotifState();
	},
} satisfies Meta<typeof NotificationStack>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Helper to set toasts directly without auto-dismiss. */
function setToasts(toasts: ToastType[]): void {
	uiState.toasts = toasts;
}

export const DefaultToast: Story = {
	beforeEach: () => {
		setToasts([
			{
				id: "story-default-1",
				message: "Session created successfully",
				variant: "default",
				duration: 999999,
			},
		]);
	},
};

export const WarnToast: Story = {
	beforeEach: () => {
		setToasts([
			{
				id: "story-warn-1",
				message: "Context window is almost full (92%)",
				variant: "warn",
				duration: 999999,
			},
		]);
	},
};

export const MultipleToasts: Story = {
	beforeEach: () => {
		setToasts([
			{
				id: "story-multi-1",
				message: "File saved",
				variant: "default",
				duration: 999999,
			},
			{
				id: "story-multi-2",
				message: "Connection lost",
				variant: "warn",
				duration: 999999,
			},
			{
				id: "story-multi-3",
				message: "Reconnected",
				variant: "default",
				duration: 999999,
			},
		]);
	},
};
