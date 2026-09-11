import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import NotifSettings from "./NotifSettings.svelte";

/**
 * Pins `Notification.permission`, which the component samples once at init.
 *
 * Not optional, and not only for the blocked story: headless Chromium reports
 * "denied" by default, so before this every NotifSettings baseline was the
 * blocked state — including Open's. PushBlocked's baseline was therefore
 * byte-identical to Open's, and stubbing only PushBlocked would have changed
 * nothing at all, because it was already getting the value it asked for from the
 * browser. See conduit-test-732b.
 */
function stubNotificationPermission(value: NotificationPermission): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(
		Notification,
		"permission",
	);
	Object.defineProperty(Notification, "permission", {
		configurable: true,
		get: () => value,
	});
	return () => {
		if (descriptor)
			Object.defineProperty(Notification, "permission", descriptor);
		else Reflect.deleteProperty(Notification, "permission");
	};
}

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
		return stubNotificationPermission("granted");
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
	// The counterpart to PushBlocked's assertion, and the reason this story is a
	// story: without it, "default settings" silently meant "whatever permission
	// the browser happened to report", which in headless Chromium is denied.
	play: ({ canvasElement }) => {
		expect(
			canvasElement.querySelector(".notif-blocked"),
			"Open must show no blocked or unavailable hint; if it does, this baseline is a duplicate of PushBlocked's",
		).toBeNull();
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
	// The story-level beforeEach runs after the meta-level one, so this overrides
	// the "granted" default. conduit-test-732b.
	beforeEach: () => {
		if (!("serviceWorker" in navigator) || !window.isSecureContext) {
			throw new Error(
				"PushBlocked needs a secure context with a service worker: pushUnavailable takes precedence over the blocked hint, and this story would capture the wrong message",
			);
		}
		return stubNotificationPermission("denied");
	},
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByText(
				/Push notifications are blocked by your browser/,
			),
			"PushBlocked must show the blocked hint, not the push-unavailable hint",
		).toBeVisible();
	},
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
