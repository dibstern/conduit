import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import HoldMenuDemo from "./__fixtures__/HoldMenuDemo.svelte";

const meta = {
	title: "UI/HoldMenu",
	component: HoldMenuDemo,
	tags: ["autodocs", "viewport-capture"],
} satisfies Meta<typeof HoldMenuDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

function pointer(node: Element, type: string, x?: number, y?: number) {
	const rect = node.getBoundingClientRect();
	node.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			isPrimary: true,
			pointerId: 71,
			pointerType: "touch",
			button: 0,
			clientX: x ?? rect.left + rect.width / 2,
			clientY: y ?? rect.top + rect.height / 2,
		}),
	);
}

async function follow(canvasElement: HTMLElement) {
	const body = within(canvasElement.ownerDocument.body);
	const trigger = await body.findByRole("menuitem", { name: /Snooze/ });
	pointer(trigger, "pointerdown");
	await waitFor(() =>
		expect(trigger).toHaveAttribute("data-hold-menu-phase", "following"),
	);
	const row = await body.findByRole("menuitem", { name: /This evening/ });
	const idleBackground = getComputedStyle(row).backgroundColor;
	await waitFor(() => {
		const rect = row.getBoundingClientRect();
		pointer(trigger, "pointermove", rect.left + 20, rect.top + rect.height / 2);
		expect(getComputedStyle(row).backgroundColor).not.toBe(idleBackground);
		expect(getComputedStyle(row).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
	});
	return { body, trigger, row };
}

export const Closed: Story = {};
export const ClosedLight: Story = { globals: { theme: "light" } };
export const Following: Story = {
	play: async ({ canvasElement }) => {
		const { body } = await follow(canvasElement);
		await expect(body.getByText("slide to a time, let go")).toBeVisible();
		await expect(
			getComputedStyle(body.getByTestId("hold-menu-header")).opacity,
		).toBe("1");
		await expect(
			getComputedStyle(body.getByTestId("hold-menu-views")).opacity,
		).toBe("0.28");
	},
};
export const FollowingLight: Story = {
	...Following,
	globals: { theme: "light" },
};
export const Open: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(
			await body.findByRole("menuitem", { name: /Snooze/ }),
		);
		await expect(
			body.getByRole("menu", { name: "Snooze until" }),
		).toBeVisible();
		await expect(
			body.queryByText("slide to a time, let go"),
		).not.toBeInTheDocument();
	},
};
export const OpenLight: Story = { ...Open, globals: { theme: "light" } };
export const PickOnRelease: Story = {
	play: async ({ canvasElement }) => {
		const { body, trigger, row } = await follow(canvasElement);
		const rect = row.getBoundingClientRect();
		pointer(trigger, "pointerup", rect.left + 20, rect.top + rect.height / 2);
		trigger.click();
		await waitFor(() =>
			expect(body.queryByRole("menu")).not.toBeInTheDocument(),
		);
		await expect(
			within(canvasElement).getByTestId("hold-menu-picked"),
		).toHaveTextContent("evening");
		await expect(
			within(canvasElement).getByTestId("hold-menu-picks"),
		).toHaveTextContent("1");
	},
};
export const ReleaseOffList: Story = {
	play: async ({ canvasElement }) => {
		const { body, trigger, row } = await follow(canvasElement);
		// Slide back off the list first: release picks whatever the last move highlighted.
		pointer(trigger, "pointermove");
		await waitFor(() => expect(row).not.toHaveAttribute("data-followed"));
		pointer(trigger, "pointerup");
		trigger.click();
		await waitFor(() =>
			expect(trigger).toHaveAttribute("data-hold-menu-phase", "open"),
		);
		await expect(
			body.getByRole("menu", { name: "Snooze until" }),
		).toBeVisible();
		await expect(
			within(canvasElement).getByTestId("hold-menu-picks"),
		).toHaveTextContent("0");
	},
};
export const CancelledPointer: Story = {
	play: async ({ canvasElement }) => {
		const { body, trigger } = await follow(canvasElement);
		pointer(trigger, "pointercancel");
		await waitFor(() =>
			expect(trigger).toHaveAttribute("data-hold-menu-phase", "open"),
		);
		await expect(
			body.getByRole("menu", { name: "Snooze until" }),
		).toBeVisible();
	},
};
export const DimDismissal: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(
			await body.findByRole("menuitem", { name: /Snooze/ }),
		);
		const layer = canvasElement.ownerDocument.querySelector<HTMLElement>(
			"[data-hold-menu-dismiss]",
		);
		if (!layer) throw new Error("Missing in-menu dismiss layer");
		await userEvent.click(layer);
		await waitFor(() =>
			expect(
				body.queryByRole("menu", { name: "Snooze until" }),
			).not.toBeInTheDocument(),
		);
		await expect(
			body.getByRole("menu", { name: "Session actions" }),
		).toBeVisible();
		await expect(body.getByRole("menuitem", { name: /Snooze/ })).toHaveFocus();
	},
};
export const Keyboard: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const trigger = await body.findByRole("menuitem", { name: /Snooze/ });
		for (const key of ["{Enter}", " ", "{ArrowRight}"]) {
			trigger.focus();
			await userEvent.keyboard(key);
			await waitFor(() =>
				expect(body.getByRole("menuitem", { name: /In 1 hour/ })).toHaveFocus(),
			);
			await userEvent.keyboard("{ArrowLeft}");
			await waitFor(() =>
				expect(
					body.queryByRole("menu", { name: "Snooze until" }),
				).not.toBeInTheDocument(),
			);
			await expect(trigger).toHaveFocus();
		}
		await userEvent.keyboard("{Enter}{Escape}");
		await waitFor(() =>
			expect(
				body.queryByRole("menu", { name: "Snooze until" }),
			).not.toBeInTheDocument(),
		);
		await userEvent.keyboard("{Escape}");
		await waitFor(() =>
			expect(body.queryByRole("menu")).not.toBeInTheDocument(),
		);
	},
};
export const ScrollCancelsPress: Story = {
	args: { scrollable: true },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const trigger = await body.findByRole("menuitem", { name: /Snooze/ });
		pointer(trigger, "pointerdown");
		trigger.closest("[data-sheet-body]")?.dispatchEvent(new Event("scroll"));
		await new Promise((resolve) => setTimeout(resolve, 500));
		pointer(trigger, "pointerup");
		trigger.click();
		await expect(
			body.queryByRole("menu", { name: "Snooze until" }),
		).not.toBeInTheDocument();
		await expect(
			body.getByRole("menu", { name: "Session actions" }),
		).toBeVisible();
	},
};
export const PopoverOpen: Story = {
	...Open,
	args: { presentation: "popover" },
};
export const DeviceProbe: Story = { args: { probe: true, scrollable: true } };
