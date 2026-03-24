import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { sessionState, setSearchQuery } from "../../stores/session.svelte.js";
import { mockSessionsAllGroups } from "../../stories/mocks.js";
import SessionList from "./SessionList.svelte";

function resetSessionState() {
	sessionState.rootSessions = [];
	sessionState.allSessions = [];
	sessionState.searchResults = null;
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	sessionState.hasMore = false;
}

const meta = {
	title: "Session/SessionList",
	component: SessionList,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	beforeEach: () => {
		resetSessionState();
	},
} satisfies Meta<typeof SessionList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithItems: Story = {
	beforeEach: () => {
		sessionState.rootSessions = [...mockSessionsAllGroups];
		sessionState.allSessions = [...mockSessionsAllGroups];
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		sessionState.currentId = mockSessionsAllGroups[0]!.id;
	},
};

export const Searching: Story = {
	beforeEach: () => {
		sessionState.rootSessions = [...mockSessionsAllGroups];
		sessionState.allSessions = [...mockSessionsAllGroups];
		setSearchQuery("dark");
	},
};
