import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { tick } from "svelte";
import MicroLabelButtonDemo from "./__fixtures__/MicroLabelButtonDemo.svelte";
import { hold } from "./actions/hold.js";

const onTap = fn<(event: MouseEvent) => void>();
const onHold = fn<() => void>();

/** The pulse is a script animation; ignore hover colour transitions. */
const pulses = (node: Element) =>
	node
		.getAnimations()
		.filter((animation) => !(animation instanceof CSSTransition));

const meta = {
	title: "UI/MicroLabelButton",
	component: MicroLabelButtonDemo,
	tags: ["autodocs"],
	parameters: {
		layout: "centered",
		a11y: { test: "error" },
		docs: {
			description: {
				component:
					"Activate with Enter/Space or a tap. Hold for 450ms, press Shift+F10, or press the ContextMenu key to open options. Accessible names describe the current value and both actions.",
			},
		},
	},
	args: {
		label: "ASK",
		accessibleName: "Approvals Ask. Activate to cycle; Shift+F10 opens options",
		onTap,
		onHold,
		"data-testid": "micro-label-button",
	},
	argTypes: {
		label: { control: "text" },
		variant: { control: "inline-radio", options: ["micro", "chip", "words"] },
		accessibleName: { control: "text" },
		tone: { control: "text" },
		tinted: { control: "boolean" },
		pending: { control: "boolean" },
		pulseKey: { control: "text" },
		glyph: { control: "inline-radio", options: ["shield", "effort", "none"] },
		levels: { control: { type: "number", min: 1, max: 8, step: 1 } },
		filled: { control: { type: "number", min: 0, max: 8, step: 1 } },
		pulseOnTap: { control: "boolean" },
	},
	beforeEach: () => {
		onTap.mockClear();
		onHold.mockClear();
	},
} satisfies Meta<typeof MicroLabelButtonDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Words: Story = {
	tags: ["autodocs"],
	args: { variant: "words", glyph: "none", label: "ask" },
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole("button", { name: args["accessibleName"] });
		const label = canvas.getByText("ask");
		await expect(button.querySelector(".glyph")).toBeNull();
		await expect(getComputedStyle(label).fontSize).toBe("11.5px");
		await expect(getComputedStyle(label).borderBottomStyle).toBe("dotted");
		await userEvent.click(button);
		await expect(onTap).toHaveBeenCalledTimes(1);
		button.focus();
		await userEvent.keyboard("{Shift>}{F10}{/Shift}");
		await expect(onHold).toHaveBeenCalledTimes(1);
	},
};

export const WordsLight: Story = {
	...Words,
	tags: ["autodocs"],
	globals: { theme: "light" },
};

const pointer = (
	node: HTMLElement,
	type: string,
	options: PointerEventInit = {},
) =>
	node.dispatchEvent(
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			pointerId: 1,
			isPrimary: true,
			pointerType: "touch",
			button: 0,
			clientX: 16,
			clientY: 16,
			...options,
		}),
	);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const Default: Story = {
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole("button", { name: args["accessibleName"] });
		const style = getComputedStyle(button);
		const labelStyle = getComputedStyle(canvas.getByText(args["label"]));
		await expect(button).toHaveAttribute("data-testid", "micro-label-button");
		await expect(style.height).toBe("32px");
		await expect(style.minWidth).toBe("32px");
		await expect(style.paddingLeft).toBe("2px");
		await expect(style.paddingRight).toBe("2px");
		await expect(style.rowGap).toBe("1px");
		await expect(labelStyle.fontSize).toBe("7.5px");
		await expect(labelStyle.fontWeight).toBe("700");
		await expect(labelStyle.textTransform).toBe("uppercase");
		await expect(Number.parseFloat(labelStyle.letterSpacing)).toBeCloseTo(
			0.225,
		);
		await expect(
			button.querySelector("svg")?.getBoundingClientRect().height,
		).toBe(15);
	},
};

export const Chip: Story = {
	args: {
		variant: "chip",
		label: "Full access",
		accessibleName:
			"Approvals Full access. Activate to cycle; Shift+F10 opens options",
		tone: "var(--color-warning)",
		tinted: true,
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole("button", { name: args["accessibleName"] });
		const label = canvas.getByText(args["label"]);
		const glyph = button.querySelector(".glyph") as HTMLElement;
		const style = getComputedStyle(button);
		const labelStyle = getComputedStyle(label);
		await expect(style.height).toBe("32px");
		await expect(style.flexDirection).toBe("row");
		await expect(style.paddingLeft).toBe("9px");
		await expect(style.paddingRight).toBe("9px");
		await expect(style.columnGap).toBe("6px");
		await expect(style.borderRadius).toBe("10px");
		await expect(labelStyle.fontSize).toBe("12px");
		await expect(labelStyle.fontWeight).toBe("600");
		await expect(labelStyle.fontFamily).toContain("Chakra Petch");
		await expect(labelStyle.textTransform).toBe("none");
		await expect(labelStyle.letterSpacing).toBe("normal");
		await expect(labelStyle.color).toBe(style.color);
		await expect(getComputedStyle(glyph).color).toBe(style.color);
		await expect(style.backgroundColor).toContain("/ 0.14");
		await expect(
			label.getBoundingClientRect().left - glyph.getBoundingClientRect().right,
		).toBeCloseTo(6);
		await expect(
			button.querySelector("svg")?.getBoundingClientRect().height,
		).toBe(15);
		await userEvent.click(button);
		await expect(args["onTap"]).toHaveBeenCalledTimes(1);
		button.focus();
		await userEvent.keyboard("{Shift>}{F10}{/Shift}");
		await expect(args["onHold"]).toHaveBeenCalledTimes(1);
	},
};

export const Tinted: Story = {
	args: {
		label: "FULL",
		accessibleName:
			"Approvals Full access. Activate to cycle; Shift+F10 opens options",
		tone: "var(--color-warning)",
		tinted: true,
	},
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByRole("button");
		await expect(getComputedStyle(button).backgroundColor).toContain("/ 0.14");
		await expect(
			getComputedStyle(button.querySelector("svg") as SVGElement).color,
		).toBe(getComputedStyle(button).color);
	},
};

export const Pending: Story = {
	args: { pending: true, tinted: true },
	play: async ({ canvasElement, args }) => {
		const button = within(canvasElement).getByRole("button");
		await expect(getComputedStyle(button).opacity).toBe("0.5");
		await expect(button).toHaveAttribute("aria-busy", "true");
		await expect(button).not.toBeDisabled();
		button.focus();
		await expect(button).toHaveFocus();
		await userEvent.click(button);
		pointer(button, "pointerdown");
		await pause(500);
		pointer(button, "pointerup");
		button.click();
		await expect(args["onTap"]).not.toHaveBeenCalled();
		await expect(args["onHold"]).not.toHaveBeenCalled();
		const form = canvasElement.ownerDocument.createElement("form");
		form.id = "micro-label-pending-form";
		const formAction = fn((event: Event) => event.preventDefault());
		form.addEventListener("submit", formAction);
		form.addEventListener("reset", formAction);
		canvasElement.append(form);
		button.setAttribute("form", form.id);
		try {
			for (const type of ["submit", "reset"]) {
				button.setAttribute("type", type);
				await userEvent.click(button);
			}
			await expect(formAction).not.toHaveBeenCalled();
		} finally {
			button.setAttribute("type", "button");
			button.removeAttribute("form");
			form.remove();
		}
	},
};

export const Pulse: Story = {
	args: { pulseOnTap: true },
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByRole("button");
		await expect(pulses(button)).toHaveLength(0);
		for (let i = 0; i < 2; i += 1) {
			await userEvent.click(button);
			await tick();
			if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
				await expect(pulses(button)).toHaveLength(0);
				continue;
			}
			await waitFor(() => expect(pulses(button)).toHaveLength(1));
			const animation = pulses(button)[0];
			await expect(animation?.effect?.getComputedTiming().duration).toBe(240);
			await expect(
				(animation?.effect as KeyframeEffect).getKeyframes()[1]?.["transform"],
			).toBe("scale(1.14)");
			await animation?.finished;
		}
	},
};

export const LongLabel: Story = {
	args: {
		label: "XHIGH",
		accessibleName:
			"Effort Extra high. Activate to cycle; Shift+F10 opens options",
		glyph: "effort",
		filled: 5,
	},
	play: async ({ canvasElement }) => {
		const button = within(canvasElement).getByRole("button");
		await expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(
			32,
		);
		await expect(button.getBoundingClientRect().width).toBeLessThanOrEqual(34);
	},
};

export const EffortDefault: Story = {
	args: {
		glyph: "effort",
		label: "AUTO",
		accessibleName:
			"Effort Provider default. Activate to cycle; Shift+F10 opens options",
		filled: 0,
		levels: 5,
	},
	play: async ({ canvasElement, args }) => {
		const button = within(canvasElement).getByRole("button");
		const meter = button.querySelector(".effort-meter") as HTMLElement;
		const bars = [...meter.children];
		await expect(bars).toHaveLength(args["levels"] ?? 5);
		await expect(getComputedStyle(meter).gap).toBe("2px");
		for (const [index, bar] of bars.entries()) {
			const style = getComputedStyle(bar);
			await expect(style.width).toBe("2.5px");
			await expect(Number.parseFloat(style.height)).toBeCloseTo(
				4 + (9 * index) / Math.max(1, bars.length - 1),
				1,
			);
			await expect(
				style.backgroundColor === getComputedStyle(button).color,
			).toBe(index < (args["filled"] ?? 0));
		}
	},
};

export const EffortThree: Story = {
	...EffortDefault,
	args: {
		...EffortDefault.args,
		label: "HIGH",
		accessibleName: "Effort High. Activate to cycle; Shift+F10 opens options",
		filled: 3,
	},
};

export const EffortFive: Story = {
	...EffortDefault,
	args: {
		...EffortDefault.args,
		label: "MAX",
		accessibleName:
			"Effort Maximum. Activate to cycle; Shift+F10 opens options",
		filled: 5,
	},
};

export const EffortOne: Story = {
	...EffortDefault,
	args: {
		...EffortDefault.args,
		label: "MIN",
		accessibleName:
			"Effort Minimum. Activate to cycle; Shift+F10 opens options",
		levels: 1,
		filled: 1,
	},
};

export const EffortEight: Story = {
	...EffortDefault,
	args: {
		...EffortDefault.args,
		label: "MAX",
		accessibleName:
			"Effort Maximum. Activate to cycle; Shift+F10 opens options",
		levels: 8,
		filled: 8,
	},
};

export const HoldAndTap: Story = {
	play: async ({ canvasElement, args }) => {
		const button = within(canvasElement).getByRole("button");
		pointer(button, "pointerdown");
		await pause(500);
		pointer(button, "pointerup");
		button.click();
		await expect(args["onHold"]).toHaveBeenCalledTimes(1);
		await expect(args["onTap"]).not.toHaveBeenCalled();
		pointer(button, "pointerdown");
		pointer(button, "pointerup");
		button.click();
		await pause(500);
		await expect(args["onTap"]).toHaveBeenCalledTimes(1);
		await expect(args["onHold"]).toHaveBeenCalledTimes(1);
	},
};

export const CancelledHold: Story = {
	play: async ({ canvasElement, args }) => {
		const button = within(canvasElement).getByRole("button");
		for (const type of ["pointermove", "pointercancel", "pointerup"]) {
			pointer(button, "pointerdown");
			pointer(canvasElement.ownerDocument.body, type, { clientX: 25 });
			await pause(500);
		}
		await expect(args["onHold"]).not.toHaveBeenCalled();
	},
};

export const Keyboard: Story = {
	play: async ({ canvasElement, args }) => {
		const button = within(canvasElement).getByRole("button");
		button.focus();
		await userEvent.keyboard("{Enter} ");
		await expect(args["onTap"]).toHaveBeenCalledTimes(2);
		await expect(args["onHold"]).not.toHaveBeenCalled();
		await userEvent.keyboard("{Shift>}{F10}{/Shift}{ContextMenu}");
		await expect(args["onHold"]).toHaveBeenCalledTimes(2);
		await expect(args["onTap"]).toHaveBeenCalledTimes(2);
	},
};

export const HoldLifecycle: Story = {
	play: async ({ canvasElement }) => {
		const node = canvasElement.ownerDocument.createElement("button");
		node.style.setProperty("user-select", "text");
		canvasElement.append(node);
		const oldHold = fn();
		const newHold = fn();
		const action = hold(node, { onHold: oldHold, ms: 40 });
		try {
			await expect(node.style.userSelect).toBe("none");
			pointer(node, "pointerdown");
			action.update({ onHold: newHold, ms: 80 });
			await pause(100);
			await expect(oldHold).not.toHaveBeenCalled();
			await expect(newHold).not.toHaveBeenCalled();
			pointer(node, "pointerdown");
			await pause(100);
			await expect(newHold).toHaveBeenCalledTimes(1);
			pointer(node, "pointerup");
			await expect(pointer(node, "contextmenu")).toBe(false);
			await expect(pointer(node, "contextmenu", { pointerType: "mouse" })).toBe(
				true,
			);
			node.click();
			pointer(node, "pointerdown");
			action.destroy();
			await pause(100);
			await expect(newHold).toHaveBeenCalledTimes(1);
			await expect(node.style.userSelect).toBe("text");
			await expect(pointer(node, "contextmenu")).toBe(true);
		} finally {
			action.destroy();
			node.remove();
		}
	},
};

export const ReducedMotion: Story = {
	args: { pulseOnTap: true },
	play: async ({ canvasElement }) => {
		const original = window.matchMedia;
		window.matchMedia = (query) => {
			const result = original.call(window, query);
			if (query === "(prefers-reduced-motion: reduce)") {
				Object.defineProperty(result, "matches", { value: true });
			}
			return result;
		};
		try {
			const button = within(canvasElement).getByRole("button");
			await userEvent.click(button);
			await tick();
			await expect(pulses(button)).toHaveLength(0);
		} finally {
			window.matchMedia = original;
		}
	},
};

export const DefaultLight: Story = { ...Default, globals: { theme: "light" } };
export const ChipLight: Story = { ...Chip, globals: { theme: "light" } };
export const TintedLight: Story = { ...Tinted, globals: { theme: "light" } };
export const PendingLight: Story = { ...Pending, globals: { theme: "light" } };
export const PulseLight: Story = { ...Pulse, globals: { theme: "light" } };
export const LongLabelLight: Story = {
	...LongLabel,
	globals: { theme: "light" },
};
export const EffortDefaultLight: Story = {
	...EffortDefault,
	globals: { theme: "light" },
};
export const EffortThreeLight: Story = {
	...EffortThree,
	globals: { theme: "light" },
};
export const EffortFiveLight: Story = {
	...EffortFive,
	globals: { theme: "light" },
};
export const HoldAndTapLight: Story = {
	...HoldAndTap,
	globals: { theme: "light" },
};
export const KeyboardLight: Story = {
	...Keyboard,
	globals: { theme: "light" },
};
