import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect } from "storybook/test";
import SessionStatusGlyph from "./SessionStatusGlyph.svelte";

const meta = {
	title: "UI/SessionStatusGlyph",
	component: SessionStatusGlyph,
	tags: ["autodocs"],
	parameters: { layout: "centered" },
	args: { attention: "working", animate: true },
	play: async ({ canvasElement, args }) => {
		const variant =
			args["attention"] === "done-unread"
				? "unread"
				: args["attention"] === "working" || args["attention"] === "monitoring"
					? "running"
					: "idle";
		const glyph = canvasElement.querySelector(`[data-flow-glyph="${variant}"]`);
		await expect(glyph).toBeInTheDocument();
		if (!glyph) return;
		await expect(glyph.getBoundingClientRect().width).toBe(16);
		await expect(glyph.getBoundingClientRect().height).toBe(16);
		const packet = glyph.querySelector("[data-flow-packet]");
		if (variant === "running") {
			const expected = new Option().style;
			expected.color = getComputedStyle(glyph).getPropertyValue(
				args["attention"] === "monitoring"
					? "--color-status-goal"
					: "--color-accent",
			);
			await expect(getComputedStyle(glyph).color).toBe(expected.color);
			await expect(packet).toBeInTheDocument();
			if (!packet) return;
			await expect(packet).toHaveAttribute("pathLength", "100");
			await expect(packet).toHaveAttribute("stroke-dasharray", "30 100");
			const style = getComputedStyle(packet);
			if (
				!args["animate"] ||
				matchMedia("(prefers-reduced-motion: reduce)").matches
			) {
				await expect(style.animationName).toBe("none");
				await expect(style.strokeDashoffset).toBe("-30px");
			} else {
				await expect(style.animationName).toContain("flow");
				await expect(style.animationDuration).toBe("1.4s");
				await expect(style.animationTimingFunction).toBe(
					"cubic-bezier(0.45, 0, 0.55, 1)",
				);
			}
		} else {
			await expect(packet).toBeNull();
			await expect(glyph.getAnimations({ subtree: true })).toHaveLength(0);
		}
		if (variant === "unread") {
			await expect(glyph).toHaveAttribute("data-testid", "session-unread-dot");
		}
	},
} satisfies Meta<typeof SessionStatusGlyph>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {};
export const Monitoring: Story = { args: { attention: "monitoring" } };
export const Unread: Story = { args: { attention: "done-unread" } };
export const Idle: Story = { args: { attention: "idle" } };
export const RunningHeader: Story = { args: { animate: false } };
