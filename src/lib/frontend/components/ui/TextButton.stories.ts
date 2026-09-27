import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect } from "storybook/test";
import { createRawSnippet } from "svelte";
import TextButton from "./TextButton.svelte";

/** Pass a plain text label as TextButton's `children` snippet from a .stories.ts. */
const label = (text: string) =>
	createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));

const meta = {
	title: "UI/TextButton",
	component: TextButton,
	tags: ["autodocs"],
	args: { children: label("Text button") },
	argTypes: {
		tone: { control: "inline-radio", options: ["muted", "dimmer", "accent"] },
		underline: {
			control: "inline-radio",
			options: ["none", "hover", "always"],
		},
		disabled: { control: "boolean" },
	},
} satisfies Meta<typeof TextButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Muted: Story = {
	args: { tone: "muted", children: label("Hide all") },
};

export const Dimmer: Story = {
	args: { tone: "dimmer", children: label("Deselect all") },
};

export const Accent: Story = {
	args: { tone: "accent", children: label("Scan Now") },
};

export const UnderlinedLink: Story = {
	args: {
		tone: "accent",
		underline: "always",
		children: label("Open session"),
	},
};

/**
 * The guard, not decoration. TextButton must never emit two utilities from the
 * same Tailwind group, because which one wins is decided by stylesheet emission
 * order rather than by anything visible at the call site (conduit-test-ixfu).
 *
 * It also asserts the three groups BASE deliberately leaves unclaimed — display,
 * padding and transition — stay unclaimed, so a call site can always pass its
 * own without a fight.
 */
export const NoCollidingUtilities: Story = {
	args: {
		tone: "muted",
		class: "px-1 py-0.5 flex transition-opacity",
		children: label("Guarded"),
	},
	play: ({ canvasElement }) => {
		const passed = ["px-1", "py-0.5", "flex", "transition-opacity"];
		const emitted = (canvasElement.querySelector("button")?.className ?? "")
			.split(/\s+/)
			.filter((c) => c && !passed.includes(c));

		expect(
			emitted.filter((c) => c.startsWith("text-")),
			"exactly one resting text colour — two collide on stylesheet order",
		).toEqual(["text-text-muted"]);

		expect(
			emitted.filter((c) =>
				/^(p|px|py|pt|pb|pl|pr)-|^transition|^(inline-)?(flex|block|grid)$/.test(
					c,
				),
			),
			"BASE must leave padding, display and transition unclaimed for the call site",
		).toEqual([]);
	},
};

/**
 * Disabled drops the hover step entirely rather than trying to out-specify it.
 * A CSS-only suppression would need a second utility in the same group, and the
 * winner is decided by emission order — the bug conduit-test-or29 was filed for.
 */
export const DisabledDropsHover: Story = {
	args: { tone: "accent", disabled: true, children: label("Scanning...") },
	play: ({ canvasElement }) => {
		const classes = canvasElement.querySelector("button")?.className ?? "";
		expect(classes).toContain("text-accent");
		expect(
			classes,
			"a disabled control must not light up under the cursor",
		).not.toContain("hover:text-accent");
	},
};
