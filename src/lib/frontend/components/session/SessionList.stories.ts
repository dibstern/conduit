import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import {
	requestNewSession,
	resetSessionCreation,
	sessionState,
	setSearchQuery,
} from "../../stores/session.svelte.js";
import { mockSessionsAllGroups } from "../../stories/mocks.js";
import SessionList from "./SessionList.svelte";

function resetSessionState() {
	sessionState.rootSessions = [];
	sessionState.allSessions = [];
	sessionState.daemonSessions = [];
	sessionState.daemonUnavailableProjects = [];
	sessionState.searchResults = null;
	sessionState.currentId = null;
	sessionState.searchQuery = "";
	sessionState.daemonCursor = null;
	sessionState.daemonHasMore = false;
	sessionState.searchCursor = null;
	sessionState.searchHasMore = false;
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

export const Hover: Story = {
	...Empty,
	parameters: { pseudo: { hover: true } },
};

export const Loading: Story = {
	...Empty,
	beforeEach: () => {
		resetSessionCreation();
		requestNewSession();
		return resetSessionCreation;
	},
};

// Searching (above) seeds the query but never opens the field -- `searchVisible`
// is internal and only the toolbar button flips it, so the search box itself had
// no baseline at all before conduit-test-de3.35.7.
export const SearchOpen: Story = {
	beforeEach: () => {
		sessionState.rootSessions = [...mockSessionsAllGroups];
		sessionState.allSessions = [...mockSessionsAllGroups];
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole("button", { name: "Search sessions" }),
		);
		const search = await canvas.findByPlaceholderText("Search sessions...");
		// Opening search must land the caret in the field. This is the assertion,
		// not a setup step: the focus used to come from a `use:focusOnMount`
		// action, and an action cannot cross a component boundary.
		await expect(search).toHaveFocus();
	},
};
