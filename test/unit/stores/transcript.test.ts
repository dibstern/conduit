import { describe, expect, it, vi } from "vitest";
import type { SessionDetailEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
import {
	applyTranscriptEnvelope,
	deriveTranscriptMessages as derive,
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
	carriedUsers: new Map(),
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
const deriveTranscriptMessages = (...args: Parameters<typeof derive>) =>
	derive(...args).messages;

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
		const first = deriveTranscriptMessages(initial, [], {
			live: false,
			active: false,
			turnEpoch: 0,
		});
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
		const second = deriveTranscriptMessages(
			updated,
			[finalized, ...first.slice(1)],
			{
				live: true,
				active: false,
				turnEpoch: 0,
			},
		);
		expect(second[0]).toBe(finalized);
		expect(second[1]).not.toBe(first[1]);
		expect(second[1]).toMatchObject({ rawText: "B2", finalized: false });
	});

	it("anchors local items and adopts only the first matching optimistic user", () => {
		const user: HistoryMessage = {
			id: "user-1",
			role: "user",
			time: { created: 2 },
			parts: [{ id: "text", type: "text", text: "hello" }],
		};
		const initial = applyTranscriptEnvelope(
			entry(),
			snapshot([row("a", 1, "A")], 1),
		);
		const first = deriveTranscriptMessages(initial, [], {
			live: false,
			active: false,
			turnEpoch: 0,
		});
		const local: ChatMessage = {
			type: "system",
			uuid: "local-error",
			text: "error",
			variant: "error",
		};
		const optimistic: ChatMessage = {
			type: "user",
			uuid: "optimistic",
			text: "hello",
			originId: "browser",
			sentDuringEpoch: 3,
		};
		const next = applyTranscriptEnvelope(initial, {
			_tag: "upsert",
			sequence: 2,
			item: item(user),
		});
		const projected = deriveTranscriptMessages(
			next,
			[...first, local, optimistic],
			{
				live: true,
				active: true,
				turnEpoch: 4,
				newUserIds: new Set(["user-1"]),
			},
		);
		expect(projected.map((message) => message.uuid)).toEqual([
			"a/a-part",
			"local-error",
			"user-1/user",
		]);
		expect(projected[2]).toMatchObject({
			originId: "browser",
			sentDuringEpoch: 3,
		});
		const replayed = deriveTranscriptMessages(
			{
				...next,
				carriedUsers: new Map([
					["user-1", { originId: "browser", sentDuringEpoch: 3 }],
				]),
			},
			projected,
			{
				live: false,
				active: true,
				turnEpoch: 8,
			},
		);
		expect(replayed[2]).toMatchObject({ sentDuringEpoch: 3 });
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
		const first = deriveTranscriptMessages(firstState, [], {
			live: false,
			active: false,
			turnEpoch: 0,
		});
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
		const second = deriveTranscriptMessages(refreshed, sticky, {
			live: true,
			active: true,
			turnEpoch: 1,
		});
		expect(second.find((message) => message.type === "thinking")).toMatchObject(
			{ done: true, duration: 42, text: "why now" },
		);
		expect(second.find((message) => message.type === "tool")).toMatchObject({
			status: "completed",
			input: { path: "a" },
			metadata: { sessionId: "child" },
		});
	});

	it("infers queued user only for a live new row", () => {
		const user: HistoryMessage = {
			id: "u",
			role: "user",
			parts: [{ id: "p", type: "text", text: "hello" }],
		};
		const state = applyTranscriptEnvelope(entry(), snapshot([user], 1));
		const catchup = deriveTranscriptMessages(state, [], {
			live: false,
			active: true,
			turnEpoch: 2,
			newUserIds: new Set(["u"]),
		});
		expect(catchup[0]).not.toHaveProperty("sentDuringEpoch");
		const live = deriveTranscriptMessages(state, [], {
			live: true,
			active: true,
			turnEpoch: 2,
			newUserIds: new Set(["u"]),
		});
		expect(live[0]).toMatchObject({ sentDuringEpoch: 2 });
		const optimistic: ChatMessage = {
			type: "user",
			uuid: "local",
			text: "hello",
			originId: "browser",
		};
		const reconciled = deriveTranscriptMessages(state, [...live, optimistic], {
			live: true,
			active: true,
			turnEpoch: 3,
		});
		expect(reconciled).toHaveLength(2);
		expect(reconciled[1]).toBe(optimistic);
	});

	// After a reload nothing local remembers the send; the rows still show it.
	it("restores a queued prompt from a reply still being written above it", () => {
		const prompt = (id: string, created: number): HistoryMessage => ({
			id,
			role: "user",
			time: { created },
			parts: [{ id: `${id}-text`, type: "text", text: id }],
		});
		const reply = (id: string, created: number, completed?: number) => ({
			...row(id, created, id),
			time: { created, ...(completed === undefined ? {} : { completed }) },
		});
		const queuedEpochs = (
			rows: HistoryMessage[],
			options = { live: true, active: true },
		) =>
			deriveTranscriptMessages(
				applyTranscriptEnvelope(entry(), snapshot(rows, 1)),
				[],
				{ ...options, turnEpoch: 3 },
			)
				.filter((message) => message.type === "user")
				.map((message) => message.sentDuringEpoch);

		// Claude stamps a row's last write as `completed`; OpenCode omits it mid-run.
		expect(
			queuedEpochs([prompt("one", 1), reply("a", 2, 50), prompt("next", 10)]),
		).toEqual([undefined, 3]);
		expect(
			queuedEpochs([prompt("one", 1), reply("a", 2), prompt("next", 10)]),
		).toEqual([undefined, 3]);
		// The reply had finished before the prompt was sent.
		expect(
			queuedEpochs([prompt("one", 1), reply("a", 2, 5), prompt("next", 10)]),
		).toEqual([undefined, undefined]);
		// The prompt has started: its own reply is below it.
		expect(
			queuedEpochs([
				prompt("one", 1),
				reply("a", 2, 50),
				prompt("next", 10),
				reply("b", 60),
			]),
		).toEqual([undefined, undefined]);
		// Nothing is running any more.
		expect(
			queuedEpochs([prompt("one", 1), reply("a", 2, 50), prompt("next", 10)], {
				live: true,
				active: false,
			}),
		).toEqual([undefined, undefined]);
	});

	it("does not adopt a repeated send into an older projected user row", () => {
		const user = (id: string): HistoryMessage => ({
			id,
			role: "user",
			parts: [{ id: `${id}-text`, type: "text", text: "yes" }],
		});
		const first = applyTranscriptEnvelope(entry(), snapshot([user("old")], 1));
		const shown = derive(first, [], { live: true, active: true, turnEpoch: 1 });
		const optimistic: ChatMessage = {
			type: "user",
			uuid: "local",
			text: "yes",
		};
		const waiting = derive(first, [...shown.messages, optimistic], {
			live: true,
			active: true,
			turnEpoch: 2,
		});
		expect(waiting.messages).toHaveLength(2);
		expect(waiting.messages[1]).toBe(optimistic);
		expect(waiting.carried.size).toBe(0);
		const second = applyTranscriptEnvelope(first, {
			_tag: "upsert",
			sequence: 2,
			item: item(user("new")),
		});
		const adopted = derive(second, waiting.messages, {
			live: true,
			active: true,
			turnEpoch: 2,
			newUserIds: new Set(["new"]),
		});
		expect(adopted.messages.map((message) => message.uuid)).toEqual([
			"new/user",
			"old/user",
		]);
		expect(adopted.carried.has("new")).toBe(true);
		expect(first.carriedUsers.size).toBe(0);
	});

	it("adopts a send whose row is created before its text part", () => {
		const optimistic: ChatMessage = { type: "user", uuid: "local", text: "hi" };
		const created = applyTranscriptEnvelope(entry(), {
			_tag: "upsert",
			sequence: 1,
			item: item({ id: "u", role: "user", parts: [] }),
		});
		const waiting = derive(created, [optimistic], {
			live: true,
			active: true,
			turnEpoch: 1,
		});
		expect(waiting.messages).toEqual([optimistic]);
		const texted = applyTranscriptEnvelope(created, {
			_tag: "upsert",
			sequence: 2,
			item: item({
				id: "u",
				role: "user",
				parts: [{ id: "u-text", type: "text", text: "hi" }],
			}),
		});
		const adopted = derive(texted, waiting.messages, {
			live: true,
			active: true,
			turnEpoch: 1,
		});
		expect(adopted.messages.map((message) => message.uuid)).toEqual(["u/user"]);
		expect(adopted.carried.has("u")).toBe(true);
	});
});
