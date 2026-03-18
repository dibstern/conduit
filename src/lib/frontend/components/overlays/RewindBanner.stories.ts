import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { uiState } from "../../stores/ui.svelte.js";
import RewindBanner from "./RewindBanner.svelte";

const meta = {
	title: "Overlays/RewindBanner",
	component: RewindBanner,
} satisfies Meta<RewindBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Rewind mode active — banner showing at top. */
export const Active: Story = {
	play: () => {
		uiState.rewindActive = true;
		uiState.rewindSelectedUuid = null;
	},
};

/** Rewind mode with a message selected — confirmation modal showing. */
export const WithModal: Story = {
	play: () => {
		uiState.rewindActive = true;
		uiState.rewindSelectedUuid = "msg-abc-123";
	},
};

/** Rewind mode off — nothing visible. */
export const Inactive: Story = {
	play: () => {
		uiState.rewindActive = false;
		uiState.rewindSelectedUuid = null;
	},
};
