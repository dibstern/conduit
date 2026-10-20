import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { tick } from "svelte";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import PopoverDemo from "./__fixtures__/PopoverDemo.svelte";

const meta = {
	title: "UI/Popover",
	component: PopoverDemo,
	tags: ["autodocs", "viewport-capture"],
	args: { open: true, headerless: false },
	argTypes: {
		open: { control: "boolean" },
		headerless: { control: "boolean" },
	},
} satisfies Meta<typeof PopoverDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);

		await expect(body.getByRole("dialog", { name: "Details" })).toBeVisible();
	},
};

export const Headerless: Story = {
	args: { headerless: true },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);

		await expect(
			body.getByRole("dialog", { name: "Quick details" }),
		).toBeVisible();
	},
};

export const EscapeRestoresFocus: Story = {
	args: { open: false },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const trigger = canvas.getByRole("button", { name: "Open popover" });

		await userEvent.click(trigger);
		await userEvent.keyboard("{Escape}");

		await waitFor(() => {
			expect(body.queryByRole("dialog")).not.toBeInTheDocument();
		});
		await waitFor(() => {
			expect(
				canvas.getByRole("button", { name: "Open popover" }),
			).toHaveFocus();
		});

		await userEvent.click(trigger);
		await expect(body.getByRole("dialog", { name: "Details" })).toBeVisible();
	},
};

export const Sheet: Story = {
	args: { presentation: "sheet" },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await expect(body.getByRole("dialog", { name: "Details" })).toBeVisible();
		await expect(body.getByTestId("popover-sheet-scrim")).toBeVisible();
	},
};
export const SheetLight: Story = { ...Sheet, globals: { theme: "light" } };
export const SheetEscapeRestoresFocus: Story = {
	args: { open: false, presentation: "sheet" },
	play: async ({ canvasElement }) => {
		const documentBody = canvasElement.ownerDocument.body;
		const body = within(documentBody);
		const trigger = within(canvasElement).getByRole("button", {
			name: "Open popover",
		});
		await waitFor(() =>
			expect(getComputedStyle(documentBody).pointerEvents).not.toBe("none"),
		);
		await userEvent.click(trigger);
		await expect(
			await body.findByRole("dialog", { name: "Details" }),
		).toBeVisible();
		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(body.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		await waitFor(() => expect(trigger).toHaveFocus());
		await waitFor(() =>
			expect(getComputedStyle(documentBody).pointerEvents).not.toBe("none"),
		);
	},
};

export const AutoCompact: Story = {
	...Sheet,
	args: {
		presentation: "auto",
		detailText: "Compact layout uses the shared sheet.",
	},
	beforeEach: () => {
		const compact = sessionViewState.compact;
		sessionViewState.compact = true;
		return () => {
			sessionViewState.compact = compact;
		};
	},
};
export const AutoCompactLight: Story = {
	...AutoCompact,
	globals: { theme: "light" },
};
export const AutoPopover: Story = {
	args: {
		presentation: "auto",
		editable: true,
		detailText: "The auto presentation follows the session layout when opened.",
	},
	beforeEach: () => {
		const compact = sessionViewState.compact;
		sessionViewState.compact = false;
		return () => {
			sessionViewState.compact = compact;
		};
	},
	play: async ({ canvasElement }) => {
		const documentBody = canvasElement.ownerDocument.body;
		const body = within(documentBody);
		const trigger = within(canvasElement).getByRole("button", {
			name: "Open popover",
		});
		await expect(body.getByRole("dialog", { name: "Details" })).toBeVisible();
		await expect(
			body.queryByTestId("popover-sheet-scrim"),
		).not.toBeInTheDocument();
		const popoverDraft = body.getByRole("textbox", { name: "Draft" });
		await userEvent.type(popoverDraft, "Keep the popover draft");
		sessionViewState.compact = true;
		await tick();
		await expect(
			body.queryByTestId("popover-sheet-scrim"),
		).not.toBeInTheDocument();
		await expect(body.getByRole("textbox", { name: "Draft" })).toBe(
			popoverDraft,
		);
		await expect(popoverDraft).toHaveValue("Keep the popover draft");
		await expect(popoverDraft).toHaveFocus();

		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(body.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		await waitFor(() =>
			expect(getComputedStyle(documentBody).pointerEvents).not.toBe("none"),
		);
		await userEvent.click(trigger);
		await expect(await body.findByTestId("popover-sheet-scrim")).toBeVisible();
		const sheetDraft = body.getByRole("textbox", { name: "Draft" });
		await userEvent.type(sheetDraft, "Keep the sheet draft");
		sessionViewState.compact = false;
		await tick();
		await expect(body.getByTestId("popover-sheet-scrim")).toBeVisible();
		await expect(body.getByRole("textbox", { name: "Draft" })).toBe(sheetDraft);
		await expect(sheetDraft).toHaveValue("Keep the sheet draft");
		await expect(sheetDraft).toHaveFocus();

		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(body.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		await waitFor(() =>
			expect(getComputedStyle(documentBody).pointerEvents).not.toBe("none"),
		);
		await userEvent.click(trigger);
		await expect(
			await body.findByRole("dialog", { name: "Details" }),
		).toBeVisible();
		await expect(
			body.queryByTestId("popover-sheet-scrim"),
		).not.toBeInTheDocument();
	},
};
export const AutoPopoverLight: Story = {
	...AutoPopover,
	globals: { theme: "light" },
};
