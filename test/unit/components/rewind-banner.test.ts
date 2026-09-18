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
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";

interface RewindSessionInput {
	readonly projectSlug: string;
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

vi.mock(
	"../../../src/lib/frontend/components/shared/Icon.svelte",
	emptyComponent,
);
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => "project-a",
}));
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rewindSessionRpc: (input: RewindSessionInput) => rewindSessionRpcSpy(input),
}));

describe("RewindBanner", () => {
	beforeEach(() => {
		rewindSessionRpcSpy.mockClear();
		sessionState.currentId = "session-1";
		getOrCreateSessionActivity("session-1");
		uiState.rewindActive = true;
		uiState.toasts = [];
		uiState.rewindSelectedUuid = "message-1";
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

	it("confirms rewind through RPC for the active session", async () => {
		const { getByRole } = render(RewindBanner);

		await fireEvent.click(getByRole("button", { name: "Rewind" }));

		await waitFor(() => {
			expect(rewindSessionRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
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
		const { getByRole } = render(RewindBanner);
		await fireEvent.click(getByRole("button", { name: "Rewind" }));
		expect(rewindSessionRpcSpy).toHaveBeenCalledWith({
			projectSlug: "project-a",
			sessionId: "session-1",
			messageId: "provider-assistant-1",
		});
		await waitFor(() => expect(chatState.messages).toEqual([]));
		expect(uiState.toasts.map((toast) => toast.message)).toEqual([
			"Rewound conversation & files",
		]);
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
				message: expect.stringContaining("yet"),
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
					message: expect.stringContaining("Could not rewind"),
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
		const { getByRole } = render(RewindBanner);
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
			expect(uiState.toasts).toEqual([
				expect.objectContaining({
					variant: "warn",
					message: expect.stringContaining("changed"),
				}),
			]),
		);
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

	it("clears from the target and confirms only when the RPC succeeds", async () => {
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
		const { getByRole } = render(RewindBanner);
		await fireEvent.click(getByRole("button", { name: "Rewind" }));
		expect(chatState.messages).toHaveLength(3);
		expect(uiState.toasts).toEqual([]);
		resolveReply({ ok: true, sessionId: "session-1", messageId: "provider-1" });
		await waitFor(() =>
			expect(chatState.messages.map((message) => message.uuid)).toEqual([
				"before",
			]),
		);
		expect(uiState.toasts.map((toast) => toast.message)).toEqual([
			"Rewound conversation & files",
		]);
	});
});
