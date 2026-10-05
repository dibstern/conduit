import { describe, expect, it, vi } from "vitest";
import type { SessionDetailEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
import {
	applyTranscriptEnvelope,
	deriveTranscriptMessages,
	type TranscriptEntry,
} from "../../../src/lib/frontend/stores/transcript.svelte.js";
import type {
	ChatMessage,
	HistoryMessage,
} from "../../../src/lib/frontend/types.js";

vi.mock("../../../src/lib/frontend/utils/markdown.js", () => ({
	renderMarkdown: (text: string) => text,
}));

const row = (
	id: string,
	created: number,
	text: string,
	completed = false,
): HistoryMessage => ({
	id,
	role: "assistant",
	time: { created, ...(completed ? { completed: created + 1 } : {}) },
	parts: [{ id: `${id}-part`, type: "text", text }],
});
const item = (message: HistoryMessage) => ({
	_tag: "transcriptMessage" as const,
	message,
});
const entry = (): TranscriptEntry => ({
	project: "test",
	rows: [],
	hwm: null,
	hasMore: false,
	status: { _tag: "live" },
	pending: [],
});
const snapshot = (
	rows: HistoryMessage[],
	sequence: number,
	hasMore = false,
): SessionDetailEnvelope => ({
	_tag: "snapshot",
	sequence,
	hasMore,
	rows: rows.map(item),
});

describe("transcript detail reducer", () => {
	it("replaces a snapshot, upserts whole rows, removes held rows, and advances the HWM", () => {
		const first = applyTranscriptEnvelope(
			entry(),
			snapshot([row("b", 2, "B"), row("a", 1, "A")], 4),
		);
		expect(first.rows.map((message) => message.id)).toEqual(["a", "b"]);
		const next = applyTranscriptEnvelope(first, {
			_tag: "upsert",
			sequence: 6,
			item: item(row("b", 2, "new B")),
		});
		expect(next.rows[1]?.parts?.[0]?.text).toBe("new B");
		expect(next.rows[0]).toBe(first.rows[0]);
		const removed = applyTranscriptEnvelope(next, {
			_tag: "remove",
			id: "a",
			sequence: 5,
		});
		expect(removed.rows.map((message) => message.id)).toEqual(["b"]);
		expect(removed.hwm).toBe(6);
	});

	it("does not insert an older unheld row above a paged coverage floor", () => {
		const held = applyTranscriptEnvelope(
			entry(),
			snapshot([row("b", 2, "B")], 2, true),
		);
		const next = applyTranscriptEnvelope(held, {
			_tag: "upsert",
			sequence: 3,
			item: item(row("a", 1, "A")),
		});
		expect(next.rows.map((message) => message.id)).toEqual(["b"]);
		expect(next.hwm).toBe(3);
	});

	it("keeps stable uuids and unchanged item objects, including sticky terminal facts", () => {
		const initial = applyTranscriptEnvelope(
			entry(),
			snapshot([row("a", 1, "A"), row("b", 2, "B")], 1),
		);
		const first = deriveTranscriptMessages(initial, []);
		expect(first.map((message) => message.uuid)).toEqual([
			"a/a-part",
			"b/b-part",
		]);
		const finalized = { ...first[0], finalized: true } as ChatMessage;
		const updated = applyTranscriptEnvelope(initial, {
			_tag: "upsert",
			sequence: 2,
			item: item(row("b", 2, "B2")),
		});
		const second = deriveTranscriptMessages(updated, [
			finalized,
			...first.slice(1),
		]);
		expect(second[0]).toBe(finalized);
		expect(second[1]).not.toBe(first[1]);
		expect(second[1]).toMatchObject({ rawText: "B2", finalized: false });
	});

	it("anchors local items after the row they followed", () => {
		const user: HistoryMessage = {
			id: "user-1",
			role: "user",
			inputId: "input-1",
			time: { created: 2 },
			parts: [{ id: "text", type: "text", text: "hello" }],
		};
		const initial = applyTranscriptEnvelope(
			entry(),
			snapshot([row("a", 1, "A")], 1),
		);
		const first = deriveTranscriptMessages(initial, []);
		const local: ChatMessage = {
			type: "system",
			uuid: "local-error",
			text: "error",
			variant: "error",
		};
		const next = applyTranscriptEnvelope(initial, {
			_tag: "upsert",
			sequence: 2,
			item: item(user),
		});
		expect(
			deriveTranscriptMessages(next, [...first, local]).map(
				(message) => message.uuid,
			),
		).toEqual(["a/a-part", "local-error", "user-1/user"]);
	});

	it("holds pending inputs oldest first and drops one when it is removed", () => {
		const pending = (inputId: string, admittedAt: number) => ({
			_tag: "pendingInput" as const,
			input: {
				inputId,
				state: "queued" as const,
				admittedAt,
				request: { text: inputId, modelUserSelected: false },
			},
		});
		const first = applyTranscriptEnvelope(entry(), {
			_tag: "snapshot",
			sequence: 1,
			rows: [pending("b", 2), item(row("a", 1, "A"))],
		});
		expect(first.rows.map((message) => message.id)).toEqual(["a"]);
		expect(first.pending.map((input) => input.inputId)).toEqual(["b"]);
		const added = applyTranscriptEnvelope(first, {
			_tag: "upsert",
			sequence: 2,
			item: pending("a", 1),
		});
		expect(added.pending.map((input) => input.inputId)).toEqual(["a", "b"]);
		const removed = applyTranscriptEnvelope(added, {
			_tag: "remove",
			id: "input:a",
			sequence: 3,
		});
		expect(removed.pending.map((input) => input.inputId)).toEqual(["b"]);
	});

	it("retains thinking completion and advanced tool state on a row refresh", () => {
		const original: HistoryMessage = {
			id: "assistant",
			role: "assistant",
			time: { created: 1 },
			parts: [
				{
					id: "tool",
					type: "tool",
					tool: "Read",
					callID: "call",
					state: { status: "pending" },
				},
				{ id: "thought", type: "thinking", text: "why" },
			],
		};
		const firstState = applyTranscriptEnvelope(
			entry(),
			snapshot([original], 1),
		);
		const first = deriveTranscriptMessages(firstState, []);
		const sticky = first.map((message): ChatMessage => {
			if (message.type === "thinking")
				return { ...message, done: true, duration: 42 };
			if (message.type === "tool")
				return {
					...message,
					status: "completed",
					input: { path: "a" },
					metadata: { sessionId: "child" },
				};
			return message;
		});
		const refreshed = applyTranscriptEnvelope(firstState, {
			_tag: "upsert",
			sequence: 2,
			item: item({
				...original,
				parts: [
					{
						id: "tool",
						type: "tool",
						tool: "Read",
						callID: "call",
						state: { status: "pending" },
					},
					{ id: "thought", type: "thinking", text: "why now" },
				],
			}),
		});
		const second = deriveTranscriptMessages(refreshed, sticky);
		expect(second.find((message) => message.type === "thinking")).toMatchObject(
			{ done: true, duration: 42, text: "why now" },
		);
		expect(second.find((message) => message.type === "tool")).toMatchObject({
			status: "completed",
			input: { path: "a" },
			metadata: { sessionId: "child" },
		});
	});
});
