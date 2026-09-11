import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import {
	mockSession,
	mockSessionLongTitle,
	mockSessionProcessing,
} from "../../stories/mocks.js";
import SessionItemWithContextMenu from "./__fixtures__/SessionItemWithContextMenu.svelte";
import SessionItem from "./SessionItem.svelte";

const meta = {
	title: "Session/SessionItem",
	component: SessionItem,
	tags: ["autodocs"],
} satisfies Meta<typeof SessionItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inactive: Story = {
	args: {
		session: mockSession,
		active: false,
	},
};

export const Active: Story = {
	args: {
		session: mockSession,
		active: true,
	},
};

export const Processing: Story = {
	args: {
		session: mockSessionProcessing,
		active: true,
	},
};

export const LongTitle: Story = {
	args: {
		session: mockSessionLongTitle,
		active: false,
	},
};

export const WithContextMenu: Story = {
	// conduit-test-732b: SessionItem only emits a callback; the fixture renders its menu.
	render: (args) => ({ Component: SessionItemWithContextMenu, props: args }),
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByRole("button", { name: "More options" }),
		);
		const body = within(canvasElement.ownerDocument.body);
		await expect(
			await body.findByRole("button", { name: "Copy resume command" }),
			"More options must render the session context menu before capture",
		).toBeVisible();
	},
	args: {
		session: mockSession,
		active: false,
	},
};

export const Hover: Story = {
	...Inactive,
	parameters: { pseudo: { hover: true } },
};
