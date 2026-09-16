import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { uiState } from "../../stores/ui.svelte.js";
import RewindBanner from "./RewindBanner.svelte";

const meta = {
	title: "Overlays/RewindBanner",
	component: RewindBanner,
	tags: ["autodocs"],
	parameters: {
		// WithModal renders a fixed inset-0 dialog; needs own iframe viewport.
		docs: { story: { inline: false, height: "360px" } },
	},
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
	// The confirmation modal is a fixed full-viewport backdrop; without this the
	// baseline is a 34px strip of the banner and the modal is absent.
	tags: ["viewport-capture"],
	beforeEach: () => {
		uiState.rewindActive = true;
		uiState.rewindSelectedUuid = "msg-abc-123";
	},
};

/** Rewind mode off — nothing visible. */
export const Inactive: Story = {};

export const Hover: Story = {
	...Active,
	parameters: { pseudo: { hover: true } },
};

/**
 * The modal's own hover state. `Hover` above spreads `Active`, which renders
 * the banner alone — so the confirm/cancel pair had no hovered baseline at
 * all, and a change to the Cancel button's hover colour passed this file green
 * while the identical change to ConfirmModal's Cancel correctly churned. Green
 * meant "not covered", not "unchanged" (conduit-test-llxm).
 */
export const WithModalHover: Story = {
	...WithModal,
	// Repeated literally rather than inherited from the spread: Storybook's
	// indexer parses CSF statically, so a spread `tags` never reaches
	// index.json and the capture-mode tag is silently lost.
	tags: ["viewport-capture"],
	parameters: { pseudo: { hover: true } },
};
