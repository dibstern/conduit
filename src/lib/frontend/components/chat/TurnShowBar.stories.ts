import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import type { TurnPanelState } from "../../stores/turn-panel.svelte.js";
import TurnShowBar from "./TurnShowBar.svelte";

function panel(view: TurnPanelState["view"]): TurnPanelState {
	return {
		phase: "settled",
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
