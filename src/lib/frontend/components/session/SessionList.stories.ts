import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	applySessionSnapshot,
	clearSessionState,
	sessionState,
	setSearchQuery,
} from "../../stores/session.svelte.js";
import { mockSessionsAllGroups } from "../../stories/mocks.js";
import SessionList from "./SessionList.svelte";

const meta = {
	title: "Session/SessionList",
	component: SessionList,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	beforeEach: () => {
		clearSessionState();
	},
} satisfies Meta<typeof SessionList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithItems: Story = {
	beforeEach: () => {
		applySessionSnapshot(mockSessionsAllGroups, "complete");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		sessionState.currentId = mockSessionsAllGroups[0]!.id;
	},
};

export const Searching: Story = {
	beforeEach: () => {
		applySessionSnapshot(mockSessionsAllGroups, "complete");
		setSearchQuery("dark");
	},
};
