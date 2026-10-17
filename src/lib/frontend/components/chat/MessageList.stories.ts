import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
	phaseToIdle,
	phaseToProcessing,
	resetChatState,
} from "../../stores/chat.svelte.js";
import { instanceState } from "../../stores/instance.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import {
	mockAssistantSimple,
	mockAssistantWithCode,
	mockClaudeAccount,
	mockConversation,
	mockResultFull,
	mockSession,
	mockSystemInfo,
	mockThinkingDone,
	mockToolCompleted,
	mockToolRunning,
	mockUserMessage,
} from "../../stories/mocks.js";
import { turnFixtureMessages } from "../../stories/turn-fixtures.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import type { ChatMessage } from "../../types.js";
import MessageList from "./MessageList.svelte";

const testId = "story-msglist";

/**
 * Seed in one place: Storybook runs the most specific `beforeEach` first, so
 * a reset inherited from `meta` would wipe messages a story had already set.
 */
let sequence = 0;

function seed(messages: ChatMessage[], processing = false) {
	resetChatState();
	sessionState.currentId = testId;
	// The reply header names the provider of the viewed session's account.
	instanceState.instances = [mockClaudeAccount];
	applySessionChange({
		_tag: "snapshot",
		rows: [
			{
				...mockSession,
				id: testId,
				accountId: mockClaudeAccount.id,
				status: processing ? "busy" : "idle",
			},
		],
		sequence: ++sequence,
	});
	const activity = getOrCreateSessionActivity(testId);
	const chat = getOrCreateSessionMessages(testId);
	chat.messages = [...messages];
	chat.loadLifecycle = "ready";
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

export const TurnLedgerLight: Story = {
	...TurnLedger,
	globals: { theme: "light" },
};
export const TurnLedgerLiveLight: Story = {
	...TurnLedgerLive,
	globals: { theme: "light" },
};

export const BusyEmpty: Story = {
	beforeEach: () => seed([], true),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("turn-live-head")).toHaveTextContent(
			"Working",
		);
		await expect(canvas.getByTestId("turn-live-elapsed")).toHaveTextContent(
			"(no prompt to time from)",
		);
		await expect(
			canvas.queryByTestId("composer-status-header"),
		).not.toBeInTheDocument();
	},
};
export const BusyEmptyLight: Story = {
	...BusyEmpty,
	globals: { theme: "light" },
};

export const AdjacentReplies: Story = {
	beforeEach: () =>
		seed([
			mockUserMessage,
			mockToolCompleted,
			{
				...mockAssistantSimple,
				uuid: "adjacent-first",
				messageId: "adjacent-first",
			},
			{
				...mockAssistantWithCode,
				uuid: "adjacent-next",
				messageId: "adjacent-next",
			},
			mockResultFull,
		]),
	play: async ({ canvasElement }) => {
		for (const id of ["adjacent-first", "adjacent-next"]) {
			const headers = canvasElement.querySelectorAll(
				`.assistant-header[data-message-id="${id}"]`,
			);
			await expect(headers).toHaveLength(1);
			const header = headers[0];
			if (!(header instanceof HTMLElement))
				throw new Error(`Reply header ${id} is missing`);
			await expect(
				within(header).getByRole("button", {
					name: "Copy message",
				}),
			).toBeInTheDocument();
			await expect(
				within(header).getByRole("button", {
					name: "Fork from here",
				}),
			).toBeInTheDocument();
		}
	},
};
export const AdjacentRepliesLight: Story = {
	...AdjacentReplies,
	globals: { theme: "light" },
};

function liveTranscript(phone = false) {
	const root = document.getElementById("storybook-root");
	const style = root?.getAttribute("style");
	root?.setAttribute(
		"style",
		`display:flex;height:640px;width:${phone ? "393px" : "100%"};max-width:100%;overflow:hidden`,
	);
	seed(
		[
			...turnFixtureMessages,
			...turnFixtureMessages.map((message) => ({
				...message,
				uuid: `older-${message.uuid}`,
			})),
			{
				...mockUserMessage,
				uuid: "live-user",
				text: "Check the remaining cases",
				turnTiming: { startedAt: Date.now() - 65_000, waits: [] },
			},
			{ ...mockThinkingDone, uuid: "live-thinking", done: false },
		],
		true,
	);
	return () => {
		if (style === null || style === undefined) root?.removeAttribute("style");
		else root?.setAttribute("style", style);
	};
}

export const LiveTurnVisible: Story = {
	beforeEach: () => liveTranscript(),
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByTestId("turn-live-head"),
		).toBeVisible();
		await expect(
			within(canvasElement).queryByTestId("jump-to-live"),
		).not.toBeVisible();
	},
};
export const LiveTurnVisibleLight: Story = {
	...LiveTurnVisible,
	globals: { theme: "light" },
};

export const JumpToLive: Story = {
	tags: ["viewport-capture"],
	beforeEach: () => liveTranscript(),
	play: async ({ canvasElement }) => {
		const transcript = canvasElement.querySelector("#messages");
		if (!(transcript instanceof HTMLElement))
			throw new Error("Transcript is missing");
		await waitFor(() => expect(transcript.scrollTop).toBeGreaterThan(0));
		// Scroll events that land while the transcript is still settling count as
		// its own follow scrolls, so read the way a reader would: until it detaches.
		await waitFor(() => {
			transcript.scrollTop = 0;
			transcript.dispatchEvent(new Event("scroll"));
			expect(within(canvasElement).getByTestId("jump-to-live")).toBeVisible();
		});
	},
};
export const JumpToLiveLight: Story = {
	...JumpToLive,
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const JumpToLivePhone: Story = {
	...JumpToLive,
	parameters: { phone: true },
	beforeEach: () => liveTranscript(true),
};
export const JumpToLivePhoneLight: Story = {
	...JumpToLivePhone,
	globals: { theme: "light" },
};

export const FollowLive: Story = {
	...JumpToLive,
	play: async (context) => {
		await JumpToLive.play?.(context);
		await userEvent.click(
			within(context.canvasElement).getByTestId("jump-to-live"),
		);
		await expect(
			within(context.canvasElement).queryByTestId("jump-to-live"),
		).not.toBeVisible();
	},
};
export const FollowLiveLight: Story = {
	...FollowLive,
	globals: { theme: "light" },
};
