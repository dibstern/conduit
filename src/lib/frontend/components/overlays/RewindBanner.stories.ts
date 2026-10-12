import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import {
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
} from "../../stores/chat.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import { mockSession } from "../../stories/mocks.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import RewindBanner from "./RewindBanner.svelte";

const storySessionId = "story-rewind";
let sequence = 0;

function seed({
	active = false,
	selectedUuid = null,
	pending = false,
	provider = "opencode",
}: {
	active?: boolean;
	selectedUuid?: string | null;
	pending?: boolean;
	provider?: "opencode" | "claude";
} = {}): void {
	uiState.rewindActive = active;
	uiState.rewindSelectedUuid = selectedUuid;
	applySessionChange({
		_tag: "snapshot",
		rows: [
			{
				...mockSession,
				id: storySessionId,
				model: { provider, model: "story-model" },
			},
		],
		sequence: ++sequence,
	});
	applySessionChange({ _tag: "synchronized" });
	sessionState.currentId = storySessionId;
	getOrCreateSessionActivity(storySessionId);
	getOrCreateSessionMessages(storySessionId).transcript = pending
		? {
				rows: [],
				hwm: sequence,
				hasMore: false,
				status: { _tag: "live" },
				project: "story-project",
				pending: [],
				pendingRewindMessageId: "message-after-cut",
				waiting: new Map(),
				partOrder: new Map(),
			}
		: null;
}

const meta = {
	title: "Overlays/RewindBanner",
	component: RewindBanner,
	tags: ["autodocs"],
	parameters: {
		// WithModal renders a fixed inset-0 dialog; needs own iframe viewport.
		docs: { story: { inline: false, height: "360px" } },
	},
} satisfies Meta<typeof RewindBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Rewind mode active — banner showing at top. */
export const Active: Story = {
	beforeEach: () => {
		seed({ active: true });
	},
};

/** Rewind mode with a message selected — confirmation modal showing. */
export const WithModal: Story = {
	// The confirmation modal is a fixed full-viewport backdrop; without this the
	// baseline is a 34px strip of the banner and the modal is absent.
	tags: ["viewport-capture"],
	beforeEach: () => {
		seed({ active: true, selectedUuid: "msg-abc-123" });
	},
};

/** Rewind mode off — nothing visible. */
export const Inactive: Story = { beforeEach: () => seed() };

export const Pending: Story = {
	args: { pendingOnly: true },
	beforeEach: () => seed({ pending: true }),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByRole("status")).toHaveTextContent(
			"Rewound. Sending your next message makes it permanent.",
		);
		await expect(canvas.getByRole("button", { name: "Undo" })).toBeVisible();
	},
};

export const WithClaudeModal: Story = {
	tags: ["viewport-capture"],
	beforeEach: () =>
		seed({ active: true, selectedUuid: "msg-abc-123", provider: "claude" }),
};

export const Hover: Story = {
	...Active,
	parameters: { pseudo: { hover: true } },
};

/**
 * The modal's own hover state. `Hover` above spreads `Active`, which renders
 * the banner alone — so the confirm/cancel pair had no hovered baseline at
 * all, and a change to the Cancel button's hover colour passed this file green
 * while the identical change to ConfirmModal's Cancel correctly churned. Green
 * meant "not covered", not "unchanged".
 */
export const WithModalHover: Story = {
	...WithModal,
	// Repeated literally rather than inherited from the spread: Storybook's
	// indexer parses CSF statically, so a spread `tags` never reaches
	// index.json and the capture-mode tag is silently lost.
	tags: ["viewport-capture"],
	parameters: { pseudo: { hover: true } },
};
