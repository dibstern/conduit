import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import type { ListDaemonSessionsResponse } from "../../../contracts/ws-rpc.js";
import { projectState } from "../../stores/project.svelte.js";
import { attachedProjectState } from "../../stores/router.svelte.js";
import type { listDaemonSessionsRpc } from "../../transport/ws-rpc-client.js";
import DeepSearch from "./DeepSearch.svelte";

const now = Date.now();
const sessions: ListDaemonSessionsResponse["sessions"] = [
	{
		id: "story-live",
		status: "idle",
		title: "Review the release",
		projectSlug: "conduit",
		updatedAt: now - 120_000,
	},
	{
		id: "story-settled",
		status: "idle",
		title: "Archive old notes",
		projectSlug: "conduit",
		updatedAt: now - 3_600_000,
		settledAt: now - 1_800_000,
	},
	{
		id: "story-snoozed",
		status: "idle",
		title: "Resume design work",
		projectSlug: "gym",
		updatedAt: now - 7_200_000,
		snoozedAt: now - 60_000,
		// Fixed date: a clock-relative snooze time would change the baseline every run.
		snoozedUntil: new Date(2030, 9, 8, 9).getTime(),
	},
];

const search: typeof listDaemonSessionsRpc = async (input) => ({
	sessions: sessions.filter(
		(session) =>
			!input.search ||
			session.title.toLowerCase().includes(input.search.toLowerCase()),
	),
	availability: [],
	hasMore: false,
	nextCursor: null,
});

const meta = {
	title: "Session/DeepSearch",
	component: DeepSearch,
	tags: ["autodocs", "viewport-capture"],
	args: { search },
	beforeEach: () => {
		attachedProjectState.slug = "conduit";
		projectState.projects = [
			{
				slug: "conduit",
				title: "Conduit",
				directory: "/conduit",
				clientCount: 1,
			},
			{ slug: "gym", title: "Gym", directory: "/gym", clientCount: 1 },
		];
		return () => {
			attachedProjectState.slug = null;
			projectState.projects = [];
		};
	},
} satisfies Meta<typeof DeepSearch>;

export default meta;
type Story = StoryObj<typeof meta>;

async function openSearch() {
	await fireEvent.keyDown(window, { key: "k", metaKey: true });
	const canvas = within(document.body);
	await expect(canvas.getByTestId("deep-search-input")).toBeVisible();
	return canvas;
}

export const Recent: Story = {
	play: async () => {
		const canvas = await openSearch();
		await expect(canvas.getByText("Recent")).toBeVisible();
		await expect(canvas.getAllByTestId("deep-search-result")).toHaveLength(3);
	},
};

export const ShelfResults: Story = {
	play: async () => {
		const canvas = await openSearch();
		await userEvent.type(canvas.getByTestId("deep-search-input"), "e");
		await waitFor(() =>
			expect(canvas.getAllByTestId("deep-search-result")).toHaveLength(3),
		);
		await expect(
			canvas.getByRole("option", {
				name: /Archive old notes, Conduit, Settled/,
			}),
		).toBeVisible();
		await expect(
			canvas.getByRole("option", { name: /Resume design work, Gym, Snoozed/ }),
		).toBeVisible();
	},
};

export const NoMatch: Story = {
	play: async () => {
		const canvas = await openSearch();
		await userEvent.type(
			canvas.getByTestId("deep-search-input"),
			"nothing-matches",
		);
		await waitFor(() =>
			expect(
				canvas.getByText("No sessions match “nothing-matches”"),
			).toBeVisible(),
		);
	},
};
