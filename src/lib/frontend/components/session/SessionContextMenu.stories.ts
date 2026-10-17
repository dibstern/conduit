import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { showToast } from "../../stores/ui.svelte.js";
import { mockSession, mockSessionLongTitle } from "../../stories/mocks.js";
import type { SessionInfo } from "../../types.js";
import SessionContextMenuHarness from "./__fixtures__/SessionContextMenuHarness.svelte";

const meta = {
	title: "Session/SessionContextMenu",
	component: SessionContextMenuHarness,
	// viewport-capture: the menu portals to <body>, outside #storybook-root.
	tags: ["autodocs", "viewport-capture"],
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "340px" } },
	},
	args: { session: mockSession },
	play: async () => {
		const menu = await within(document.body).findByRole("menu", {
			name: "Session actions",
		});
		await expect(within(menu).getByTestId("session-ctx-rename")).toBeVisible();
	},
} satisfies Meta<typeof SessionContextMenuHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Pinned: Story = {
	args: { session: { ...mockSession, pinnedAt: 1 } },
	play: async () => {
		const menu = await within(document.body).findByRole("menu", {
			name: "Session actions",
		});
		await expect(
			within(menu).getByTestId("session-ctx-unpin"),
		).toHaveTextContent("Unpin");
		await expect(
			within(menu).queryByTestId("session-ctx-pin"),
		).not.toBeInTheDocument();
	},
};

export const PinnedLight: Story = { ...Pinned, globals: { theme: "light" } };

export const LongHeader: Story = {
	name: "Long title header",
	args: {
		session: mockSessionLongTitle,
		projectLabel: "Conduit",
		branch: "fix/reconnect-double-subscribe",
	},
};

export const PhoneSheet: Story = {
	args: {
		session: mockSessionLongTitle,
		projectLabel: "Conduit",
		branch: "main",
		presentation: "sheet",
	},
	parameters: { viewport: { defaultViewport: "mobile1" } },
};

const sheetNow = Date.UTC(2026, 9, 16, 12);
function phoneSheet(state: Partial<SessionInfo> = {}): Story {
	return {
		args: {
			presentation: "sheet",
			selectable: true,
			projectLabel: "Conduit",
			branch: "feat/typed-session-list",
			now: sheetNow,
			session: { ...mockSession, updatedAt: sheetNow - 720_000, ...state },
		},
		parameters: { viewport: { defaultViewport: "mobile1" } },
		play: async () => {
			const menu = await within(document.body).findByTestId(
				"session-action-sheet",
			);
			await expect(
				within(menu).getByTestId("session-sheet-header"),
			).toBeVisible();
			await expect(
				within(menu).getByTestId("session-sheet-close"),
			).toBeVisible();
			await expect(
				within(menu).getByRole("group", { name: "Triage" }),
			).toBeVisible();
			const group = within(menu).getByRole("group", {
				name: "Session",
			});
			const tiles = within(group).getAllByRole("menuitem");
			await expect(tiles).toHaveLength(5);
			expect(
				new Set(tiles.map((tile) => tile.getBoundingClientRect().top)).size,
			).toBe(1);
			await expect(
				within(menu).getByTestId("session-ctx-auto-settle"),
			).toHaveAttribute(
				"aria-checked",
				state.autoSettleDisabled ? "false" : "true",
			);
			expect(menu.querySelector("[data-sheet-footer]")).toBeNull();
		},
	};
}

export const PhoneDefault: Story = phoneSheet();
export const PhoneDefaultLight: Story = {
	...PhoneDefault,
	globals: { theme: "light" },
};
export const PhoneUnknownBranch: Story = {
	...PhoneDefault,
	args: { ...PhoneDefault.args, branch: "" },
	play: async () => {
		const menu = await within(document.body).findByTestId(
			"session-action-sheet",
		);
		await expect(
			within(menu).getByTestId("session-sheet-header"),
		).toHaveTextContent(mockSession.title);
		expect(within(menu).queryByTestId("session-sheet-branch")).toBeNull();
	},
};
export const PhoneUnknownBranchLight: Story = {
	...PhoneUnknownBranch,
	globals: { theme: "light" },
};
export const PhoneCloseReturnsFocus: Story = {
	...PhoneDefault,
	play: async () => {
		const menu = await within(document.body).findByTestId(
			"session-action-sheet",
		);
		await userEvent.click(within(menu).getByTestId("session-sheet-close"));
		await waitFor(() =>
			expect(
				within(document.body).queryByTestId("session-action-sheet"),
			).not.toBeInTheDocument(),
		);
		await waitFor(() =>
			expect(
				within(document.body).getByRole("button", { name: "Session actions" }),
			).toHaveFocus(),
		);
	},
};
export const PhoneUnread: Story = phoneSheet({ unread: true });
export const PhoneUnreadLight: Story = {
	...PhoneUnread,
	globals: { theme: "light" },
};
export const PhoneSnoozed: Story = phoneSheet({
	snoozedAt: sheetNow - 60_000,
	snoozedUntil: sheetNow + 21_600_000,
});
export const PhoneSnoozedLight: Story = {
	...PhoneSnoozed,
	globals: { theme: "light" },
};
export const PhoneSnoozedIndefinitely: Story = phoneSheet({
	snoozedAt: sheetNow - 60_000,
});
export const PhoneSnoozedIndefinitelyLight: Story = {
	...PhoneSnoozedIndefinitely,
	globals: { theme: "light" },
};
export const PhonePinned: Story = phoneSheet({ pinnedAt: sheetNow - 60_000 });
export const PhonePinnedLight: Story = {
	...PhonePinned,
	globals: { theme: "light" },
};
export const PhoneSettled: Story = phoneSheet({ settledAt: sheetNow - 60_000 });
export const PhoneSettledLight: Story = {
	...PhoneSettled,
	globals: { theme: "light" },
};
export const PhoneAutoSettleOff: Story = phoneSheet({
	autoSettleDisabled: true,
});
export const PhoneAutoSettleOffLight: Story = {
	...PhoneAutoSettleOff,
	globals: { theme: "light" },
};

export const PhoneWithFooter: Story = {
	...PhoneDefault,
	args: { ...PhoneDefault.args, selectable: false, withFooter: true },
	play: async () => {
		const menu = await within(document.body).findByTestId(
			"session-action-sheet",
		);
		await expect(within(menu).getByTestId("session-title-share")).toBeVisible();
		await expect(
			within(menu).getByTestId("session-title-settings"),
		).toBeVisible();
		expect(within(menu).queryByTestId("session-title-debug")).toBeNull();
		await expect(
			within(menu)
				.getByRole("group", { name: "Session" })
				.querySelectorAll("[data-menu-tile]"),
		).toHaveLength(4);
	},
};
export const PhoneWithFooterLight: Story = {
	...PhoneWithFooter,
	globals: { theme: "light" },
};
export const PhoneDebugFooter: Story = {
	...PhoneWithFooter,
	args: { ...PhoneWithFooter.args, debug: true },
	play: async () => {
		const debug = await within(document.body).findByTestId(
			"session-title-debug",
		);
		await expect(debug).toHaveAccessibleName("Debug panel");
		await expect(debug).toHaveTextContent(/Debug\s*dev/);
	},
};
export const PhoneDebugFooterLight: Story = {
	...PhoneDebugFooter,
	globals: { theme: "light" },
};
export const PhoneDisabledReason: Story = {
	...PhonePinned,
	play: async () => {
		const menu = await within(document.body).findByTestId(
			"session-action-sheet",
		);
		const snooze = within(menu).getByTestId("session-ctx-snooze");
		await expect(snooze).toHaveAttribute("aria-disabled", "true");
		await userEvent.click(snooze);
		await expect(menu).toBeVisible();
		await expect(
			within(menu).getByTestId("session-sheet-toast"),
		).toHaveTextContent("Unpin to snooze");
		await userEvent.keyboard("{ArrowDown}");
		await expect(within(menu).getByTestId("session-ctx-unpin")).toHaveFocus();
	},
};
export const PhoneDisabledReasonLight: Story = {
	...PhoneDisabledReason,
	globals: { theme: "light" },
};

export const PhoneNotifications: Story = {
	...PhoneDefault,
	args: {
		...PhoneDefault.args,
		initialToasts: [
			{
				title: "Moved Alpha to Settled",
				duration: 60_000,
				actions: [{ kind: "primary", label: "Undo", run: () => {} }],
			},
		],
	},
	play: async () => {
		const menu = await within(document.body).findByTestId(
			"session-action-sheet",
		);
		await expect(
			within(menu).getByRole("menuitem", { name: "Undo" }),
		).toBeVisible();
		showToast({
			title: "Error",
			body: "Beta failed because its account is unavailable.",
			emphasis: "Beta",
			variant: "error",
			duration: 60_000,
		});
		await waitFor(() =>
			expect(within(menu).getAllByTestId("session-sheet-toast")).toHaveLength(
				2,
			),
		);
		const pill = menu.querySelector(
			'[data-testid="session-sheet-toast"][data-variant="error"]',
		);
		await expect(pill).toHaveTextContent(
			"Beta failed because its account is unavailable.",
		);
		await expect(pill).toHaveAttribute("aria-live", "assertive");
		await expect(
			within(menu).getByText("Beta", { selector: '[data-variant="error"] b' }),
		).toBeVisible();
		await expect(
			within(menu).getByRole("menuitem", { name: "Undo" }),
		).toBeVisible();
	},
};
export const PhoneNotificationsLight: Story = {
	...PhoneNotifications,
	globals: { theme: "light" },
};

// `rootSelector: "body"` is load-bearing. The menu now
// portals out of #storybook-root, which is where the pseudo-states addon starts
// walking -- so a plain `hover: true` reached nothing and this story rendered a
// frame byte-identical to Default for several commits.
export const Hover: Story = {
	...Default,
	parameters: { pseudo: { rootSelector: "body", hover: true } },
};
