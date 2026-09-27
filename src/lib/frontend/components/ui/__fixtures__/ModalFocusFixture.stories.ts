import type { Meta, StoryObj } from "@storybook/svelte-vite";
import ModalFocusFixture from "./ModalFocusFixture.svelte";

const meta = {
	title: "Fixtures/ModalFocus",
	component: ModalFocusFixture,
} satisfies Meta<typeof ModalFocusFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
