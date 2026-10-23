import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const held = new WeakMap<Page, { save: () => void; fail: () => void }>();

export const draftAttachmentFailureHandlers: StepHandler[] = [
	{
		name: "hold the next attachment save",
		match: /^the next draft attachment save is held$/,
		run: ({ world }) => {
			const control = requireRpcControl(world.page);
			let first = true;
			control.setStubs({
				AddDraftAttachment: ({ key, id, name, mime, dataUrl }) => {
					const save = () =>
						control.addDraftAttachment(key, id, name, mime, dataUrl);
					if (!first) return save();
					first = false;
					return new Promise((resolve, reject) => {
						held.set(world.page, {
							save: () => resolve(save()),
							fail: () =>
								reject(new WsRpcError({ message: "Save failed. Try again." })),
						});
					});
				},
			});
		},
	},
	{
		name: "choose one draft attachment",
		match: /^I choose a draft (image|file) attachment$/,
		run: async ({ world, match }) => {
			const isImage = match[1] === "image";
			const chooser = world.page.waitForEvent("filechooser");
			await world.page
				.getByRole("menuitem", {
					name: isImage ? "Add Photos" : "Add Files",
					exact: true,
				})
				.click();
			await (await chooser).setFiles({
				name: isImage ? "draft-pixel.png" : "notes.txt",
				mimeType: isImage ? "image/png" : "text/plain",
				buffer: isImage
					? Buffer.from(
							"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
							"base64",
						)
					: readFileSync(
							new URL(
								"../../../test/fixtures/attachments/notes.txt",
								import.meta.url,
							),
						),
			});
		},
	},
	{
		name: "assert attachment state and failure controls",
		match: /^the draft attachment is (saving|saved|failed)$/,
		run: async ({ world, match }) => {
			const chip = world.page.getByTestId("draft-attachment");
			await expect(chip).toHaveCount(1);
			await expect(chip).toHaveAttribute("data-status", match[1] ?? "");
			if (match[1] === "failed") {
				await expect(chip).toContainText("not saved");
				await expect(chip.getByTestId("draft-attachment-error")).toHaveText(
					"Save failed. Try again.",
				);
				await expect(
					chip.getByRole("button", { name: "Retry", exact: true }),
				).toBeVisible();
				await expect(
					chip.getByRole("button", { name: "Remove", exact: true }),
				).toBeVisible();
			} else {
				await expect(chip).not.toContainText("not saved");
			}
		},
	},
	{
		name: "settle held attachment save",
		match: /^I (acknowledge|fail) the held draft attachment save$/,
		run: async ({ world, match }) => {
			await expect.poll(() => held.has(world.page)).toBe(true);
			const pending = held.get(world.page);
			if (!pending) throw new Error("No held attachment save");
			held.delete(world.page);
			if (match[1] === "acknowledge") pending.save();
			else pending.fail();
		},
	},
	{
		name: "recover failed attachment",
		match: /^I (retry|remove) the failed draft attachment$/,
		run: async ({ world, match }) => {
			await world.page.getByTestId(`draft-attachment-${match[1]}`).click();
		},
	},
	{
		name: "assert attachment recovery and unchanged text",
		match: /^the draft attachment recovery is (saved|absent)$/,
		run: async ({ world, match }) => {
			const chip = world.page.getByTestId("draft-attachment");
			if (match[1] === "absent") await expect(chip).toHaveCount(0);
			else await expect(chip).toHaveAttribute("data-status", "saved");
			await expect(world.page.locator("#input")).toHaveValue("Keep this text");
			await expect(
				world.page.getByTestId("draft-attachment-error"),
			).toHaveCount(0);
			const control = requireRpcControl(world.page);
			const adds = control
				.getRequests()
				.filter((request) => request.tag === "AddDraftAttachment");
			if (match[1] === "saved") {
				expect(adds).toHaveLength(2);
				expect(adds[1]?.payload).toEqual(adds[0]?.payload);
			} else {
				expect(adds).toHaveLength(1);
				await expect
					.poll(
						() =>
							control
								.getRequests()
								.filter((request) => request.tag === "RemoveDraftAttachment")
								.length,
					)
					.toBe(1);
			}
		},
	},
];
