import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import DraftItem from "./DraftItem.svelte";

const now = Date.UTC(2030, 9, 19, 12);
const meta = {
	title: "Session/DraftItem",
	component: DraftItem,
	tags: ["autodocs"],
	args: {
		draft: {
			draftId: "draft-preview",
			projectSlug: "conduit",
			firstLine: "Plan the next release",
			updatedAt: now - 120_000,
			imageCount: 0,
			fileCount: 0,
		},
		href: "/draft/draft-preview?project=conduit",
		projectLabel: "Conduit",
		projectAccent: 1,
		now,
		onopen: fn(),
		ondiscard: fn(),
	},
} satisfies Meta<typeof DraftItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OneLine: Story = {};

export const LongText: Story = {
	args: {
		draft: {
			...meta.args.draft,
			firstLine:
				"Investigate how the daemon restores drafts across multiple devices while keeping the composer responsive throughout a long, uninterrupted typing session",
		},
		projectLabel: "Conduit feature checkout",
		projectAccent: 3,
	},
};
