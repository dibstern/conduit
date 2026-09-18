import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
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
	args: {
		oncontextmenu: fn(),
		onrename: fn(),
	},
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
		// Regex, not an exact string: since conduit-test-de3.35.9.3 the name
		// carries the session title, because a screen reader hears this same
		// control once per row and "More options" alone identifies nothing.
		await userEvent.click(
			within(canvasElement).getByRole("button", { name: /^More options for / }),
		);
		const body = within(canvasElement.ownerDocument.body);
		await expect(
			// menuitem, not button: since conduit-test-de3.35.4 the menu is
			// ui/Menu + ui/MenuItem, which render real menu roles.
			await body.findByRole("menuitem", { name: "Copy resume command" }),
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

// The inline rename field had no baseline before conduit-test-de3.35.7, which
// is how it kept a bespoke recipe through three migration batches unnoticed.
export const Renaming: Story = {
	args: {
		session: mockSession,
		active: false,
		renaming: true,
	},
};

// Cleanup mode is the only state that renders the selection control, and it had
// no story at all -- which is how it kept a checkbox drawn entirely in glyphs,
// with no role and no checked state, through the whole migration
// (conduit-test-de3.35.9.3).
export const CleanupMode: Story = {
	args: {
		session: mockSession,
		active: false,
		cleanupMode: true,
	},
	play: async ({ canvasElement }) => {
		const box = within(canvasElement).getByRole("checkbox");
		await expect(box).toHaveAttribute("aria-checked", "false");
		await expect(box).toHaveAccessibleName(`Select ${mockSession.title}`);
	},
};

export const CleanupModeSelected: Story = {
	args: {
		session: mockSession,
		active: false,
		cleanupMode: true,
		selected: true,
	},
	play: async ({ canvasElement }) => {
		await expect(within(canvasElement).getByRole("checkbox")).toHaveAttribute(
			"aria-checked",
			"true",
		);
	},
};
