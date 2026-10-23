import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, within } from "storybook/test";
import type { PendingAttachment } from "../../types.js";
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

const firstMockImage: PendingAttachment = {
	id: "img-1",
	dataUrl: RED_PIXEL,
	name: "screenshot.png",
	size: 24576,
};

const mockImages: PendingAttachment[] = [
	firstMockImage,
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
		images: [firstMockImage],
		onRemove: (id: string) => console.log("Remove image:", id),
	},
};

export const Empty: Story = {
	args: {
		images: [],
		onRemove: (id: string) => console.log("Remove image:", id),
	},
};

export const WithFiles: Story = {
	args: {
		images: [
			{
				id: "text-file",
				name: "notes.txt",
				size: 34,
				dataUrl: "data:text/plain;name=notes.txt;base64,bm90ZXM=",
			},
			{
				id: "pdf-file",
				name: "guide.pdf",
				size: 601,
				dataUrl: "data:application/pdf;name=guide.pdf;base64,JVBERi0xLjQ=",
			},
		],
		onRemove: fn(),
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getAllByTestId("file-attachment-chip")).toHaveLength(2);
		await expect(
			canvas.getByRole("button", { name: "Remove file notes.txt" }),
		).toBeVisible();
		await expect(
			canvas.getByRole("button", { name: "Remove file guide.pdf" }),
		).toBeVisible();
	},
};

export const MixedAttachments: Story = {
	args: {
		images: [
			firstMockImage,
			...(WithFiles.args?.["images"] ?? []),
			{
				id: "long-name",
				name: "2026-10-quarterly-infrastructure-review-notes.md",
				size: 18_432,
				dataUrl:
					"data:text/plain;name=2026-10-quarterly-infrastructure-review-notes.md;base64,bm90ZXM=",
			},
		],
		onRemove: fn(),
	},
	play: async ({ canvasElement }) => {
		for (const attachment of canvasElement.querySelectorAll(
			".paste-thumb, [data-testid='file-attachment-chip']",
		)) {
			await expect(getComputedStyle(attachment).borderWidth).toBe("0px");
			await expect(getComputedStyle(attachment).backgroundColor).not.toBe(
				"rgba(0, 0, 0, 0)",
			);
		}
		await expect(
			canvasElement.querySelectorAll(
				".paste-thumb, [data-testid='file-attachment-chip']",
			),
		).toHaveLength(4);
	},
};

export const Hover: Story = {
	...WithImages,
	parameters: { pseudo: { hover: true } },
};
