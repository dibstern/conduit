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
import type { rpc } from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import { detailRowsOf } from "../../helpers/detail-rows.js";

const rpcSpy = vi.hoisted(() =>
	vi.fn<typeof rpc<"RewindSession">>((_tag, input) =>
		Promise.resolve({
			ok: true as const,
			sessionId: input.sessionId,
			messageId: input.messageId,
		}),
	),
);
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
const filesSpy = vi.hoisted(() =>
	vi.fn<typeof rpc<"GetHeadMoveFiles">>(() =>
		Promise.resolve({ files: "available" as const }),
	),
);
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc: (
		...[tag, input]: Parameters<typeof rpcSpy> | Parameters<typeof filesSpy>
	) => (tag === "GetHeadMoveFiles" ? filesSpy(tag, input) : rpcSpy(tag, input)),
}));

describe("RewindBanner", () => {
	beforeEach(() => {
		rpcSpy.mockClear();
		filesSpy.mockClear();
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
			expect(rpcSpy).toHaveBeenCalledWith("RewindSession", {
				sessionId: "session-1",
				messageId: "provider-1",
			});
		});
		expect(uiState.rewindActive).toBe(false);
		expect(uiState.rewindSelectedUuid).toBeNull();
	});

	it("says the files at a pruned point were pruned and keeps Rewind enabled", async () => {
		filesSpy.mockResolvedValueOnce({ files: "pruned" });
		const { findByText, getByRole, queryByText } = render(RewindBanner);

		expect(await findByText("Files from this point were pruned.")).toBeTruthy();
		expect(filesSpy).toHaveBeenCalledWith("GetHeadMoveFiles", {
			sessionId: "session-1",
			messageId: "provider-1",
		});
		expect(queryByText("Files are not restored.")).toBeNull();
		expect(queryByText("Files are restored to this point.")).toBeNull();
		const rewind = getByRole("button", { name: "Rewind" });
		expect(rewind.hasAttribute("disabled")).toBe(false);
		await fireEvent.click(rewind);
		await waitFor(() =>
			expect(rpcSpy).toHaveBeenCalledWith("RewindSession", {
				sessionId: "session-1",
				messageId: "provider-1",
			}),
		);
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
		expect(rpcSpy).toHaveBeenCalledWith("RewindSession", {
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

	it("keeps the transcript and reports an RPC rejection", async () => {
		rpcSpy.mockRejectedValueOnce(new Error("Target not found"));
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
		rpcSpy.mockImplementationOnce(
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
		rpcSpy.mockImplementationOnce(
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
