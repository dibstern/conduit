import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RewindBanner from "../../../src/lib/frontend/components/overlays/RewindBanner.svelte";
import {
	chatState,
	clearMessages,
	getOrCreateSessionActivity,
	getOrCreateSessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	applyTranscriptEnvelope,
	deriveTranscriptMessages,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { detailRowsOf } from "../../helpers/detail-rows.js";

interface RewindSessionInput {
	readonly sessionId: string;
	readonly messageId: string;
}

const rewindSessionRpcSpy = vi.hoisted(() =>
	vi.fn(async (input: RewindSessionInput) => ({
		ok: true as const,
		sessionId: input.sessionId,
		messageId: input.messageId,
	})),
);
const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);

vi.mock("../../../src/lib/frontend/components/ui/Icon.svelte", emptyComponent);
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	DRAFT_PROJECT_PARAM: "project",
	getCurrentSlug: () => "project-a",
	getCurrentSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rewindSessionRpc: (input: RewindSessionInput) => rewindSessionRpcSpy(input),
	undoRewindRpc: vi.fn(),
}));

describe("RewindBanner", () => {
	beforeEach(() => {
		rewindSessionRpcSpy.mockClear();
		sessionState.currentId = "session-1";
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
		clearMessages();
		sessionState.currentId = null;
		uiState.rewindActive = false;
		uiState.rewindSelectedUuid = null;
	});

	it("explains permanent removal and the undo deadline for an event-seeded rewind target", () => {
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
				"This message and everything after it will be removed. You can undo until you send your next message.",
			),
		).toBeTruthy();
		expect(getByText("Files are restored to this point.")).toBeTruthy();
	});

	it("explains that the next send makes an event-delivered pending rewind permanent", async () => {
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
			{ _tag: "snapshot", sequence: 1, rows: [] },
		);
		const { getByRole, queryByRole } = render(RewindBanner, {
			pendingOnly: true,
		});
		expect(queryByRole("status")).toBeNull();

		slot.transcript = applyTranscriptEnvelope(slot.transcript, {
			_tag: "upsert",
			sequence: 2,
			item: { _tag: "rewind", messageId: "provider-1" },
		});

		await waitFor(() =>
			expect(getByRole("status").textContent).toBe(
				"Rewound. Sending your next message makes it permanent.",
			),
		);
		expect(getByRole("button", { name: "Undo" })).toBeTruthy();
	});

	it("confirms rewind through RPC for the active session", async () => {
		const { getByRole } = render(RewindBanner);

		await fireEvent.click(getByRole("button", { name: "Rewind" }));

		await waitFor(() => {
			expect(rewindSessionRpcSpy).toHaveBeenCalledWith({
				sessionId: "session-1",
				messageId: "provider-1",
			});
		});
		expect(uiState.rewindActive).toBe(false);
		expect(uiState.rewindSelectedUuid).toBeNull();
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
		const onRewind = vi.fn();
		const { getByRole } = render(RewindBanner, { onRewind });
		await fireEvent.click(getByRole("button", { name: "Rewind" }));
		expect(rewindSessionRpcSpy).toHaveBeenCalledWith({
			sessionId: "session-1",
			messageId: "provider-assistant-1",
		});
		await waitFor(() =>
			expect(onRewind).toHaveBeenCalledWith("message-1", "both"),
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
		expect(rewindSessionRpcSpy).not.toHaveBeenCalled();
		expect(chatState.messages).toHaveLength(1);
		expect(uiState.rewindActive).toBe(false);
		expect(uiState.toasts).toEqual([
			expect.objectContaining({
				variant: "warn",
				title: expect.stringContaining("yet"),
			}),
		]);
	});

	it("keeps the transcript and reports an RPC rejection", async () => {
		rewindSessionRpcSpy.mockRejectedValueOnce(new Error("Target not found"));
		const { getByRole } = render(RewindBanner);
		await fireEvent.click(getByRole("button", { name: "Rewind" }));
		await waitFor(() =>
			expect(uiState.toasts).toEqual([
				expect.objectContaining({
					variant: "warn",
					title: expect.stringContaining("Could not rewind"),
				}),
			]),
		);
		expect(chatState.messages).toHaveLength(1);
		expect(uiState.rewindActive).toBe(false);
	});

	it("keeps rehydrated messages when the selected render uuid disappears before the reply", async () => {
		let resolveReply!: (reply: {
			ok: true;
			sessionId: string;
			messageId: string;
		}) => void;
		rewindSessionRpcSpy.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveReply = resolve;
				}),
		);
		const onRewind = vi.fn();
		const { getByRole } = render(RewindBanner, { onRewind });
		await fireEvent.click(getByRole("button", { name: "Rewind" }));
		getOrCreateSessionMessages("session-1").messages = [
			{
				type: "user",
				uuid: "rehydrated",
				messageId: "provider-1",
				text: "Keep this",
			},
		];
		resolveReply({ ok: true, sessionId: "session-1", messageId: "provider-1" });
		await waitFor(() =>
			expect(onRewind).toHaveBeenCalledWith("message-1", "both"),
		);
		expect(uiState.toasts).toEqual([]);
		expect(chatState.messages).toEqual([
			{
				type: "user",
				uuid: "rehydrated",
				messageId: "provider-1",
				text: "Keep this",
			},
		]);
		expect(uiState.rewindActive).toBe(false);
	});

	it("leaves transcript changes to the subscription and confirms only when the RPC succeeds", async () => {
		let resolveReply!: (reply: {
			ok: true;
			sessionId: string;
			messageId: string;
		}) => void;
		rewindSessionRpcSpy.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveReply = resolve;
				}),
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
		const onRewind = vi.fn();
		const { getByRole } = render(RewindBanner, { onRewind });
		await fireEvent.click(getByRole("button", { name: "Rewind" }));
		expect(chatState.messages).toHaveLength(3);
		expect(uiState.toasts).toEqual([]);
		resolveReply({ ok: true, sessionId: "session-1", messageId: "provider-1" });
		await waitFor(() =>
			expect(onRewind).toHaveBeenCalledWith("message-1", "both"),
		);
		expect(chatState.messages.map((message) => message.uuid)).toEqual([
			"before",
			"message-1",
			"after",
		]);
		expect(uiState.toasts).toEqual([]);
	});
});
