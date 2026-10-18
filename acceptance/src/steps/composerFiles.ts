import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const files = [
	{ name: "notes.txt", mimeType: "text/plain" },
	{ name: "guide.pdf", mimeType: "application/pdf" },
].map((file) => ({
	...file,
	buffer: readFileSync(
		new URL(`../../../test/fixtures/attachments/${file.name}`, import.meta.url),
	),
}));

export const composerFilesHandlers: StepHandler[] = [
	{
		name: "select files on unsupported harness",
		match: /^I select Add Files on the unsupported harness$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("menuitem", { name: "Add Files", exact: true })
				.click();
		},
	},
	{
		name: "assert unsupported harness explanation",
		match: /^the composer explains which harnesses support file attachments$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("attachment-error")).toContainText(
				"File attachments are available with Claude and OpenCode",
			);
			await expect(world.page.getByTestId("file-attachment-chip")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "assert Add Files menu order",
		match: /^Add Files follows Add Photos in the attach menu$/,
		run: async ({ world }) => {
			const entries = world.page
				.getByTestId("attach-menu")
				.getByRole("menuitem");
			await expect(entries.nth(1)).toHaveText("Add Photos");
			await expect(entries.nth(2)).toHaveText("Add Files");
		},
	},
	{
		name: "choose composer files",
		match: /^I choose the text and PDF attachments$/,
		run: async ({ world }) => {
			const chooser = world.page.waitForEvent("filechooser");
			await world.page
				.getByRole("menuitem", { name: "Add Files", exact: true })
				.click();
			await (await chooser).setFiles(files);
			await expect(world.page.getByTestId("file-attachment-chip")).toHaveCount(
				2,
			);
		},
	},
	{
		name: "assert file chips",
		match:
			/^the composer shows removable file chips for notes.txt and guide.pdf$/,
		run: async ({ world }) => {
			const chips = world.page.getByTestId("file-attachment-chip");
			await expect(chips).toHaveCount(2);
			for (const file of files) {
				const chip = chips.filter({ hasText: file.name });
				await expect(chip).toBeVisible();
				await expect(
					chip.getByRole("button", { name: `Remove file ${file.name}` }),
				).toBeVisible();
				const box = await chip.boundingBox();
				const viewport = world.page.viewportSize();
				if (!box || !viewport)
					throw new Error("Attachment chip has no viewport bounds");
				expect(box.x).toBeGreaterThanOrEqual(0);
				expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
			}
		},
	},
	{
		name: "assert attachment RPC payload",
		match:
			/^the composer submits both files with their original bytes and names$/,
		run: async ({ world }) => {
			const request = await requireRpcControl(world.page).waitForRequest(
				(entry) => entry.tag === "input.submit",
			);
			expect(request.payload["images"]).toEqual(
				files.map(
					(file) =>
						`data:${file.mimeType};name=${file.name};base64,${file.buffer.toString("base64")}`,
				),
			);
		},
	},
	{
		name: "assert cleared file chips",
		match: /^the composer file chips are cleared$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("file-attachment-chip")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "remove composer file",
		match: /^I remove the notes.txt attachment$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: "Remove file notes.txt" })
				.click();
		},
	},
	{
		name: "assert remaining file",
		match: /^only the guide.pdf file chip remains$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("file-attachment-chip")).toHaveCount(
				1,
			);
			await expect(
				world.page.getByTestId("file-attachment-chip"),
			).toContainText("guide.pdf");
		},
	},
	{
		name: "choose unsupported composer file",
		match: /^I choose an unsupported binary attachment$/,
		run: async ({ world }) => {
			const chooser = world.page.waitForEvent("filechooser");
			await world.page
				.getByRole("menuitem", { name: "Add Files", exact: true })
				.click();
			await (await chooser).setFiles([
				{
					name: "archive.zip",
					mimeType: "application/zip",
					buffer: Buffer.from([0x50, 0x4b, 0, 0]),
				},
			]);
		},
	},
	{
		name: "assert inline attachment error",
		match: /^the composer reports that archive.zip cannot be attached$/,
		run: async ({ world }) => {
			const error = world.page.getByTestId("attachment-error");
			await expect(error).toHaveAttribute("role", "alert");
			await expect(error).toContainText("archive.zip");
			await expect(error).toContainText("plain text");
			await expect(error).toContainText("PDF");
		},
	},
];
