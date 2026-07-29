import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { sessionState } from "../../stores/session.svelte.js";
import {
	mockForkSession,
	mockSession,
	mockSubagentSession,
} from "../../stories/mocks.js";
import SubagentBackBar from "./SubagentBackBar.svelte";

const resetSessions = () => {
	sessionState.rootSessions = [];
	sessionState.allSessions = [];
	sessionState.currentId = null;
};

const meta = {
	title: "Chat/SubagentBackBar",
	component: SubagentBackBar,
	tags: ["autodocs"],
	beforeEach: resetSessions,
} satisfies Meta<typeof SubagentBackBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	beforeEach: () => {
		sessionState.rootSessions = [mockSession];
		sessionState.allSessions = [mockSession, mockSubagentSession];
		sessionState.currentId = mockSubagentSession.id;
	},
};

export const MissingParent: Story = {
	beforeEach: () => {
		sessionState.allSessions = [
			{
				...mockSubagentSession,
				id: "sess_story_missing_parent",
				parentID: "sess_story_unavailable_parent",
			},
		];
		sessionState.currentId = "sess_story_missing_parent";
	},
};
