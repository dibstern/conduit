import type { Meta, StoryObj } from "@storybook/svelte-vite";
import type { PendingImage } from "../../types.js";
import PastePreview from "./PastePreview.svelte";

const meta = {
	title: "Chat/PastePreview",
	component: PastePreview,
	tags: ["autodocs"],
} satisfies Meta<typeof PastePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

// A tiny 1x1 red PNG as base64 for mock thumbnails
const RED_PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
// A tiny 1x1 blue PNG
const BLUE_PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==";
// A tiny 1x1 green PNG
const GREEN_PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const mockImages: PendingImage[] = [
	{
		id: "img-1",
		dataUrl: RED_PIXEL,
		name: "screenshot.png",
		size: 24576,
	},
	{
		id: "img-2",
		dataUrl: BLUE_PIXEL,
		name: "diagram-architecture-overview.png",
		size: 102400,
	},
	{
		id: "img-3",
		dataUrl: GREEN_PIXEL,
		name: "photo.jpg",
		size: 512000,
	},
];

export const WithImages: Story = {
	args: {
		images: mockImages,
		onRemove: (id: string) => console.log("Remove image:", id),
	},
};

export const SingleImage: Story = {
	args: {
		images: [mockImages[0]],
		onRemove: (id: string) => console.log("Remove image:", id),
	},
};

export const Empty: Story = {
	args: {
		images: [],
		onRemove: (id: string) => console.log("Remove image:", id),
	},
};
