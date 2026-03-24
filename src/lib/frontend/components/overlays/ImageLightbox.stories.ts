import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { uiState } from "../../stores/ui.svelte.js";
import ImageLightbox from "./ImageLightbox.svelte";

const meta = {
	title: "Overlays/ImageLightbox",
	component: ImageLightbox,
	tags: ["autodocs"],
	beforeEach: () => {
		uiState.lightboxSrc = null;
	},
} satisfies Meta<typeof ImageLightbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithImage: Story = {
	beforeEach: () => {
		uiState.lightboxSrc = "https://picsum.photos/seed/opencode/800/600";
	},
};

export const Hidden: Story = {
	beforeEach: () => {
		uiState.lightboxSrc = null;
	},
};
