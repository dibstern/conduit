import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { handleCommandList } from "../../stores/discovery.svelte.js";
import {
	mockUserMessage,
	mockUserMessageLong,
	mockUserMessageShort,
} from "../../stories/mocks.js";
import UserMessage from "./UserMessage.svelte";

const meta = {
	title: "Chat/UserMessage",
	component: UserMessage,
	tags: ["autodocs"],
} satisfies Meta<typeof UserMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { message: mockUserMessage },
};
export const DefaultLight: Story = { ...Default, globals: { theme: "light" } };

export const ShortText: Story = {
	args: { message: mockUserMessageShort },
};

export const LongText: Story = {
	args: { message: mockUserMessageLong },
};
export const LongTextLight: Story = {
	...LongText,
	globals: { theme: "light" },
};

export const NeutralStates: Story = {
	args: {
		message: {
			...mockUserMessage,
			steered: true,
			modelExecution: {
				requestedModel: "Opus",
				expectedModel: "Opus",
				actualModel: "Fable 5",
				drifted: true,
			},
		},
		onDismissCutOff: () => {},
	},
};
export const NeutralStatesLight: Story = {
	...NeutralStates,
	globals: { theme: "light" },
};

/** `/commit` is a known command and renders as a pill; `/comit` (a typo the
 *  composer would have underlined) and `/qwerty` stay plain once sent. */
export const WithSkills: Story = {
	beforeEach: () => {
		handleCommandList({
			commands: [
				{ name: "commit", description: "Create a git commit" },
				{ name: "code-review", description: "Review the current diff" },
			],
		});
	},
	args: {
		message: {
			type: "user",
			uuid: "msg-user-004",
			text: "run /commit then /comit and /qwerty",
		},
	},
};
