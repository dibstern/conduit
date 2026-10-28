import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type JSHandle, type Page } from "@playwright/test";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

const imageName = "drop-preview.png";
const imageBytes = readFileSync(
	new URL(
		"../../../test/fixtures/attachments/drop-preview.png",
		import.meta.url,
	),
);
const imageDataUrl = `data:image/png;name=${imageName};base64,${imageBytes.toString("base64")}`;
const imageHash = createHash("sha256")
	.update("image/png")
	.update(Buffer.from([0]))
	.update(imageBytes)
	.digest("hex");
const drops = new WeakMap<
	Page,
	{ url: string; document: JSHandle<Document> }
>();
const lightboxSources = new WeakMap<Page, string>();

export const composerImageDropAndViewHandlers: StepHandler[] = [
	{
		name: "drop real files outside the composer",
		match:
			/^I drop a PNG( and a text file)? onto the page outside the composer$/,
		run: async ({ world, match }) => {
			const page = world.page;
			drops.set(page, {
				url: page.url(),
				document: await page.evaluateHandle(() => document),
			});
			const transfer = await page.evaluateHandle(
				({ base64, name, includeText }) => {
					const data = new DataTransfer();
					const bytes = Uint8Array.from(atob(base64), (char) =>
						char.charCodeAt(0),
					);
					data.items.add(new File([bytes], name, { type: "image/png" }));
					if (includeText)
						data.items.add(
							new File(["Dropped notes"], "notes.txt", { type: "text/plain" }),
						);
					return data;
				},
				{
					base64: imageBytes.toString("base64"),
					name: imageName,
					includeText: !!match[1],
				},
			);
			try {
				expect(await transfer.evaluate((data) => [...data.types])).toContain(
					"Files",
				);
				// A transcript drop bubbles to window, away from the input's own handlers.
				const cancelled = await page
					.locator("#messages")
					.evaluate((target, dataTransfer) => {
						const cancelled: string[] = [];
						for (const type of ["dragenter", "dragover", "drop"]) {
							const event = new DragEvent(type, {
								bubbles: true,
								cancelable: true,
								dataTransfer,
							});
							if (!target.dispatchEvent(event)) cancelled.push(type);
						}
						return cancelled;
					}, transfer);
				expect(cancelled).toEqual(expect.arrayContaining(["dragover", "drop"]));
			} finally {
				await transfer.dispose();
			}
		},
	},
	{
		name: "assert dropped PNG thumbnail",
		match: /^the composer shows the dropped PNG thumbnail$/,
		run: async ({ world }) => {
			const draft = world.page.getByTestId("draft-attachment");
			await expect(draft).toHaveCount(1);
			const image = draft
				.getByRole("button", { name: `View image ${imageName}`, exact: true })
				.locator("img");
			await expect(image).toBeVisible();
			await expect(image).toHaveAttribute(
				"src",
				new RegExp(`/attachments/${imageHash}$`),
			);
			await expect
				.poll(() =>
					image.evaluate(
						(img: HTMLImageElement) => img.complete && img.naturalWidth === 480,
					),
				)
				.toBe(true);
		},
	},
	{
		name: "assert original PNG attachment RPC and no text attachment",
		match:
			/^the relay receives only the dropped PNG with its original bytes and name$/,
		run: async ({ world }) => {
			const adds = requireRpcControl(world.page)
				.getRequests()
				.filter((request) => request.tag === "AddDraftAttachment");
			expect(adds).toHaveLength(1);
			expect(adds[0]?.payload).toMatchObject({
				name: imageName,
				mime: "image/png",
				dataUrl: imageDataUrl,
			});
		},
	},
	{
		name: "assert drop did not navigate or reload",
		match: /^the file drop keeps the same page open$/,
		run: async ({ world }) => {
			const before = drops.get(world.page);
			if (!before) throw new Error("No file drop was dispatched");
			await expect(world.page).toHaveURL(before.url);
			expect(
				await world.page.evaluate(
					(original) => original === document,
					before.document,
				),
			).toBe(true);
			await before.document.dispose();
			drops.delete(world.page);
		},
	},
	{
		name: "seed a sent image through the transcript mock",
		match:
			/^the transcript contains a sent user message with an image attachment$/,
		run: async ({ world }) => {
			const page = world.page;
			const sessionId = new URL(page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("No session is open");
			const url = new URL("/acceptance-images/sent-preview.png", page.url())
				.href;
			await page.route(url, (route) =>
				route.fulfill({ contentType: "image/png", body: imageBytes }),
			);
			const messages: HistoryMessage[] = [
				{
					id: "sent-image-message",
					role: "user",
					time: { created: PINNED_CLOCK_MS },
					parts: [
						{
							id: "sent-image-text",
							type: "text",
							text: "Please inspect this image",
						},
						{
							id: "sent-image-file",
							type: "file",
							mime: "image/png",
							filename: "sent-preview.png",
							source: { url },
						},
					],
				},
			];
			requireRelayControl(page).sendMessage({
				type: "mock_transcript_snapshot",
				sessionId,
				history: { messages, hasMore: false },
			});
			await expect(page.locator("#messages .msg-user").last()).toContainText(
				"Please inspect this image",
			);
			await expect(
				page
					.locator("#messages")
					.getByRole("button", {
						name: "View image sent-preview.png",
						exact: true,
					})
					.locator("img"),
			).toHaveAttribute("src", url);
		},
	},
	{
		name: "open image thumbnail",
		match: /^I click the (draft|sent) image thumbnail$/,
		run: async ({ world, match }) => {
			const isDraft = match[1] === "draft";
			const button = world.page
				.locator(isDraft ? "#input-area" : "#messages")
				.getByRole("button", {
					name: `View image ${isDraft ? imageName : "sent-preview.png"}`,
					exact: true,
				});
			const image = button.locator("img");
			await expect
				.poll(() =>
					image.evaluate(
						(img: HTMLImageElement) => img.complete && img.naturalWidth === 480,
					),
				)
				.toBe(true);
			const source = await image.getAttribute("src");
			if (!source) throw new Error("Image thumbnail has no source");
			lightboxSources.set(world.page, source);
			await button.click();
		},
	},
	{
		name: "assert lightbox source and loaded image",
		match: /^the lightbox shows the (draft|sent) image$/,
		run: async ({ world }) => {
			const source = lightboxSources.get(world.page);
			if (!source) throw new Error("No image thumbnail was opened");
			const dialog = world.page.getByRole("dialog");
			await expect(dialog).toBeVisible();
			const image = dialog.locator("#image-lightbox");
			await expect(image).toBeVisible();
			await expect(image).toHaveAttribute("src", source);
			await expect
				.poll(() =>
					image.evaluate(
						(img: HTMLImageElement) => img.complete && img.naturalWidth === 480,
					),
				)
				.toBe(true);
			await expect(
				dialog.getByRole("button", { name: "Close lightbox", exact: true }),
			).toBeVisible();
		},
	},
	{
		name: "close lightbox button",
		match: /^I close the image lightbox$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: "Close lightbox", exact: true })
				.click();
		},
	},
	{
		name: "close lightbox with Escape",
		match: /^I dismiss the image lightbox with Escape$/,
		run: async ({ world }) => {
			await world.page.keyboard.press("Escape");
		},
	},
	{
		name: "assert lightbox dismissed",
		match: /^the image lightbox is dismissed$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#image-lightbox")).not.toBeVisible();
			await expect(
				world.page.getByRole("button", { name: "Close lightbox", exact: true }),
			).not.toBeVisible();
		},
	},
];
