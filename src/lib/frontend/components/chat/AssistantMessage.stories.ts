import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	mockAssistantEmpty,
	mockAssistantMarkdown,
	mockAssistantSimple,
	mockAssistantStreaming,
	mockAssistantWithCode,
	mockAssistantWithMermaid,
	mockAssistantWithMultipleCodeBlocks,
} from "../../stories/mocks.js";
import AssistantMessage from "./AssistantMessage.svelte";

const meta = {
	title: "Chat/AssistantMessage",
	component: AssistantMessage,
	tags: ["autodocs"],
} satisfies Meta<typeof AssistantMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SimpleParagraph: Story = {
	args: { message: mockAssistantSimple },
};

export const WithCodeBlock: Story = {
	args: { message: mockAssistantWithCode },
};

export const MultipleCodeBlocks: Story = {
	args: { message: mockAssistantWithMultipleCodeBlocks },
};

export const Streaming: Story = {
	args: { message: mockAssistantStreaming },
};

export const WithMermaid: Story = {
	args: { message: mockAssistantWithMermaid },
};

export const RichMarkdown: Story = {
	args: { message: mockAssistantMarkdown },
};

export const Empty: Story = {
	args: { message: mockAssistantEmpty },
};
