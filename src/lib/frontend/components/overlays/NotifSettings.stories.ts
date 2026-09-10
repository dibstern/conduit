import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import NotifSettings from "./NotifSettings.svelte";

const meta = {
	title: "Overlays/NotifSettings",
	component: NotifSettings,
	tags: ["autodocs"],
	parameters: {
		// Dropdown uses fixed positioning; needs own iframe viewport.
		docs: { story: { inline: false, height: "300px" } },
	},
	// The component reads localStorage at init, so seeded state must be written
	// before render and cleared between stories or it leaks across the file.
	beforeEach: () => {
		localStorage.removeItem("notif-settings");
	},
} satisfies Meta<typeof NotifSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Menu visible with default settings. */
export const Open: Story = {
	args: {
		visible: true,
		onClose: () => console.log("NotifSettings closed"),
	},
};

/** All three toggles enabled. */
export const AllEnabled: Story = {
	args: {
		visible: true,
		onClose: () => console.log("NotifSettings closed"),
	},
	beforeEach: () => {
		localStorage.setItem(
			"notif-settings",
			JSON.stringify({ push: true, browser: true, sound: true }),
		);
	},
	play: async ({ canvasElement }) => {
		const switches = await within(canvasElement).findAllByRole("switch");
		expect(switches).toHaveLength(3);
		for (const toggle of switches) {
			expect(toggle).toHaveAttribute("aria-checked", "true");
		}
	},
};

/** Push denied — showing blocked hint. */
export const PushBlocked: Story = {
	args: {
		visible: true,
		onClose: () => console.log("NotifSettings closed"),
	},
};

/** Menu hidden — nothing visible. */
export const Closed: Story = {
	args: {
		visible: false,
	},
};
