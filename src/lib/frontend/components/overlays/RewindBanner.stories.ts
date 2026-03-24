import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { uiState } from "../../stores/ui.svelte.js";
import RewindBanner from "./RewindBanner.svelte";

const meta = {
	title: "Overlays/RewindBanner",
	component: RewindBanner,
	tags: ["autodocs"],
	beforeEach: () => {
		uiState.rewindActive = false;
		uiState.rewindSelectedUuid = null;
	},
} satisfies Meta<typeof RewindBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Rewind mode active — banner showing at top. */
export const Active: Story = {
	beforeEach: () => {
		uiState.rewindActive = true;
		uiState.rewindSelectedUuid = null;
	},
};

/** Rewind mode with a message selected — confirmation modal showing. */
export const WithModal: Story = {
	beforeEach: () => {
		uiState.rewindActive = true;
		uiState.rewindSelectedUuid = "msg-abc-123";
	},
};

/** Rewind mode off — nothing visible. */
export const Inactive: Story = {};
