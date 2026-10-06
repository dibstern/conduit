import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, spyOn, userEvent, waitFor, within } from "storybook/test";
import { effort } from "../../stores/composer-settings.svelte.js";
import {
	clearDiscoveryState,
	discoveryState,
	handleVariantInfo,
} from "../../stores/discovery.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import ModelVariant from "./ModelVariant.svelte";

const onOpen = fn();
const fourLevels = ["low", "medium", "high", "max"];
const fiveLevels = ["low", "medium", "high", "xhigh", "max"];

function seed(variant = "", variants = fourLevels) {
	handleVariantInfo({ variant, variants });
}

function resize(width: number) {
	Object.defineProperty(window, "innerWidth", {
		configurable: true,
		value: width,
	});
	window.dispatchEvent(new Event("resize"));
}

async function assertMeter(node: HTMLElement, levels: number, filled: number) {
	const meter = node.querySelector<HTMLElement>(".effort-meter");
	if (!meter) throw new Error("The effort meter is missing");
	const bars = Array.from(meter.children);
	await expect(bars).toHaveLength(levels);
	const color = getComputedStyle(meter).color;
	for (const [index, bar] of bars.entries()) {
		if (index < filled) {
			await expect(getComputedStyle(bar).backgroundColor).toBe(color);
		} else {
			await expect(getComputedStyle(bar).backgroundColor).not.toBe(color);
		}
	}
}

async function holdMenu(canvasElement: HTMLElement) {
	const button = within(canvasElement).getByTestId("variant-badge");
	await userEvent.pointer({ keys: "[TouchA>]", target: button });
	try {
		return await within(canvasElement.ownerDocument.body).findByTestId(
			"variant-dropdown",
		);
	} finally {
		await userEvent.pointer({ keys: "[/TouchA]", target: button });
	}
}

const meta = {
	title: "Model/ModelVariant",
	component: ModelVariant,
	tags: ["autodocs"],
	parameters: { layout: "centered", docs: { story: { inline: false } } },
	globals: { theme: "dark" },
	args: { onOpen },
	beforeEach: ({ parameters }) => {
		clearDiscoveryState();
		// A draft changes local discovery state without a session or RPC connection.
		sessionState.currentId = null;
		onOpen.mockClear();
		seed();
		const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
		// File-selected Storybook tests can run at desktop width. Pin the phone
		// environment before render rather than relying on toolbar metadata.
		resize(parameters["phone"] ? 393 : 1024);
		return () => {
			if (width) Object.defineProperty(window, "innerWidth", width);
			else Reflect.deleteProperty(window, "innerWidth");
			window.dispatchEvent(new Event("resize"));
			clearDiscoveryState();
		};
	},
} satisfies Meta<typeof ModelVariant>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId("variant-badge");
		await expect(button).toHaveAttribute("data-variant", "chip");
		await expect(button).toHaveTextContent("Default");
		await assertMeter(button, 4, 0);
	},
};

export const High: Story = {
	beforeEach: () => {
		seed("high");
	},
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId("variant-badge");
		await expect(button).toHaveTextContent("High");
		await assertMeter(button, 4, 3);
	},
};

export const DropdownOpen: Story = {
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByTestId("variant-badge"));
		const menu = await body.findByTestId("variant-dropdown");
		await expect(menu).toBeVisible();
		await expect(menu).toHaveAttribute("role", "menu");
		await expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(5);
		await expect(
			within(menu).getByTestId("variant-option-default"),
		).toHaveAttribute("aria-checked", "true");
		await expect(onOpen).toHaveBeenCalledTimes(1);
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};

export const CtrlShortcut: Story = {
	beforeEach: () => seed("max", fiveLevels),
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId("variant-badge");
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "T",
				ctrlKey: true,
				cancelable: true,
			}),
		);
		await waitFor(() => expect(button).toHaveTextContent("Low"));
		await userEvent.keyboard("{Control>}t{/Control}");
		await waitFor(() => expect(button).toHaveTextContent("Medium"));
		await assertMeter(button, 5, 2);
		await expect(discoveryState.currentVariant).toBe("medium");
		await expect(
			within(canvasElement.ownerDocument.body).queryByTestId(
				"variant-dropdown",
			),
		).not.toBeInTheDocument();
	},
};

export const PhoneTapCycle: Story = {
	parameters: { phone: true },
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId("variant-badge");
		const body = within(canvasElement.ownerDocument.body);
		await expect(button).toHaveAttribute("data-variant", "micro");
		await expect(button).toHaveTextContent("DEF");
		await assertMeter(button, 4, 0);
		for (const [variant, label, filled] of [
			["low", "LOW", 1],
			["medium", "MED", 2],
			["high", "HIGH", 3],
			["max", "MAX", 4],
			["low", "LOW", 1],
		] as const) {
			await userEvent.pointer({ keys: "[TouchA]", target: button });
			await waitFor(() => expect(button).toHaveTextContent(label));
			await expect(discoveryState.currentVariant).toBe(variant);
			await assertMeter(button, 4, filled);
			await expect(
				body.queryByTestId("variant-dropdown"),
			).not.toBeInTheDocument();
		}
		await expect(onOpen).not.toHaveBeenCalled();
	},
};

export const PhoneExtraHigh: Story = {
	parameters: { phone: true },
	beforeEach: () => seed("xhigh", fiveLevels),
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId("variant-badge");
		await expect(button).toHaveTextContent("XHIGH");
		await assertMeter(button, 5, 4);
		await userEvent.pointer({ keys: "[TouchA]", target: button });
		await waitFor(() => expect(button).toHaveTextContent("MAX"));
		await assertMeter(button, 5, 5);
		await userEvent.pointer({ keys: "[TouchA]", target: button });
		await waitFor(() => expect(button).toHaveTextContent("LOW"));
		await assertMeter(button, 5, 1);
	},
};

export const PhoneHoldOptions: Story = {
	parameters: { phone: true },
	tags: ["viewport-capture"],
	beforeEach: () => seed("high", fiveLevels),
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId("variant-badge");
		const body = within(canvasElement.ownerDocument.body);
		const menu = await holdMenu(canvasElement);
		await expect(menu).toBeVisible();
		await expect(button).toHaveAttribute("aria-expanded", "true");
		await expect(button).toHaveAttribute("aria-controls", menu.id);
		await expect(discoveryState.currentVariant).toBe("high");
		const items = within(menu).getAllByRole("menuitemradio");
		await expect(items).toHaveLength(6);
		await expect(items[0]).toHaveTextContent("Default");
		await assertMeter(within(menu).getByTestId("variant-option-default"), 5, 0);
		for (const [index, [variant, name, description]] of (
			[
				["low", "Low", "Quick, light reasoning"],
				["medium", "Medium", "Balanced"],
				["high", "High", "Thinks harder, slower"],
				["xhigh", "Extra high", "Deeper still, for hard problems"],
				["max", "Max", "Most thorough, slowest"],
			] as const
		).entries()) {
			const item = within(menu).getByTestId(`variant-option-${variant}`);
			await expect(item).toHaveTextContent(name);
			await expect(item).toHaveTextContent(description);
			await assertMeter(item, 5, index + 1);
		}
		await expect(
			within(menu).getByTestId("variant-option-high"),
		).toHaveAttribute("aria-checked", "true");
		await userEvent.click(within(menu).getByTestId("variant-option-low"));
		await waitFor(() =>
			expect(body.queryByTestId("variant-dropdown")).not.toBeInTheDocument(),
		);
		await expect(button).toHaveTextContent("LOW");
		const reopened = await holdMenu(canvasElement);
		await userEvent.click(
			within(reopened).getByTestId("variant-option-default"),
		);
		await waitFor(() =>
			expect(body.queryByTestId("variant-dropdown")).not.toBeInTheDocument(),
		);
		await expect(button).toHaveTextContent("DEF");
		await assertMeter(button, 5, 0);
		const defaultMenu = await holdMenu(canvasElement);
		await expect(defaultMenu).toBeVisible();
		await expect(
			within(defaultMenu).getByTestId("variant-option-default"),
		).toHaveAttribute("aria-checked", "true");
	},
};

export const PhoneUnknownLevel: Story = {
	parameters: { phone: true },
	beforeEach: () => seed("beyond-custom", [...fourLevels, "beyond-custom"]),
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId("variant-badge");
		await expect(button).toHaveTextContent("BEYON");
		await assertMeter(button, 5, 5);
		const menu = await holdMenu(canvasElement);
		await expect(
			within(menu).getByTestId("variant-option-beyond-custom"),
		).toHaveTextContent("Custom reasoning effort");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(menu).not.toBeInTheDocument());
	},
};

export const PhoneKeyboard: Story = {
	parameters: { phone: true },
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId("variant-badge");
		button.focus();
		await userEvent.keyboard("{Enter} ");
		await waitFor(() => expect(button).toHaveTextContent("MED"));
		await expect(
			within(canvasElement.ownerDocument.body).queryByTestId(
				"variant-dropdown",
			),
		).not.toBeInTheDocument();
		await userEvent.keyboard("{Control>}t{/Control}");
		await waitFor(() => expect(button).toHaveTextContent("HIGH"));
		await userEvent.keyboard("{Shift>}{F10}{/Shift}");
		const menu = await within(canvasElement.ownerDocument.body).findByTestId(
			"variant-dropdown",
		);
		await expect(menu).toBeVisible();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(menu).not.toBeInTheDocument());
		await expect(button).toHaveFocus();
	},
};

export const PhonePending: Story = {
	parameters: { phone: true },
	beforeEach: () => {
		seed("high");
		const pending = spyOn(effort, "pending", "get").mockReturnValue(true);
		return () => pending.mockRestore();
	},
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByTestId("variant-badge");
		await expect(button).toHaveAttribute("aria-busy", "true");
		await userEvent.pointer({ keys: "[TouchA]", target: button });
		await userEvent.keyboard("{Control>}t{/Control}");
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "T",
				ctrlKey: true,
				cancelable: true,
			}),
		);
		button.focus();
		await userEvent.keyboard("{Shift>}{F10}{/Shift}");
		await expect(discoveryState.currentVariant).toBe("high");
		await expect(button).toHaveTextContent("HIGH");
		await expect(
			within(canvasElement.ownerDocument.body).queryByTestId(
				"variant-dropdown",
			),
		).not.toBeInTheDocument();
		await expect(onOpen).not.toHaveBeenCalled();
	},
};

export const Responsive: Story = {
	parameters: { phone: true },
	beforeEach: () => seed("high"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("variant-badge")).toHaveAttribute(
			"data-variant",
			"micro",
		);
		resize(768);
		await waitFor(() =>
			expect(canvas.getByTestId("variant-badge")).toHaveAttribute(
				"data-variant",
				"chip",
			),
		);
		await expect(canvas.getByTestId("variant-badge")).toHaveTextContent("High");
		resize(767);
		await waitFor(() =>
			expect(canvas.getByTestId("variant-badge")).toHaveAttribute(
				"data-variant",
				"micro",
			),
		);
		await expect(canvas.getByTestId("variant-badge")).toHaveTextContent("HIGH");
		await assertMeter(canvas.getByTestId("variant-badge"), 4, 3);
	},
};

export const DefaultLight: Story = { ...Default, globals: { theme: "light" } };
export const DropdownOpenLight: Story = {
	...DropdownOpen,
	// Storybook reads tags statically; a spread does not carry them.
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
export const PhoneTapCycleLight: Story = {
	...PhoneTapCycle,
	globals: { theme: "light" },
};
export const PhoneHoldOptionsLight: Story = {
	...PhoneHoldOptions,
	// Storybook reads tags statically; a spread does not carry them.
	tags: ["viewport-capture"],
	globals: { theme: "light" },
};
