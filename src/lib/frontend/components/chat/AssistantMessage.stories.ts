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
import { renderMarkdown } from "../../utils/markdown.js";
import AssistantMessage from "./AssistantMessage.svelte";

const meta = {
	title: "Chat/AssistantMessage",
	component: AssistantMessage,
	tags: ["autodocs"],
	args: { providerId: "claude" },
} satisfies Meta<typeof AssistantMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SimpleParagraph: Story = {
	args: { message: mockAssistantSimple, model: "Sonnet 5" },
};
export const SimpleParagraphLight: Story = {
	...SimpleParagraph,
	globals: { theme: "light" },
};

export const WithCodeBlock: Story = {
	args: { message: mockAssistantWithCode },
};
export const WithCodeBlockLight: Story = {
	...WithCodeBlock,
	globals: { theme: "light" },
};

const fileDiff =
	"```diff\n--- a/src/lib/frontend/stores/unread.ts\n+++ b/src/lib/frontend/stores/unread.ts\n@@ -1,2 +1,3 @@\n-const unread = 0;\n+const unread = new Map<string, number>();\n+export { unread };\n```";
export const FileDiff: Story = {
	args: {
		model: "Sonnet 5",
		message: {
			...mockAssistantSimple,
			rawText: fileDiff,
			html: renderMarkdown(fileDiff),
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			await canvas.findByText("src/lib/frontend/stores/unread.ts"),
		).toBeVisible();
		await expect(canvas.getByText("+2")).toBeVisible();
		await expect(canvas.getByText("−1")).toBeVisible();
		await expect(
			canvas.getByRole("button", { name: "Copy code" }),
		).toBeVisible();
	},
};
export const FileDiffLight: Story = {
	...FileDiff,
	globals: { theme: "light" },
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
export const RichMarkdownLight: Story = {
	...RichMarkdown,
	globals: { theme: "light" },
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
	// Drive the body twice and suppress its reset so success survives capture.
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
	tags: ["visual-pointer-hover"],
};

export const ReplyWithoutHeader: Story = {
	...CopyInteraction,
	args: { message: mockAssistantMarkdown, hideHeader: true },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = canvas.getByText("Here are the key findings:");
		await userEvent.click(body);
		await expect(canvas.getByRole("status")).toHaveTextContent(
			"Click again to copy",
		);
		await userEvent.click(body);
		await expect(canvas.getByRole("status")).toHaveTextContent("Copied!");
	},
};
export const ReplyWithoutHeaderLight: Story = {
	...ReplyWithoutHeader,
	globals: { theme: "light" },
};
