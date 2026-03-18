import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { uiState } from "../../stores/ui.svelte.js";
import ImageLightbox from "./ImageLightbox.svelte";

const meta = {
	title: "Overlays/ImageLightbox",
	component: ImageLightbox,
} satisfies Meta<ImageLightbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithImage: Story = {
	play: () => {
		uiState.lightboxSrc = "https://picsum.photos/seed/opencode/800/600";
	},
};

export const Hidden: Story = {
	play: () => {
		uiState.lightboxSrc = null;
	},
};
