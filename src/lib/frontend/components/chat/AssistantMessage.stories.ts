import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
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

/**
 * Demonstrates the copy-on-click interaction on a finalized message.
 * Click once on the message body (not on code blocks) to prime, then click again to copy.
 * Verify the background highlight stays within the card's rounded edges.
 */
export const CopyInteraction: Story = {
	args: { message: mockAssistantMarkdown },
	// conduit-test-732b: drive the body twice and suppress its reset so success survives capture.
	beforeEach: () => {
		const original = window.setTimeout;
		Object.defineProperty(window, "setTimeout", {
			configurable: true,
			writable: true,
			value: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
				// This story's copy resets are the 3000 ms timers; leave other timers running.
				if (timeout === 3000)
					return Reflect.apply(original, window, [() => {}, 0]);
				return Reflect.apply(original, window, [handler, timeout, ...args]);
			},
		});
		return () => {
			window.setTimeout = original;
		};
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const bodyText = canvas.getByText("Here are the key findings:");
		// The action bar is `opacity-0 group-hover:opacity-100` with a 150ms
		// transition, so asserting visibility on the frame after the click reads
		// the interpolated opacity and fails. waitFor lets the transition land.
		await userEvent.click(bodyText);
		await waitFor(() =>
			expect(
				canvas.getByRole("button", { name: "Click to confirm copy" }),
				"The first body click must prime copy exactly once",
			).toBeVisible(),
		);
		await userEvent.click(bodyText);
		await waitFor(() =>
			expect(
				canvas.getByRole("button", { name: "Copied!" }),
				"The second body click must render copy success",
			).toBeVisible(),
		);
		// Not belt-and-braces: without the stub above this is the assertion that
		// fails, and it is the one that matters, because the screenshot is taken
		// after play() returns. A story that asserts a state and then lets it
		// expire before capture is the exact bug this ticket is about.
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 3100);
		});
		expect(
			canvas.getByRole("button", { name: "Copied!" }),
			"Copy success must outlive the 3000ms reset, or the captured frame is the idle state",
		).toBeVisible();
	},
};

export const Hover: Story = {
	...SimpleParagraph,
	parameters: { pseudo: { hover: true } },
};
