import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { chatState, resetChatState } from "../../stores/chat.svelte.js";
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

const meta = {
	title: "Chat/MessageList",
	component: MessageList,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		resetChatState();
	},
} satisfies Meta<typeof MessageList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const SingleUserMessage: Story = {
	beforeEach: () => {
		chatState.messages = [mockUserMessage];
	},
};

export const SingleAssistantMessage: Story = {
	beforeEach: () => {
		chatState.messages = [mockAssistantSimple];
	},
};

export const FullConversation: Story = {
	beforeEach: () => {
		chatState.messages = [...mockConversation];
	},
};

export const MixedTypes: Story = {
	beforeEach: () => {
		chatState.messages = [
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
