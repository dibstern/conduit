import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	clearSessionState,
	handleSessionFamily,
	handleSessionList,
	sessionState,
} from "../../stores/session.svelte.js";
import { mockSession, mockSubagentSession } from "../../stories/mocks.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import type { SessionInfo } from "../../types.js";
import SubagentBackBar from "./SubagentBackBar.svelte";

let sequence = 0;

type Row = Pick<SessionInfo, "id" | "title"> & Partial<SessionInfo>;

function seedSessions(rows: readonly Row[]): void {
	const sessions: SessionInfo[] = rows.map((row) => ({
		status: "idle",
		...row,
	}));
	handleSessionList({ type: "session_list", roots: true, sessions });
	handleSessionFamily({ type: "session_family", rootId: "", sessions });
	applySessionChange({
		_tag: "snapshot",
		rows: sessions,
		sequence: ++sequence,
	});
	applySessionChange({ _tag: "synchronized" });
}

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
		seedSessions([mockSession, mockSubagentSession]);
		sessionState.currentId = mockSubagentSession.id;
	},
};

export const MissingParent: Story = {
	beforeEach: () => {
		seedSessions([
			{
				...mockSubagentSession,
				id: "sess_story_missing_parent",
				parentID: "sess_story_unavailable_parent",
			},
		]);
		sessionState.currentId = "sess_story_missing_parent";
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
