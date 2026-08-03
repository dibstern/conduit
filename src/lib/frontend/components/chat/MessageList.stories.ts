import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	getOrCreateSessionSlot,
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
import MessageList from "./MessageList.svelte";

const testId = "story-msglist";

const meta = {
	title: "Chat/MessageList",
	component: MessageList,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		resetChatState();
		sessionState.currentId = testId;
	},
} satisfies Meta<typeof MessageList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const SingleUserMessage: Story = {
	beforeEach: () => {
		getOrCreateSessionSlot(testId).messages.messages = [mockUserMessage];
	},
};

export const SingleAssistantMessage: Story = {
	beforeEach: () => {
		getOrCreateSessionSlot(testId).messages.messages = [mockAssistantSimple];
	},
};

export const FullConversation: Story = {
	beforeEach: () => {
		getOrCreateSessionSlot(testId).messages.messages = [...mockConversation];
	},
};

export const MixedTypes: Story = {
	beforeEach: () => {
		getOrCreateSessionSlot(testId).messages.messages = [
			mockUserMessage,
			mockThinkingDone,
			mockToolCompleted,
			mockToolRunning,
			mockAssistantWithCode,
			mockResultFull,
			mockSystemInfo,
		];
	},
};
