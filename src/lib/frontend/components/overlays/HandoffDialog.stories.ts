import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, within } from "storybook/test";
import {
	applyInstanceListResponse,
	instanceState,
} from "../../stores/instance.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { mockClaudeAccount } from "../../stories/mocks.js";
import HandoffDialog from "./HandoffDialog.svelte";

const meta = {
	title: "Overlays/HandoffDialog",
	component: HandoffDialog,
	tags: ["autodocs", "viewport-capture"],
	parameters: { docs: { story: { inline: false } } },
	args: {
		open: true,
		onclose: fn(),
		to: "Work",
		summary: {
			included: 24,
			omitted: 8,
			firstMessageIncluded: true,
			tokens: 3200,
		},
	},
	beforeEach: () => {
		applyInstanceListResponse({
			instances: [
				{
					...mockClaudeAccount,
					id: "Personal",
					name: "Personal",
					colorSlot: 0,
				},
				{
					...mockClaudeAccount,
					id: "Work",
					name: "Work",
					colorSlot: 1,
					isDefault: false,
				},
			],
		});
		const compact = sessionViewState.compact;
		sessionViewState.compact = window.innerWidth < 768;
		return () => {
			sessionViewState.compact = compact;
		};
	},
} satisfies Meta<typeof HandoffDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Review: Story = {
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement.ownerDocument.body).getByRole("dialog", {
				name: "What carried over?",
			}),
		).toBeVisible();
	},
};
export const ReviewLight: Story = { ...Review, globals: { theme: "light" } };
export const Confirm: Story = {
	args: {
		confirm: {
			from: "Personal",
			fromQuota: undefined,
			quota: undefined,
			cutOff: true,
			busy: false,
			onconfirm: fn(),
		},
	},
};
export const ConfirmLight: Story = { ...Confirm, globals: { theme: "light" } };

export const CodexNativeResume: Story = {
	args: {
		to: "Work Codex",
		summary: {
			continuationKind: "native-thread",
			included: 0,
			omitted: 0,
			firstMessageIncluded: false,
			tokens: 0,
		},
		confirm: {
			from: "Personal Codex",
			fromQuota: undefined,
			quota: undefined,
			cutOff: true,
			busy: false,
			onconfirm: fn(),
		},
	},
	play: async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByTestId(
			"handoff-dialog",
		);
		await expect(
			within(dialog).getByTestId("handoff-native-resume"),
		).toHaveTextContent("Codex resumes the same thread");
		await expect(
			within(dialog).getByTestId("handoff-carries"),
		).toHaveTextContent("Same Codex thread and conversation history");
		await expect(within(dialog).queryByTestId("handoff-drops")).toBeNull();
		await expect(dialog).not.toHaveTextContent("No earlier messages");
		await expect(dialog).not.toHaveTextContent("fresh session");
		await expect(
			within(dialog).getByTestId("handoff-native-fallback"),
		).toHaveTextContent(
			"If Work Codex can't open this thread, Conduit starts a new one with a condensed copy of the conversation so far.",
		);
	},
};

export const CodexContinuationReview: Story = {
	args: { to: "work-codex", summary: null },
	beforeEach: () => {
		const instances = instanceState.instances;
		instanceState.instances = [
			{
				id: "work-codex",
				name: "Work Codex",
				driver: "codex",
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 0,
			},
		];
		return () => {
			instanceState.instances = instances;
		};
	},
	play: async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByTestId(
			"handoff-dialog",
		);
		await expect(dialog).toHaveTextContent(
			"The conversation continued on Work Codex.",
		);
		await expect(dialog).not.toHaveTextContent("original thread");
		await expect(dialog).not.toHaveTextContent("condensed copy");
		await expect(dialog).not.toHaveTextContent("fresh session");
		await expect(dialog).not.toHaveTextContent("Nothing has gone across");
		await expect(
			within(dialog).queryByTestId("handoff-message-count"),
		).toBeNull();
	},
};

export const CodexNativeReview: Story = {
	...CodexContinuationReview,
	args: {
		to: "work-codex",
		summary: {
			continuationKind: "native-thread",
			included: 0,
			omitted: 0,
			firstMessageIncluded: false,
			tokens: 0,
		},
	},
	play: async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByTestId(
			"handoff-dialog",
		);
		await expect(dialog).toHaveTextContent(
			"The conversation continued on Work Codex in the same Codex thread, with its full history.",
		);
		await expect(dialog).not.toHaveTextContent("fresh session");
		await expect(dialog).not.toHaveTextContent("condensed copy");
	},
};

export const CodexDigestReview: Story = {
	...CodexContinuationReview,
	args: {
		to: "work-codex",
		summary: {
			continuationKind: "transcript-digest",
			included: 0,
			omitted: 0,
			firstMessageIncluded: false,
			tokens: 0,
		},
	},
	play: async ({ canvasElement }) => {
		const dialog = within(canvasElement.ownerDocument.body).getByTestId(
			"handoff-dialog",
		);
		await expect(dialog).toHaveTextContent(
			"Work Codex couldn't open the original Codex thread, so Conduit started a new one with a condensed copy of the conversation so far.",
		);
		await expect(dialog).not.toHaveTextContent("same Codex thread");
		await expect(dialog).not.toHaveTextContent("Nothing has gone across");
		await expect(dialog).not.toHaveTextContent("No earlier messages");
		await expect(
			within(dialog).getByTestId("handoff-carries"),
		).toHaveTextContent("A condensed copy of the conversation so far");
		await expect(
			within(dialog).queryByTestId("handoff-message-count"),
		).toBeNull();
		await expect(within(dialog).queryByTestId("handoff-drops")).toBeNull();
	},
};
