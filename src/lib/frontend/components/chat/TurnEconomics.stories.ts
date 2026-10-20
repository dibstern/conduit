import type { Meta, StoryObj } from "@storybook/svelte-vite";
import TurnEconomics from "./TurnEconomics.svelte";

const meta = {
	title: "Chat/Turn Economics",
	component: TurnEconomics,
	parameters: { layout: "padded" },
	args: {
		economics: {
			cost: 0.0244,
			tokensIn: 12400,
			tokensOut: 3800,
			context: { used: 64000, window: 200000, pct: 32 },
		},
	},
} satisfies Meta<typeof TurnEconomics>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const UnknownUsage: Story = {
	args: { economics: { duration: 728000 }, showDuration: true },
};
