import type { Meta, StoryObj } from "@storybook/svelte-vite";
import FocusTrapFixture from "./FocusTrapFixture.svelte";

const meta = {
	title: "Actions/FocusTrap",
	component: FocusTrapFixture,
} satisfies Meta<typeof FocusTrapFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
