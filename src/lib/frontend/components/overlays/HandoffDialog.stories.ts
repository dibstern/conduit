import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, within } from "storybook/test";
import { sessionViewState } from "../../stores/session-view.svelte.js";
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
