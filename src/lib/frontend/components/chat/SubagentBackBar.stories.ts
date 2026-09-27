import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	clearSessionState,
	handleSessionFamily,
	handleSessionList,
	sessionState,
} from "../../stores/session.svelte.js";
import { mockSession, mockSubagentSession } from "../../stories/mocks.js";
import SubagentBackBar from "./SubagentBackBar.svelte";

const resetSessions = () => {
	clearSessionState();
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
		handleSessionList({
			type: "session_list",
			roots: true,
			sessions: [mockSession],
		});
		handleSessionFamily({
			type: "session_family",
			rootId: mockSession.id,
			sessions: [mockSession, mockSubagentSession],
		});
		sessionState.currentId = mockSubagentSession.id;
	},
};

export const MissingParent: Story = {
	beforeEach: () => {
		handleSessionFamily({
			type: "session_family",
			rootId: "sess_story_unavailable_parent",
			sessions: [
				{
					...mockSubagentSession,
					id: "sess_story_missing_parent",
					parentID: "sess_story_unavailable_parent",
				},
			],
		});
		sessionState.currentId = "sess_story_missing_parent";
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
