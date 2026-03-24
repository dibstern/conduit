import type { Meta, StoryObj } from "@storybook/svelte-vite";
import NotifSettings from "./NotifSettings.svelte";

const meta = {
	title: "Overlays/NotifSettings",
	component: NotifSettings,
	tags: ["autodocs"],
	parameters: {
		// Dropdown uses fixed positioning; needs own iframe viewport.
		docs: { story: { inline: false, height: "300px" } },
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
	play: () => {
		// Set all toggles on via localStorage before render
		localStorage.setItem(
			"notif-settings",
			JSON.stringify({ push: true, browser: true, sound: true }),
		);
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
