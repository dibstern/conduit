import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { SvelteMap } from "svelte/reactivity";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import type { TurnPanelState } from "../../stores/turn-panel.svelte.js";
import type { ShowStop } from "../../utils/turn-stops.js";
import TurnShowBar from "./TurnShowBar.svelte";

function panel(view: TurnPanelState["view"]): TurnPanelState {
	return {
		phase: "settled",
		hasHandBacks: false,
		stops: ["final", "key", "balanced", "all", "log"],
		view,
		saved: "balanced",
		overridden: true,
		pending: null,
		target: null,
		ack: fn(),
		open: fn(),
		collapse: fn(),
		show: fn(),
		usage: fn(),
		qa: fn(),
		hold: fn(),
		makeDefault: fn(async () => {}),
		resetLevel: fn(),
	};
}

const meta = {
	title: "Chat/Turn Show Bar",
	component: TurnShowBar,
	tags: ["viewport-capture"],
	parameters: { layout: "padded" },
	args: {
		panel: panel({ kind: "open", view: { kind: "show", stop: "balanced" } }),
		counts: { key: 3, balanced: 5, all: 6, log: 16 },
		bill: { cost: 0.42 },
		running: 0,
		onlevelchange: fn(),
	},
	beforeEach: () => {
		const compact = sessionViewState.compact;
		sessionViewState.compact = true;
		return () => {
			sessionViewState.compact = compact;
		};
	},
} satisfies Meta<typeof TurnShowBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PhoneMenu: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", { name: "Show messages" });
		await expect(trigger).toHaveTextContent("Show · Most messages ⌄");
		await userEvent.click(trigger);
		const menu = body.getByRole("menu", { name: "Show, least to most" });
		await expect(menu).toBeVisible();
		await expect(menu).toHaveAttribute("data-side", "bottom");
		await expect(
			body.queryByTestId("menu-sheet-scrim"),
		).not.toBeInTheDocument();
		await expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(5);
		const selected = within(menu).getByRole("menuitemradio", {
			name: "Most messages",
		});
		await expect(selected).toHaveAttribute("aria-checked", "true");
		await expect(selected).toHaveTextContent("Adds decisions");
		await expect(selected.querySelector("small")).toHaveTextContent("5");
		await expect(
			within(menu).getByRole("menuitem", { name: "Make default" }),
		).toBeVisible();
		await expect(
			within(menu).getByRole("menuitem", { name: "Back to default" }),
		).toBeVisible();
	},
};

export const PhoneMenuLight: Story = {
	...PhoneMenu,
	globals: { theme: "light" },
};

export const UsageSelected: Story = {
	args: { panel: panel({ kind: "open", view: { kind: "usage" } }) },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", { name: "Show messages" });
		await expect(trigger).toHaveTextContent(/^Show ⌄$/);
		await expect(
			canvas.queryByTestId("surfacing-level-default-dot"),
		).not.toBeInTheDocument();
		await userEvent.click(trigger);
		const menu = body.getByRole("menu", { name: "Show, least to most" });
		for (const row of within(menu).getAllByRole("menuitemradio"))
			await expect(row).toHaveAttribute("aria-checked", "false");
	},
};

export const QaSelected: Story = {
	args: {
		panel: {
			...panel({ kind: "open", view: { kind: "qa" } }),
			hasHandBacks: true,
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(
			canvas.getByRole("button", { name: "Show messages" }),
		);
		await expect(
			body.getByRole("menuitemradio", { name: /^Q&A$/ }),
		).toHaveAttribute("aria-checked", "true");
	},
};

export const QaJevOff: Story = {
	...QaSelected,
	args: {
		panel: {
			...panel({ kind: "open", view: { kind: "qa" } }),
			hasHandBacks: true,
			stops: ["log"],
		},
	},
};

export const FullLogSelected: Story = {
	args: { panel: panel({ kind: "open", view: { kind: "show", stop: "log" } }) },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", { name: "Show messages" });
		await expect(trigger).toHaveTextContent("Show · Full log ⌄");
		await userEvent.click(trigger);
		await expect(
			body.getByRole("menuitemradio", { name: "Full log" }),
		).toHaveAttribute("aria-checked", "true");
	},
};

export const JevOff: Story = {
	args: {
		panel: {
			...panel({ kind: "open", view: { kind: "show", stop: "log" } }),
			stops: ["log"],
			overridden: false,
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByRole("tab", { name: "Log", selected: true }),
		).toBeVisible();
		await expect(
			canvas.queryByRole("button", { name: "Show messages" }),
		).not.toBeInTheDocument();
	},
};

export const KeyboardSelection: Story = {
	play: async ({ args, canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", { name: "Show messages" });
		trigger.focus();
		await userEvent.keyboard("{ArrowDown}");
		const menu = body.getByRole("menu", { name: "Show, least to most" });
		await waitFor(() =>
			expect(
				within(menu).getByRole("menuitemradio", { name: "Answer only" }),
			).toHaveFocus(),
		);
		await userEvent.keyboard("{ArrowDown}");
		await expect(
			within(menu).getByRole("menuitemradio", { name: "Key messages" }),
		).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect(args["panel"].show).toHaveBeenCalledWith("key");
		await waitFor(() => expect(trigger).toHaveFocus());
		await userEvent.click(trigger);
		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(body.queryByRole("menu")).not.toBeInTheDocument(),
		);
		await expect(trigger).toHaveFocus();
	},
};

/** Default actions share a menu so the settled bill fits beside the tabs in a full desktop card. */
export const DefaultsMenu: Story = {
	args: {
		bill: {
			cost: 0.1234,
			context: { used: 64000, window: 200000, pct: 32 },
		},
	},
	beforeEach: ({ args }) => {
		sessionViewState.compact = false;
		const selection = new SvelteMap<string, ShowStop>([["stop", "balanced"]]);
		args["panel"] = {
			...panel({ kind: "open", view: { kind: "show", stop: "balanced" } }),
			hasHandBacks: true,
			get view(): TurnPanelState["view"] {
				return {
					kind: "open",
					view: { kind: "show", stop: selection.get("stop") ?? "balanced" },
				};
			},
			get overridden() {
				return selection.get("stop") !== "balanced";
			},
			show: fn((stop: ShowStop) => {
				selection.set("stop", stop);
			}),
		};
	},
	play: async ({ canvasElement }) => {
		canvasElement.style.width = "712px";
		canvasElement.style.paddingTop = "120px";
		await document.fonts.ready;
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const bar = canvas.getByTestId("turn-show-bar");
		const tabs = canvas.getByRole("tablist", { name: "Show" });
		const cost = canvas.getByText("$0.1234").closest(".turn-meta");
		if (!cost) throw new Error("Missing settled bill");
		await expect(bar).toHaveAttribute("data-layout", "tabs");
		await expect(
			Math.abs(
				cost.getBoundingClientRect().top - tabs.getBoundingClientRect().top,
			),
		).toBeLessThanOrEqual(4);
		const trigger = canvas.getByRole("button", { name: "Default level" });
		await userEvent.click(trigger);
		const menu = body.getByRole("menu", { name: "Default level" });
		await expect(menu).toHaveAttribute("data-side", "top");
		await expect(menu).toHaveAttribute("data-align", "end");
		await expect(
			within(menu).getByRole("menuitem", { name: "Make default" }),
		).not.toHaveAttribute("aria-disabled", "true");
		await expect(
			within(menu).getByRole("menuitem", { name: "Back to default" }),
		).toHaveAttribute("aria-disabled", "true");
		await userEvent.keyboard("{Escape}");
		await userEvent.click(canvas.getByRole("tab", { name: "Key" }));
		await userEvent.click(trigger);
		await expect(
			body.getByRole("menuitem", { name: "Back to default" }),
		).not.toHaveAttribute("aria-disabled", "true");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(trigger).toHaveFocus());
		trigger.blur();
	},
};

/** A narrow desktop card (768px with the sidebar open) uses the Show menu without overflowing. */
export const NarrowCardMenu: Story = {
	args: {
		...DefaultsMenu.args,
		panel: {
			...panel({ kind: "open", view: { kind: "show", stop: "balanced" } }),
			hasHandBacks: true,
		},
	},
	beforeEach: () => {
		sessionViewState.compact = false;
	},
	play: async ({ canvasElement }) => {
		canvasElement.style.width = "315px";
		await document.fonts.ready;
		const canvas = within(canvasElement);
		const bar = canvas.getByTestId("turn-show-bar");
		await waitFor(() => expect(bar).toHaveAttribute("data-layout", "menu"));
		await expect(
			canvas.getByRole("button", { name: "Show messages" }),
		).toBeVisible();
		await expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
		canvasElement.style.width = "710px";
		await waitFor(() => expect(bar).toHaveAttribute("data-layout", "tabs"));
		const tabs = canvas.getByRole("tablist", { name: "Show" });
		const cost = canvas.getByText("$0.1234").closest(".turn-meta");
		if (!cost) throw new Error("Missing settled bill");
		await expect(tabs.scrollWidth).toBeLessThanOrEqual(tabs.clientWidth);
		await expect(
			Math.abs(
				cost.getBoundingClientRect().top - tabs.getBoundingClientRect().top,
			),
		).toBeLessThanOrEqual(4);
		canvasElement.style.width = "709px";
		await waitFor(() => expect(bar).toHaveAttribute("data-layout", "menu"));
		canvasElement.style.width = "315px";
		await waitFor(() => expect(bar.clientWidth).toBe(315));
		await expect(bar).toHaveAttribute("data-layout", "menu");
		await expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
	},
};
