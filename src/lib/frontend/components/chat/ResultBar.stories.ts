import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	mockResultExpensive,
	mockResultFull,
	mockResultMinimal,
	mockResultNoCost,
} from "../../stories/mocks.js";
import ResultBar from "./ResultBar.svelte";

const meta = {
	title: "Chat/ResultBar",
	component: ResultBar,
	tags: ["autodocs"],
} satisfies Meta<typeof ResultBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Full: Story = {
	args: { message: mockResultFull },
};

export const NoCost: Story = {
	args: { message: mockResultNoCost },
};

export const Minimal: Story = {
	args: { message: mockResultMinimal },
};

export const Expensive: Story = {
	args: { message: mockResultExpensive },
};
