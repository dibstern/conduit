import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect } from "storybook/test";
import ConduitLogo from "./ConduitLogo.svelte";

const meta = {
	title: "UI/ConduitLogo",
	component: ConduitLogo,
	tags: ["autodocs"],
	argTypes: {
		size: {
			control: "select",
			options: ["standard", "loading", "sidebar", "inline"],
		},
		animated: { control: "boolean" },
		showText: { control: "boolean" },
	},
	play: async ({ canvasElement, args }) => {
		const hero = canvasElement.querySelector("[data-flow-hero]");
		await expect(hero).toBeInTheDocument();
		if (!hero) return;
		await expect(hero.querySelectorAll("[data-conduit-mark]")).toHaveLength(1);
		const ripples = hero.querySelectorAll("[data-flow-ripple]");
		const sparkles = hero.querySelectorAll("[data-flow-sparkle]");
		await expect(ripples).toHaveLength(2);
		await expect(sparkles).toHaveLength(3);
		await expect(hero.querySelectorAll("[data-flow-packet]")).toHaveLength(
			args["animated"] ? 1 : 0,
		);
		const moving =
			args["animated"] &&
			!matchMedia("(prefers-reduced-motion: reduce)").matches;
		for (const ripple of ripples) {
			const style = getComputedStyle(ripple);
			if (moving) {
				await expect(style.animationName).toContain("ripple");
				await expect(style.animationDuration).toBe("2.4s");
			} else {
				await expect(style.animationName).toBe("none");
			}
		}
		for (const sparkle of sparkles) {
			const style = getComputedStyle(sparkle);
			if (moving) {
				await expect(style.animationName).toContain("twinkle");
				await expect(style.animationDuration).toBe("1.8s");
			} else {
				await expect(style.animationName).toBe("none");
			}
		}
	},
} satisfies Meta<typeof ConduitLogo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Standard: Story = { args: { size: "standard", showText: true } };
export const Loading: Story = {
	args: { size: "loading", animated: true, showText: true },
};
export const Sidebar: Story = { args: { size: "sidebar", showText: true } };
export const InlineSpinner: Story = {
	args: { size: "inline", animated: true, showText: false },
};
export const StandardAnimated: Story = {
	args: { size: "standard", animated: true, showText: true },
};
