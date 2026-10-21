import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ListArchivedSessionsResponse } from "../../../contracts/ws-rpc.js";
import { projectState } from "../../stores/project.svelte.js";
import type { rpc } from "../../transport/ws-rpc-client.js";
import ArchivedSettingsTab from "./ArchivedSettingsTab.svelte";

const now = Date.now();
const sessions: ListArchivedSessionsResponse["sessions"] = [
	{
		id: "archived-conduit",
		title: "Review the session archive",
		projectSlug: "conduit",
		accountId: null,
		status: "idle",
		archivedAt: now - 60_000,
		updatedAt: now - 3_600_000,
	},
	{
		id: "archived-gym",
		title: "Plan the next training block",
		projectSlug: "gym",
		accountId: null,
		status: "idle",
		archivedAt: now - 120_000,
		updatedAt: now - 86_400_000,
	},
	{
		id: "archived-notes",
		title: "Older design notes",
		projectSlug: "conduit",
		accountId: null,
		status: "idle",
		archivedAt: now - 180_000,
		updatedAt: now - 172_800_000,
	},
];
const load: typeof rpc<"ListArchivedSessions"> = async () => ({
	sessions,
	availability: [],
	hasMore: false,
	nextCursor: null,
});

const meta = {
	title: "Overlays/ArchivedSettingsTab",
	component: ArchivedSettingsTab,
	tags: ["autodocs"],
	args: { load },
	beforeEach: () => {
		projectState.projects = [
			{
				slug: "conduit",
				title: "Conduit",
				folders: ["/conduit"],
				clientCount: 1,
			},
			{ slug: "gym", title: "Gym", folders: ["/gym"], clientCount: 1 },
		];
		return () => {
			projectState.projects = [];
		};
	},
} satisfies Meta<typeof ArchivedSettingsTab>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TwoProjects: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			await canvas.findAllByTestId("archived-project-group"),
		).toHaveLength(2);
		await expect(canvas.getAllByTestId("archived-session-row")).toHaveLength(3);
	},
};

export const Empty: Story = {
	args: {
		load: async () => ({
			sessions: [],
			availability: [],
			hasMore: false,
			nextCursor: null,
		}),
	},
	play: async ({ canvasElement }) => {
		await expect(
			await within(canvasElement).findByTestId("archived-empty"),
		).toHaveTextContent("No archived sessions");
	},
};

export const HasMore: Story = {
	args: {
		load: (async (_tag, input) => ({
			sessions: input.cursor ? sessions.slice(2) : sessions.slice(0, 2),
			availability: [],
			hasMore: true,
			nextCursor: input.cursor
				? { archivedAt: now - 180_000, id: "archived-notes" }
				: { archivedAt: now - 120_000, id: "archived-gym" },
		})) satisfies typeof rpc<"ListArchivedSessions">,
	},
	// The second page appends and still offers more, so the final frame keeps
	// the button and differs from TwoProjects.
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByTestId("archived-show-more"));
		await expect(await canvas.findByText("Older design notes")).toBeVisible();
		await expect(canvas.getAllByTestId("archived-session-row")).toHaveLength(3);
		await expect(canvas.getByTestId("archived-show-more")).toBeEnabled();
	},
};
