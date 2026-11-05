import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RewindBanner from "../../../src/lib/frontend/components/overlays/RewindBanner.svelte";
import {
	chatState,
	clearMessages,
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import {
	clearInstanceState,
	instanceState,
} from "../../../src/lib/frontend/stores/instance.svelte.js";
import {
	applyTranscriptEnvelope,
	deriveTranscriptMessages,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import { applySessionChange } from "../../../src/lib/frontend/transport/session-subscription.svelte.js";
import { detailRowsOf } from "../../helpers/detail-rows.js";

// 82tn.51: the banner's rewind is a head move, previewed then committed; files are asked first.
const rpcSpy = vi.hoisted(() =>
	vi.fn<(tag: string, input: unknown) => Promise<unknown>>((tag) =>
		Promise.resolve(
			tag === "GetHeadMoveFiles"
				? { files: "available" }
				: tag === "PreviewHeadMove"
					? { moveId: "move-1", files: "available" }
					: { moveId: "move-1" },
		),
	),
);
const moves = () =>
	rpcSpy.mock.calls.filter(([tag]) => tag !== "GetHeadMoveFiles");
const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);

vi.mock("../../../src/lib/frontend/components/ui/Icon.svelte", emptyComponent);
vi.mock(
	"../../../src/lib/frontend/stores/router.svelte.js",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../src/lib/frontend/stores/router.svelte.js")
		>()),
		DRAFT_PROJECT_PARAM: "project",
		getCurrentSearchParams: () => new URLSearchParams(),
	}),
);
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc: (tag: string, input: unknown) => rpcSpy(tag, input),
}));

describe("RewindBanner", () => {
	beforeEach(() => {
		rpcSpy.mockClear();
		openSessionForSetup("session-1", "project-a");
		getOrCreateSessionActivity("session-1");
		uiState.rewindActive = true;
		uiState.toasts = [];
		uiState.rewindSelectedUuid = "message-1";
		getOrCreateSessionMessages("session-1").transcript = null;
		getOrCreateSessionMessages("session-1").messages = [
			{
				type: "user",
				uuid: "message-1",
				messageId: "provider-1",
				text: "Remove this",
			},
		];
	});

	afterEach(() => {
		cleanup();
		clearInstanceState();
		clearMessages();
		openSessionForSetup(null);
		uiState.rewindActive = false;
		uiState.rewindSelectedUuid = null;
	});

	it("says files are not restored for an OpenCode session", () => {
		instanceState.instances = [
			{
				id: "opencode",
				name: "OpenCode",
				driver: "opencode",
				status: "healthy",
				port: 0,
				managed: false,
				restartCount: 0,
				createdAt: 0,
			},
		];
		applySessionChange({
			_tag: "snapshot",
			sequence: 1,
			rows: [
				{
					id: "session-1",
					title: "Rewind",
					projectSlug: "project-a",
					accountId: "opencode",
					status: "idle",
				},
			],
		});
		const { getByText } = render(RewindBanner);
		expect(getByText("Files are not restored.")).toBeTruthy();
	});

	it("says the Head Log undoes the rewind for an event-seeded target", () => {
		const slot = getOrCreateSessionMessages("session-1");
		slot.transcript = applyTranscriptEnvelope(
			{
				project: "project-a",
				rows: [],
				pending: [],
				hwm: null,
				hasMore: false,
				status: { _tag: "live" },
				waiting: new Map(),
				partOrder: new Map(),
			},
			{
				_tag: "snapshot",
				sequence: 1,
				rows: detailRowsOf({
					id: "provider-1",
					role: "user",
					parts: [{ id: "part-1", type: "text", text: "Remove this" }],
				}),
			},
		);
		slot.messages = deriveTranscriptMessages(slot.transcript, []);
		uiState.rewindSelectedUuid = slot.messages[0]?.uuid ?? null;
		const { getByText } = render(RewindBanner);

		expect(
			getByText(
				// 82tn.51: a rewind lands at once and every move stays undoable from the Head Log.
				"This message and everything after it will be removed. Every move can be undone from the Head Log.",
			),
		).toBeTruthy();
		expect(getByText("Files are restored to this point.")).toBeTruthy();
	});

	it("rewinds as a head move: previews it, then commits the preview", async () => {
		const { getByRole } = render(RewindBanner);

		await fireEvent.click(getByRole("button", { name: "Rewind" }));

		const intent = { _tag: "rewind", messageId: "provider-1" };
		await waitFor(() =>
			expect(moves()).toEqual([
				["PreviewHeadMove", { sessionId: "session-1", intent }],
				[
					"CommitHeadMove",
					{ sessionId: "session-1", intent, moveId: "move-1" },
				],
			]),
		);
		expect(uiState.rewindActive).toBe(false);
		expect(uiState.rewindSelectedUuid).toBeNull();
	});

	it("says the files at a pruned point were pruned once, and keeps Rewind enabled", async () => {
		rpcSpy.mockImplementation((tag) =>
			Promise.resolve(
				tag === "CommitHeadMove"
					? { moveId: "move-1" }
					: { moveId: "move-1", files: "pruned" },
			),
		);
		const { findByText, getByRole, queryByText } = render(RewindBanner);

		expect(await findByText("Files from this point were pruned.")).toBeTruthy();
		expect(rpcSpy).toHaveBeenCalledWith("GetHeadMoveFiles", {
			sessionId: "session-1",
			messageId: "provider-1",
		});
		expect(queryByText("Files are not restored.")).toBeNull();
		expect(queryByText("Files are restored to this point.")).toBeNull();
		const rewind = getByRole("button", { name: "Rewind" });
		expect(rewind.hasAttribute("disabled")).toBe(false);
		await fireEvent.click(rewind);
		await waitFor(() =>
			expect(moves().map(([tag]) => tag)).toEqual([
				"PreviewHeadMove",
				"CommitHeadMove",
			]),
		);
		// 82tn.51: the dialog said it before the move; the move does not toast it again.
		await Promise.resolve();
		expect(uiState.toasts).toEqual([]);
		rpcSpy.mockReset();
	});

	it("rewinds to an assistant message with a provider id", async () => {
		getOrCreateSessionMessages("session-1").messages = [
			{
				type: "assistant",
				uuid: "message-1",
				messageId: "provider-assistant-1",
				rawText: "Assistant response",
				html: "Assistant response",
				finalized: true,
			},
		];
		const { getByRole } = render(RewindBanner);
		await fireEvent.click(getByRole("button", { name: "Rewind" }));
		await waitFor(() =>
			expect(moves()[1]).toEqual([
				"CommitHeadMove",
				{
					sessionId: "session-1",
					intent: { _tag: "rewind", messageId: "provider-assistant-1" },
					moveId: "move-1",
				},
			]),
		);
		expect(chatState.messages).toHaveLength(1);
		expect(uiState.toasts).toEqual([]);
	});

	it("keeps the transcript and reports a message that has no provider id yet", async () => {
		getOrCreateSessionMessages("session-1").messages = [
			{ type: "user", uuid: "message-1", text: "Pending" },
		];
		const { getByRole } = render(RewindBanner);
		await fireEvent.click(getByRole("button", { name: "Rewind" }));
		expect(rpcSpy).not.toHaveBeenCalled();
		expect(chatState.messages).toHaveLength(1);
		expect(uiState.rewindActive).toBe(false);
		expect(uiState.toasts).toEqual([
			expect.objectContaining({
				variant: "warn",
				title: expect.stringContaining("yet"),
			}),
		]);
	});

	it("keeps the transcript and reports a refused move", async () => {
		rpcSpy.mockImplementation((tag) =>
			tag === "GetHeadMoveFiles"
				? Promise.resolve({ files: "available" })
				: Promise.reject(new Error("Target not found")),
		);
		const { getByRole } = render(RewindBanner);
		await fireEvent.click(getByRole("button", { name: "Rewind" }));
		await waitFor(() =>
			expect(uiState.toasts).toEqual([
				expect.objectContaining({
					variant: "warn",
					title: expect.stringContaining("Could not move the conversation"),
				}),
			]),
		);
		expect(moves().map(([tag]) => tag)).toEqual(["PreviewHeadMove"]);
		expect(chatState.messages).toHaveLength(1);
		expect(uiState.rewindActive).toBe(false);
		rpcSpy.mockReset();
	});

	it("leaves transcript changes to the subscription while the move lands", async () => {
		let land!: (reply: { moveId: string }) => void;
		rpcSpy.mockImplementation((tag) =>
			tag === "CommitHeadMove"
				? new Promise((resolve) => {
						land = resolve;
					})
				: Promise.resolve(
						tag === "PreviewHeadMove"
							? { moveId: "move-1", files: "available" }
							: { files: "available" },
					),
		);
		getOrCreateSessionMessages("session-1").messages = [
			{ type: "user", uuid: "before", text: "Keep this" },
			{
				type: "user",
				uuid: "message-1",
				messageId: "provider-1",
				text: "Remove this",
			},
			{ type: "user", uuid: "after", text: "Remove this too" },
		];
		const { getByRole } = render(RewindBanner);
		await fireEvent.click(getByRole("button", { name: "Rewind" }));
		await waitFor(() => expect(land).toBeTypeOf("function"));
		expect(chatState.messages).toHaveLength(3);
		land({ moveId: "move-1" });
		await Promise.resolve();
		expect(chatState.messages.map((message) => message.uuid)).toEqual([
			"before",
			"message-1",
			"after",
		]);
		expect(uiState.toasts).toEqual([]);
		rpcSpy.mockReset();
	});
});
