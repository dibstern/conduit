import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import TwoRowComposerDemo from "./__fixtures__/TwoRowComposerDemo.svelte";

const meta = {
	title: "UI/TwoRowComposerLayout",
	component: TwoRowComposerDemo,
	tags: ["autodocs"],
	parameters: { layout: "padded", a11y: { test: "error" } },
	argTypes: {
		placeholder: { control: "text" },
		value: { control: "text" },
		working: { control: "boolean" },
		showControls: { control: "boolean" },
		width: { control: "number" },
	},
} satisfies Meta<typeof TwoRowComposerDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

async function assertRows(canvasElement: HTMLElement, rows: "1" | "2") {
	await waitFor(() =>
		expect(
			within(canvasElement).getByTestId("two-row-composer"),
		).toHaveAttribute("data-rows", rows),
	);
}

async function assertFullWidth(canvasElement: HTMLElement) {
	await waitFor(() => {
		const canvas = within(canvasElement);
		const layout = canvas.getByTestId("two-row-composer");
		const composer = layout.parentElement;
		const field = canvas.getByRole("textbox");
		expect(composer).not.toBeNull();
		expect(field.getBoundingClientRect().width).toBeGreaterThanOrEqual(
			(composer?.getBoundingClientRect().width ?? 0) - 20,
		);
		const slots = ["leading", "controls", "send"].map((slot) =>
			layout.querySelector<HTMLElement>(`[data-slot="${slot}"]`),
		);
		for (const slot of slots) {
			expect(slot).not.toBeNull();
			expect(slot?.getBoundingClientRect().top).toBeGreaterThanOrEqual(
				field.getBoundingClientRect().bottom - 1,
			);
		}
		const send = slots[2]?.getBoundingClientRect();
		expect(send?.right).toBeCloseTo(layout.getBoundingClientRect().right, 0);
	});
}

export const IdleEmpty: Story = {
	play: async ({ canvasElement }) => {
		await assertRows(canvasElement, "1");
		await expect(within(canvasElement).getByRole("textbox")).toHaveValue("");
	},
};

export const LongPlaceholder: Story = {
	args: {
		placeholder:
			"Ask anything. / to use skills, @ to mention files, including a very long path to a file.",
	},
	play: async ({ canvasElement }) => {
		await assertRows(canvasElement, "2");
		await assertFullWidth(canvasElement);
		const textarea = within(canvasElement).getByRole("textbox");
		await waitFor(() =>
			expect(textarea.scrollHeight).toBeLessThanOrEqual(
				textarea.clientHeight + 1,
			),
		);
	},
};

export const TypingAndDeleting: Story = {
	play: async ({ canvasElement }) => {
		const textarea = within(canvasElement).getByRole("textbox");
		await userEvent.type(
			textarea,
			"Also run the Linux baselines before you call it done.",
		);
		await assertRows(canvasElement, "2");
		await assertFullWidth(canvasElement);
		await userEvent.clear(textarea);
		await userEvent.type(textarea, "Hi");
		await assertRows(canvasElement, "1");
	},
};

export const SendAndStop: Story = {
	args: { working: true },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			canvas.getByRole("textbox"),
			"Skip the flaky one and look at the focus ring before calling it done.",
		);
		await assertRows(canvasElement, "2");
		await assertFullWidth(canvasElement);
		await expect(canvas.getByRole("button", { name: "Send" })).toBeEnabled();
		await expect(canvas.getByRole("button", { name: "Stop" })).toBeVisible();
	},
};

export const ContentChanges: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button", { name: "Long draft" }));
		await assertRows(canvasElement, "2");
		await assertFullWidth(canvasElement);
		await userEvent.click(canvas.getByRole("button", { name: "Toggle stop" }));
		await assertFullWidth(canvasElement);
		await userEvent.click(canvas.getByRole("button", { name: "Short draft" }));
		await assertRows(canvasElement, "1");
		await userEvent.clear(canvas.getByRole("textbox"));
		await userEvent.click(
			canvas.getByRole("button", { name: "Long placeholder" }),
		);
		await assertRows(canvasElement, "2");
		await userEvent.click(
			canvas.getByRole("button", { name: "Short placeholder" }),
		);
		await assertRows(canvasElement, "1");
	},
};

export const ResizeAndControls: Story = {
	args: { showControls: false, width: 180 },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await assertRows(canvasElement, "1");
		await userEvent.click(
			canvas.getByRole("button", { name: "Toggle controls" }),
		);
		await assertRows(canvasElement, "2");
		await assertFullWidth(canvasElement);
		await userEvent.click(
			canvas.getByRole("button", { name: "Widen composer" }),
		);
		await assertRows(canvasElement, "1");
		await userEvent.click(
			canvas.getByRole("button", { name: "Narrow composer" }),
		);
		await assertRows(canvasElement, "2");
	},
};

export const SilentValueChanges: Story = {
	play: async ({ canvasElement }) => {
		const textarea = within(canvasElement).getByRole(
			"textbox",
		) as HTMLTextAreaElement;
		// No event and no mirror update: this also covers a bound value setter.
		textarea.value =
			"A remote draft can arrive without the user typing anything at all.";
		await assertRows(canvasElement, "2");
		await assertFullWidth(canvasElement);
		textarea.value = "Hi";
		await assertRows(canvasElement, "1");
		textarea.value = "Hi\n";
		await assertRows(canvasElement, "2");
		await assertFullWidth(canvasElement);
		textarea.value = "";
		await assertRows(canvasElement, "1");
	},
};

export const IdleEmptyLight: Story = {
	...IdleEmpty,
	globals: { theme: "light" },
};
export const LongPlaceholderLight: Story = {
	...LongPlaceholder,
	globals: { theme: "light" },
};
export const TypingAndDeletingLight: Story = {
	...TypingAndDeleting,
	globals: { theme: "light" },
};
export const SendAndStopLight: Story = {
	...SendAndStop,
	globals: { theme: "light" },
};
export const ContentChangesLight: Story = {
	...ContentChanges,
	globals: { theme: "light" },
};
export const ResizeAndControlsLight: Story = {
	...ResizeAndControls,
	globals: { theme: "light" },
};
export const SilentValueChangesLight: Story = {
	...SilentValueChanges,
	globals: { theme: "light" },
};
