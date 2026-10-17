import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import SettingsPickerStory from "./__fixtures__/SettingsPickerStory.svelte";

const meta = {
	title: "UI/SettingsPicker",
	component: SettingsPickerStory,
	tags: ["viewport-capture"],
	parameters: { layout: "padded" },
	beforeEach: () => {
		const compact = sessionViewState.compact;
		sessionViewState.compact = window.innerWidth < 768;
		return () => {
			sessionViewState.compact = compact;
		};
	},
	play: async ({ canvasElement, args }) => {
		const trigger = within(canvasElement).getByRole("button", {
			name: args["unavailable"]
				? "Context warning: 85% (unavailable)"
				: "Context warning: 80%",
		});
		await expect(trigger).toHaveAccessibleDescription(
			"Warn when context is this full. Choose Never to turn warnings off.",
		);
		await expect(trigger).toHaveAttribute(
			"aria-describedby",
			"story-context-warning-hint story-context-warning-help",
		);
		if (args["unavailable"]) {
			await expect(trigger).toHaveAttribute("aria-invalid", "true");
		} else {
			await expect(trigger).not.toHaveAttribute("aria-invalid");
		}
	},
} satisfies Meta<typeof SettingsPickerStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Disabled: Story = { args: { disabled: true } };
export const Unavailable: Story = { args: { unavailable: true } };

export const Open: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(
			body.getByRole("button", { name: "Context warning: 80%" }),
		);
		await expect(
			body.getByRole("menu", { name: "Context warning" }),
		).toBeVisible();
		await expect(
			body.getByRole("menuitemradio", { name: "80%" }),
		).toHaveAttribute("aria-checked", "true");
	},
};
export const OpenLight: Story = { ...Open, globals: { theme: "light" } };

export const SelectionAndDismissal: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const trigger = body.getByRole("button", {
			name: "Context warning: 80%",
		});
		await userEvent.click(trigger);
		await userEvent.click(body.getByRole("menuitemradio", { name: "Never" }));
		await expect(trigger).toHaveTextContent("Never");
		await expect(trigger).toHaveAccessibleName("Context warning: Never");
		await waitFor(() =>
			expect(body.queryByRole("menu")).not.toBeInTheDocument(),
		);
		await expect(trigger).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect(
			body.getByRole("menuitemradio", { name: "Never" }),
		).toHaveAttribute("aria-checked", "true");
		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(body.queryByRole("menu")).not.toBeInTheDocument(),
		);
		await expect(trigger).toHaveFocus();
	},
};
