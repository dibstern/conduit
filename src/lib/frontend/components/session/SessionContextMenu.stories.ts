import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { showToast } from "../../stores/ui.svelte.js";
import { wsDebugState } from "../../stores/ws-debug.svelte.js";
import { mockSession, mockSessionLongTitle } from "../../stories/mocks.js";
import { connectedSocket, replyRpc } from "../../stories/sockets.js";
import type { SessionInfo } from "../../types.js";
import SessionContextMenuHarness from "./__fixtures__/SessionContextMenuHarness.svelte";

const sheetNow = Date.UTC(2026, 9, 16, 12);

async function phoneMenu() {
	const menu = await within(document.body).findByTestId("session-action-sheet");
	await waitFor(() =>
		expect(
			menu.querySelector("[data-switch-status]"),
		).not.toBeEmptyDOMElement(),
	);
	return menu;
}

const meta = {
	title: "Session/SessionContextMenu",
	component: SessionContextMenuHarness,
	// viewport-capture: the menu portals to <body>, outside #storybook-root.
	tags: ["autodocs", "viewport-capture"],
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "340px" } },
	},
	args: { session: mockSession, now: sheetNow },
	beforeEach: ({ args }) => {
		const restoreSocket = connectedSocket();
		const restoreOutlook = replyRpc("GetSessionAutoSettleOutlook", () => {
			const session = args["session"] as SessionInfo;
			if (session.autoSettleDisabled) return { kind: "off" };
			if (session.pinnedAt != null) return { kind: "paused", reason: "pinned" };
			if (session.settledAt != null) return { kind: "settled" };
			if (session.snoozedAt != null)
				return { kind: "paused", reason: "snoozed" };
			if (session.unread) return { kind: "paused", reason: "unread" };
			return { kind: "scheduled", at: sheetNow + 2 * 86_400_000 };
		});
		const guardedFetch = globalThis.fetch;
		globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
			String(input instanceof Request ? input.url : input).endsWith(
				"/api/status",
			)
				? Promise.resolve(Response.json({ status: "ready" }))
				: guardedFetch(input, init);
		return () => {
			restoreOutlook();
			restoreSocket();
			globalThis.fetch = guardedFetch;
		};
	},
	play: async () => {
		const menu = await within(document.body).findByRole("menu", {
			name: "Session actions",
		});
		await expect(within(menu).getByTestId("session-ctx-rename")).toBeVisible();
		if (menu.querySelector("[data-switch-status]")) await phoneMenu();
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
	play: async () => {
		const menu = await within(document.body).findByRole("menu", {
			name: "Session actions",
		});
		await waitFor(() => {
			const bounds = menu.getBoundingClientRect();
			expect(bounds.left).toBeGreaterThanOrEqual(0);
			expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
			expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth);
		});
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
			const menu = await phoneMenu();
			await waitFor(() =>
				expect(
					document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
						?.content,
				).toBe(
					document.documentElement.classList.contains("light-theme")
						? "#b0b1b3"
						: "#0b0c0e",
				),
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
			await expect(tiles).toHaveLength(6);
			await expect(
				within(group).getByTestId("session-ctx-archive"),
			).toBeVisible();
			expect(
				new Set(tiles.map((tile) => tile.getBoundingClientRect().top)).size,
			).toBe(2);
			await expect(
				within(within(menu).getByTestId("session-ctx-copy-resume")).getByText(
					"Copy resume",
					{ exact: true },
				),
			).toBeVisible();
			for (const tile of menu.querySelectorAll<HTMLElement>(
				"[data-menu-tile]",
			)) {
				const primary = tile.querySelector<HTMLElement>(
					":scope > span:not([aria-hidden])",
				);
				if (!primary) throw new Error("Tile primary label is missing");
				// Wrapped labels must retain their full text without horizontal clipping.
				expect(primary.scrollWidth).toBeLessThanOrEqual(primary.clientWidth);
				expect(primary.scrollHeight).toBeLessThanOrEqual(primary.clientHeight);
				expect(getComputedStyle(primary).textOverflow).not.toBe("ellipsis");
				const tileBox = tile.getBoundingClientRect();
				for (const label of tile.querySelectorAll<HTMLElement>(
					"small, span:not([aria-hidden])",
				)) {
					const labelBox = label.getBoundingClientRect();
					expect(labelBox.left).toBeGreaterThanOrEqual(tileBox.left);
					expect(labelBox.right).toBeLessThanOrEqual(tileBox.right);
					expect(labelBox.top).toBeGreaterThanOrEqual(tileBox.top);
					expect(labelBox.bottom).toBeLessThanOrEqual(tileBox.bottom);
					if (label !== primary) {
						expect(labelBox.height).toBeLessThanOrEqual(
							Number.parseFloat(getComputedStyle(label).lineHeight) ||
								Number.parseFloat(getComputedStyle(label).fontSize) * 1.5,
						);
					}
				}
			}
			const glyph = menu.querySelector(
				'[data-testid="session-sheet-header"] .session-status-glyph',
			);
			const expectedState =
				state.pinnedAt == null && state.settledAt != null
					? "settled"
					: state.pinnedAt == null && state.snoozedAt != null
						? "snoozed"
						: (state.attention ?? "idle");
			await expect(glyph).toBeVisible();
			await expect(glyph).toHaveAttribute("data-state", expectedState);
			await expect(glyph).toHaveStyle({ width: "18px", height: "18px" });
			if (expectedState === "settled" || expectedState === "snoozed") {
				await expect(glyph?.querySelector("svg")).toHaveClass(
					`lucide-${expectedState === "settled" ? "check" : "moon"}`,
				);
			} else {
				await expect(
					glyph?.querySelector(
						`[data-flow-glyph="${expectedState === "done-unread" ? "unread" : "idle"}"]`,
					),
				).toBeVisible();
			}
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
		const menu = await phoneMenu();
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
		const menu = await phoneMenu();
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
export const PhoneUnread: Story = phoneSheet({
	unread: true,
	attention: "done-unread",
});
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
		const menu = await phoneMenu();
		await expect(within(menu).getByTestId("overflow-share")).toBeVisible();
		await expect(within(menu).getByTestId("overflow-settings")).toBeVisible();
		expect(within(menu).queryByTestId("overflow-debug")).toBeNull();
		await expect(
			within(menu)
				.getByRole("group", { name: "Session" })
				.querySelectorAll("[data-menu-tile]"),
		).toHaveLength(5);
	},
};
export const PhoneWithFooterLight: Story = {
	...PhoneWithFooter,
	globals: { theme: "light" },
};

export const PhoneSnoozeOpen: Story = {
	...PhoneWithFooter,
	play: async () => {
		const menu = await phoneMenu();
		const tile = within(menu).getByTestId("session-ctx-snooze");
		await expect(within(tile).getByText("hold")).toBeVisible();
		await userEvent.click(tile);
		const list = await within(document.body).findByRole("menu", {
			name: "Snooze until",
		});
		await expect(list).toBeVisible();
		await expect(tile).toHaveAttribute("data-hold-menu-phase", "open");
		await expect(
			within(list).getByRole("menuitem", { name: /In 1 hour/ }),
		).toBeVisible();
		await expect(
			getComputedStyle(within(menu).getByTestId("session-sheet-header"))
				.opacity,
		).toBe("1");
		await expect(menu.querySelector("[data-sheet-footer]")).toHaveStyle({
			opacity: "0.28",
		});
	},
};
export const PhoneSnoozeOpenLight: Story = {
	...PhoneSnoozeOpen,
	globals: { theme: "light" },
};

export const PhoneSnoozeHolding: Story = {
	...PhoneWithFooter,
	play: async () => {
		const menu = await phoneMenu();
		const tile = within(menu).getByTestId("session-ctx-snooze");
		const box = tile.getBoundingClientRect();
		// Stories stage the visual state; acceptance uses native CDP touch events.
		const pointer = (type: string, x: number, y: number) =>
			tile.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					isPrimary: true,
					pointerId: 79,
					pointerType: "touch",
					button: 0,
					clientX: x,
					clientY: y,
				}),
			);
		pointer("pointerdown", box.left + box.width / 2, box.top + box.height / 2);
		await waitFor(() =>
			expect(tile).toHaveAttribute("data-hold-menu-phase", "following"),
		);
		const list = await within(document.body).findByRole("menu", {
			name: "Snooze until",
		});
		const time = within(list).getByRole("menuitem", { name: /In 3 hours/ });
		await waitFor(() => {
			expect(list.getBoundingClientRect().top).toBeGreaterThanOrEqual(
				tile.getBoundingClientRect().bottom + 9,
			);
			expect(
				list.getBoundingClientRect().top - tile.getBoundingClientRect().bottom,
			).toBeLessThanOrEqual(13);
			expect(list.getBoundingClientRect().bottom).toBeLessThanOrEqual(
				window.innerHeight,
			);
			const target = time.getBoundingClientRect();
			pointer("pointermove", target.left + 20, target.top + target.height / 2);
			expect(time).toHaveAttribute("data-followed", "true");
		});
		await expect(
			within(list).getByText("slide to a time, let go"),
		).toBeVisible();
	},
};
export const PhoneSnoozeHoldingLight: Story = {
	...PhoneSnoozeHolding,
	globals: { theme: "light" },
};

export const PhoneChangeSnooze: Story = {
	...PhoneSnoozed,
	play: async () => {
		const menu = await phoneMenu();
		const tile = within(menu).getByTestId("session-ctx-snooze");
		await expect(tile).toHaveAccessibleName("Change snooze…");
		await expect(tile).toHaveTextContent("until");
		// The sub-line takes the tile while snoozed: no hold hint (Final · session menu).
		await expect(within(tile).queryByText("hold")).not.toBeInTheDocument();
		await userEvent.click(tile);
		await expect(
			await within(document.body).findByRole("menu", { name: "Snooze until" }),
		).toBeVisible();
	},
};
export const PhoneChangeSnoozeLight: Story = {
	...PhoneChangeSnooze,
	globals: { theme: "light" },
};

export const PhonePickSnoozeDate: Story = {
	...PhoneWithFooter,
	play: async () => {
		const menu = await phoneMenu();
		await userEvent.click(within(menu).getByTestId("session-ctx-snooze"));
		const list = await within(document.body).findByRole("menu", {
			name: "Snooze until",
		});
		await userEvent.click(
			within(list).getByRole("menuitem", { name: /Pick a date & time/ }),
		);
		await expect(
			await within(document.body).findByTestId("snooze-pick-input"),
		).toBeVisible();
		await expect(
			within(document.body).getByTestId("snooze-pick-submit"),
		).toBeDisabled();
		await waitFor(() => expect(menu).not.toBeInTheDocument());
	},
};
export const PhonePickSnoozeDateLight: Story = {
	...PhonePickSnoozeDate,
	globals: { theme: "light" },
};
export const PhoneDebugFooter: Story = {
	...PhoneWithFooter,
	args: { ...PhoneWithFooter.args, debug: true },
	play: async () => {
		await phoneMenu();
		const debug = await within(document.body).findByTestId("overflow-debug");
		await expect(debug).toHaveAccessibleName("Debug panel");
		await expect(debug).toHaveRole("switch");
		await expect(debug).toHaveAttribute("aria-checked", "false");
		await userEvent.click(within(debug).getByText("Debug", { exact: true }));
		await expect(debug).toHaveAttribute("aria-checked", "true");
		await expect(await phoneMenu()).toBeVisible();
	},
};
export const PhoneDebugFooterLight: Story = {
	...PhoneDebugFooter,
	globals: { theme: "light" },
};
export const DesktopDebugMenu: Story = {
	args: { withFooter: true, debug: true },
	play: async () => {
		const debug = await within(document.body).findByRole("menuitemcheckbox", {
			name: "Debug panel",
		});
		await expect(debug).toHaveAttribute("aria-checked", "false");
		wsDebugState.panelOpen = true;
		await waitFor(() => expect(debug).toHaveAttribute("aria-checked", "true"));
	},
};
export const DesktopDebugMenuLight: Story = {
	...DesktopDebugMenu,
	globals: { theme: "light" },
};
export const PhoneDisabledReason: Story = {
	...PhonePinned,
	play: async () => {
		const menu = await phoneMenu();
		const snooze = within(menu).getByTestId("session-ctx-snooze");
		await expect(snooze).toHaveAttribute("aria-disabled", "true");
		await expect(snooze).not.toHaveAttribute("data-hold-menu-trigger");
		await expect(within(snooze).queryByText("hold")).not.toBeInTheDocument();
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
		const menu = await phoneMenu();
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
