import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import { handleCommandList } from "../../stores/discovery.svelte.js";
import {
	mockUserMessage,
	mockUserMessageLong,
	mockUserMessageShort,
} from "../../stories/mocks.js";
import type { UserMessage as UserMessageData } from "../../types.js";
import UserMessage from "./UserMessage.svelte";

const meta = {
	title: "Chat/UserMessage",
	component: UserMessage,
	tags: ["autodocs"],
} satisfies Meta<typeof UserMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

// Mixed fonts in one header line must share a baseline, not a box centre.
const baselines = (root: Element) =>
	[...root.querySelectorAll("span, time")]
		.filter((el) => el.childElementCount === 0 && el.textContent?.trim())
		.map((el) => {
			const mark = el.ownerDocument.createElement("span");
			mark.style.cssText = "display:inline-block;width:0;height:0";
			el.append(mark);
			const y = mark.getBoundingClientRect().top;
			mark.remove();
			return y;
		});

export const Default: Story = {
	args: { message: mockUserMessage },
	play: async ({ canvasElement }) => {
		await canvasElement.ownerDocument.fonts.ready;
		const header = within(canvasElement).getByTestId("user-message-header");
		const [name, ...rest] = baselines(header);
		for (const y of rest) await expect(y).toBeCloseTo(name ?? 0, 1);
		const avatar = within(canvasElement).getByTestId("user-avatar");
		const tile = avatar.getBoundingClientRect();
		const label = header.querySelector("span")?.getBoundingClientRect();
		if (!label) throw new Error("Missing user name");
		await expect(
			Math.abs(tile.top + tile.height / 2 - label.top - label.height / 2),
			JSON.stringify({
				width: window.innerWidth,
				tile: tile.toJSON(),
				label: label.toJSON(),
				header: header.getBoundingClientRect().toJSON(),
				button: avatar.parentElement?.getBoundingClientRect().toJSON(),
			}),
		).toBeLessThan(0.5);
		await expect(getComputedStyle(avatar).backgroundImage).toBe(
			"linear-gradient(135deg, rgb(111, 125, 255), rgb(176, 124, 255))",
		);
	},
};
export const DefaultLight: Story = { ...Default, globals: { theme: "light" } };

export const ShortText: Story = {
	args: { message: mockUserMessageShort },
};

export const LongText: Story = {
	args: { message: mockUserMessageLong },
};
export const LongTextLight: Story = {
	...LongText,
	globals: { theme: "light" },
};

export const NeutralStates: Story = {
	args: {
		message: {
			...mockUserMessage,
			steered: true,
			modelExecution: {
				requestedModel: "Opus",
				expectedModel: "Opus",
				actualModel: "Fable 5",
				drifted: true,
			},
		},
		onDismissCutOff: () => {},
	},
};
export const NeutralStatesLight: Story = {
	...NeutralStates,
	globals: { theme: "light" },
};

/** `/commit` is a known command and renders as a pill; `/comit` (a typo the
 *  composer would have underlined) and `/qwerty` stay plain once sent. */
export const WithSkills: Story = {
	beforeEach: () => {
		handleCommandList({
			commands: [
				{ name: "commit", description: "Create a git commit" },
				{ name: "code-review", description: "Review the current diff" },
			],
		});
	},
	args: {
		message: {
			type: "user",
			uuid: "msg-user-004",
			text: "run /commit then /comit and /qwerty",
		},
	},
};

const fileOnlyMessage: UserMessageData = {
	uuid: "persisted-documents",
	type: "user",
	text: "",
	attachments: [
		{
			id: "notes",
			mime: "text/plain",
			name: "notes.txt",
			source: { url: "https://example.com/notes.txt" },
			size: 5,
		},
		{
			id: "guide",
			mime: "application/pdf",
			name: "guide.pdf",
			source: { url: "https://example.com/guide.pdf" },
			size: 8,
		},
	],
};

/** Both viewports must keep file-only sends visible after the composer clears. */
export const FileOnlyDocuments: Story = {
	args: { message: fileOnlyMessage },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getAllByTestId("user-message-file")).toHaveLength(2);
		await expect(canvas.getByText("notes.txt")).toBeVisible();
		await expect(canvas.getByText("text/plain · 5 B")).toBeVisible();
		await expect(canvas.getByText("guide.pdf")).toBeVisible();
		await expect(canvas.getByText("application/pdf · 8 B")).toBeVisible();
	},
};
export const FileOnlyDocumentsLight: Story = {
	...FileOnlyDocuments,
	globals: { theme: "light" },
};

export const MixedAttachments: Story = {
	args: {
		message: {
			...fileOnlyMessage,
			text: "Review the screenshot and attached documents.",
			attachments: [
				{
					id: "screenshot",
					mime: "image/png",
					name: "screenshot.png",
					source: {
						url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
					},
					size: 73,
				},
				...(fileOnlyMessage.attachments ?? []),
			],
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByText("Review the screenshot and attached documents."),
		).toBeVisible();
		await expect(
			canvas.getByRole("img", { name: "screenshot.png" }),
		).toBeVisible();
		await expect(canvas.getAllByTestId("user-message-file")).toHaveLength(2);
		for (const attachment of [
			canvas.getByRole("img", { name: "screenshot.png" }),
			...canvas.getAllByTestId("user-message-file"),
		]) {
			await expect(getComputedStyle(attachment).borderWidth).toBe("0px");
			await expect(getComputedStyle(attachment).backgroundColor).not.toBe(
				"rgba(0, 0, 0, 0)",
			);
		}
	},
};
export const MixedAttachmentsLight: Story = {
	...MixedAttachments,
	globals: { theme: "light" },
};
