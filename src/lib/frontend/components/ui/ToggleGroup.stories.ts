import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import ToggleGroupSnippetHost from "./__fixtures__/ToggleGroupSnippetHost.svelte";

const meta = {
	title: "UI/ToggleGroup",
	component: ToggleGroupSnippetHost,
	parameters: { layout: "padded", a11y: { test: "error" } },
} satisfies Meta<typeof ToggleGroupSnippetHost>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultiplePressed: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByRole("group", { name: "Session views" }),
		).toBeVisible();
		const chat = canvas.getByRole("button", { name: "Chat" });
		const terminal = canvas.getByRole("button", { name: "Terminal" });
		await userEvent.click(terminal);
		await expect(chat).toHaveAttribute("aria-pressed", "true");
		await expect(terminal).toHaveAttribute("aria-pressed", "true");
		await expect(canvas.getByTestId("content-terminal")).toHaveTextContent(
			"⌘J",
		);
		await expect(canvas.getByRole("button", { name: "Diff" })).toBeDisabled();
	},
};

export const KeyboardFocus: Story = {
	// play() drives the roving focus with untrusted events, which Chromium never
	// treats as keyboard modality, so the real ring would not paint in the
	// capture. The pseudo-state draws the ring on the item the keys land on.
	parameters: { pseudo: { focusVisible: ['button[aria-label="Terminal"]'] } },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const chat = canvas.getByRole("button", { name: "Chat" });
		const terminal = canvas.getByRole("button", { name: "Terminal" });
		chat.focus();
		await userEvent.keyboard("{ArrowRight}");
		await expect(terminal).toHaveFocus();
		await userEvent.keyboard(" ");
		await expect(terminal).toHaveAttribute("aria-pressed", "true");
	},
};

export const VerticalRail: Story = {
	args: { rail: true },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const group = canvas.getByRole("group", { name: "Session views" });
		await expect(group).toHaveAttribute("data-orientation", "vertical");
		canvas.getByRole("button", { name: "Chat" }).focus();
		await userEvent.keyboard("{ArrowDown}");
		const terminal = canvas.getByRole("button", { name: "Terminal" });
		await expect(terminal).toHaveFocus();
		await userEvent.keyboard(" ");
		await expect(terminal).toHaveAttribute("aria-pressed", "true");
		await expect(canvas.getByRole("button", { name: "Diff" })).toBeDisabled();
	},
};
