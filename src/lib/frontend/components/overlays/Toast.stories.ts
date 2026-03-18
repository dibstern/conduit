import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { uiState } from "../../stores/ui.svelte.js";
import type { Toast as ToastType } from "../../types.js";
import Toast from "./Toast.svelte";

const meta = {
	title: "Overlays/Toast",
	component: Toast,
} satisfies Meta<Toast>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Helper to set toasts directly without auto-dismiss. */
function setToasts(toasts: ToastType[]): void {
	uiState.toasts = toasts;
}

export const DefaultToast: Story = {
	play: () => {
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
	play: () => {
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
	play: () => {
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
