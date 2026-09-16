import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
	phaseToIdle,
	phaseToProcessing,
	resetChatState,
} from "../../stores/chat.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import {
	mockAssistantSimple,
	mockAssistantWithCode,
	mockConversation,
	mockResultFull,
	mockSystemInfo,
	mockThinkingDone,
	mockToolCompleted,
	mockToolRunning,
	mockUserMessage,
} from "../../stories/mocks.js";
import { turnFixtureMessages } from "../../stories/turn-fixtures.js";
import type { ChatMessage } from "../../types.js";
import MessageList from "./MessageList.svelte";

const testId = "story-msglist";

/**
 * Seed in one place: Storybook runs the most specific `beforeEach` first, so
 * a reset inherited from `meta` would wipe messages a story had already set.
 */
function seed(messages: ChatMessage[], processing = false) {
	resetChatState();
	sessionState.currentId = testId;
	const activity = getOrCreateSessionActivity(testId);
	getOrCreateSessionMessages(testId).messages = [...messages];
	if (processing) phaseToProcessing(activity);
	else phaseToIdle(activity);
}

const meta = {
	title: "Chat/MessageList",
	component: MessageList,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MessageList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { beforeEach: () => seed([]) };

export const SingleUserMessage: Story = {
	beforeEach: () => seed([mockUserMessage]),
};

export const SingleAssistantMessage: Story = {
	beforeEach: () => seed([mockAssistantSimple]),
};

export const FullConversation: Story = {
	beforeEach: () => seed(mockConversation),
};

export const MixedTypes: Story = {
	beforeEach: () =>
		seed([
			mockUserMessage,
			mockThinkingDone,
			mockToolCompleted,
			mockToolRunning,
			mockAssistantWithCode,
			mockResultFull,
			mockSystemInfo,
		]),
};

/** Three turns: a tool-less answer that keeps its result bar, then a long ledger. */
export const TurnLedger: Story = {
	beforeEach: () => seed(turnFixtureMessages),
};

/** Same transcript with the session still working — the last turn is live. */
export const TurnLedgerLive: Story = {
	beforeEach: () => seed(turnFixtureMessages, true),
};
