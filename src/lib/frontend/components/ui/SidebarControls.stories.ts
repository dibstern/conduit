import type { Meta, StoryObj } from "@storybook/svelte-vite";
import SidebarControlsGallery from "./__fixtures__/SidebarControlsGallery.svelte";

const meta = {
	title: "UI/SidebarControls",
	component: SidebarControlsGallery,
	parameters: { layout: "centered" },
} satisfies Meta<typeof SidebarControlsGallery>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Final: Story = {};
export const FinalLight: Story = { globals: { theme: "light" } };
