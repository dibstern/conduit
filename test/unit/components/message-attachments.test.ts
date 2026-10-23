// Failure modes: browser MIME hides valid source files; extension normalization
// accepts binary text; history loses attachments; a file-only row becomes blank;
// document metadata disappears; mixed images disappear.
import { cleanup, render, screen, within } from "@testing-library/svelte";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentRefSchema } from "../../../src/lib/contracts/attachment-ref.js";

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc: vi.fn(),
}));
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => "conduit",
	getCurrentSessionId: () => null,
}));
vi.mock("../../../src/lib/frontend/stores/session-view.svelte.js", () => ({
	sessionViewState: { compact: false },
}));
vi.mock("../../../src/lib/frontend/stores/discovery.svelte.js", () => ({
	discoveryState: { commands: [] },
	getModelDisplayName: (name: string) => name,
}));

import UserMessage from "../../../src/lib/frontend/components/chat/UserMessage.svelte";
import { prepareFileAttachment } from "../../../src/lib/frontend/components/input/input-utils.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";

afterEach(cleanup);

describe("source file preparation", () => {
	it.each([
		["Makefile", ""],
		["Component.svelte", ""],
		["config.toml", "application/octet-stream"],
		["custom.data", "application/octet-stream"],
	])("accepts untyped UTF-8 file %s", async (name, type) => {
		const result = await prepareFileAttachment(
			new File(["café\n"], name, { type }),
		);
		expect(result.dataUrl).toBe(`data:text/plain;name=${name};base64,Y2Fmw6kK`);
	});

	it.each([
		["", new Uint8Array([0xff]), /UTF-8/],
		["application/octet-stream", new Uint8Array([0, 65]), /binary data/],
	])("rejects untyped binary contents with MIME %s", async (type, contents, error) => {
		await expect(
			prepareFileAttachment(new File([contents], "unknown.data", { type })),
		).rejects.toThrow(error);
	});

	it.each([
		["script.sh", "application/x-sh"],
		["query.sql", "application/sql"],
		["module.ts", "video/mp2t"],
	])("normalizes %s despite browser MIME %s", async (name, type) => {
		const result = await prepareFileAttachment(
			new File(["café\n"], name, { type }),
		);
		expect(result.dataUrl).toBe(`data:text/plain;name=${name};base64,Y2Fmw6kK`);
	});

	it.each([
		["invalid UTF-8", new Uint8Array([0xff]), /UTF-8/],
		["binary data", new Uint8Array([0, 65]), /binary data/],
	])("still rejects %s in a known text extension", async (_reason, contents, error) => {
		await expect(
			prepareFileAttachment(
				new File([contents], "script.sh", { type: "application/x-sh" }),
			),
		).rejects.toThrow(error);
	});
});

describe("persisted user attachments", () => {
	const notes = Schema.decodeUnknownSync(AttachmentRefSchema)({
		attachmentHash: "a".repeat(64),
		mime: "text/plain",
		name: "notes.txt",
	});
	const pdf = Schema.decodeUnknownSync(AttachmentRefSchema)({
		attachmentHash: "b".repeat(64),
		mime: "application/pdf",
		name: "guide.pdf",
	});

	it("renders a file-only history row with document name and MIME", () => {
		const [message] = historyToChatMessages([
			{
				id: "file-only",
				role: "user",
				parts: [
					{
						id: "text-file",
						type: "file",
						mime: "text/plain",
						filename: "notes.txt",
						source: notes,
					},
					{
						id: "pdf-file",
						type: "file",
						mime: "application/pdf",
						filename: "guide.pdf",
						source: pdf,
					},
				],
			},
		]);
		if (message?.type !== "user") throw new Error("Expected a user message");
		render(UserMessage, { props: { message } });
		const chips = screen.getAllByTestId("user-message-file");
		expect(chips).toHaveLength(2);
		expect(within(chips[0] as HTMLElement).getByText("notes.txt")).toBeTruthy();
		expect(chips[0]?.textContent).toContain("text/plain");
		expect(chips[1]?.textContent).toContain("application/pdf");
	});

	it("renders persisted images alongside text and document chips", () => {
		const image = Schema.decodeUnknownSync(AttachmentRefSchema)({
			attachmentHash: "c".repeat(64),
			mime: "image/png",
			name: "screenshot.png",
		});
		const [message] = historyToChatMessages([
			{
				id: "mixed",
				role: "user",
				parts: [
					{ id: "text", type: "text", text: "Review these files" },
					{
						id: "image",
						type: "file",
						mime: "image/png",
						filename: "screenshot.png",
						source: image,
					},
					{
						id: "file",
						type: "file",
						mime: "text/plain",
						filename: "notes.txt",
						source: notes,
					},
				],
			},
		]);
		if (message?.type !== "user") throw new Error("Expected a user message");
		render(UserMessage, { props: { message } });
		expect(screen.getByText("Review these files")).toBeTruthy();
		expect(
			screen.getByRole("img", { name: "screenshot.png" }).getAttribute("src"),
		).toBe(`/p/conduit/attachments/${image.attachmentHash}`);
		expect(screen.getByTestId("user-message-file").textContent).toContain(
			"notes.txt",
		);
	});
});
