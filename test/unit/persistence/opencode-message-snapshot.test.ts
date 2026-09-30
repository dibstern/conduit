import { afterEach, describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import type { Message } from "../../../src/lib/instance/sdk-types.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	snapshotPayload,
	synthesizeSnapshotEvent,
} from "../../../src/lib/provider/opencode/opencode-history-backfill.js";
import {
	OpenCodeRuntimeEventTranslator,
	opencodeSessionCreatedRuntimeEvent,
} from "../../../src/lib/provider/opencode/opencode-runtime-event-translator.js";
import type {
	HistoryMessage,
	HistoryMessagePart,
} from "../../../src/lib/shared-types.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../helpers/effect-projection-harness.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";

const sessionId = "snapshot-session";
const user: Message = {
	id: "u1",
	sessionID: sessionId,
	role: "user",
	time: { created: 10 },
	agent: "build",
	model: { providerID: "anthropic", modelID: "sonnet" },
	parts: [{ id: "user-text", type: "text", text: "prompt" }],
};
const assistant: Message = {
	id: "a1",
	sessionID: sessionId,
	role: "assistant",
	parentID: "u1",
	time: { created: 20, completed: 40 },
	cost: 0.5,
	finish: "stop",
	modelID: "sonnet",
	providerID: "anthropic",
	mode: "build",
	tokens: { input: 10, output: 5, cache: { read: 2, write: 1 } },
	parts: [
		{ id: "step-start", type: "step-start", time: { start: 20 } },
		{ id: "reason", type: "reasoning", text: "thinking" },
		{
			id: "tool",
			type: "tool",
			tool: "bash",
			callID: "call-1",
			state: {
				status: "completed",
				input: { command: "pwd" },
				output: "/tmp",
				time: { start: 25, end: 30 },
			},
		},
		{
			id: "file",
			type: "file",
			mime: "text/plain",
			filename: "a.txt",
			url: "file://a",
		},
		{ id: "answer", type: "text", text: "done" },
		{ id: "step-finish", type: "step-finish", cost: 0.5 },
	],
};

function runtime(
	type: string,
	eventId: string,
	data: Record<string, unknown>,
	createdAt: number,
): ProviderRuntimeEvent {
	return {
		eventId,
		type: type as ProviderRuntimeEvent["type"],
		providerId: "opencode",
		sessionId,
		providerRefs: {},
		rawSource: { kind: "opencode.sse" },
		createdAt,
		data,
	};
}

describe("OpenCode message snapshots", () => {
	const harnesses: EffectProjectionHarness[] = [];
	function makeHarness() {
		const harness = makeEffectProjectionHarness();
		harnesses.push(harness);
		return harness;
	}
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.dispose();
	});

	it("round-trips every REST history field and ordered part through projection", async () => {
		const harness = makeHarness();
		await harness.ingest(
			opencodeSessionCreatedRuntimeEvent(sessionId, "instance"),
		);
		const secondStep: Message = {
			...assistant,
			id: "a2",
			time: { created: 41, completed: 50 },
			cost: 0.25,
			finish: "stop",
			parts: [{ id: "answer-2", type: "text", text: "more" }],
		};
		const errored: Message = {
			...assistant,
			id: "a3",
			parentID: "u1",
			time: { created: 51, completed: 60 },
			finish: "error",
			error: { name: "ProviderError", message: "failed" },
			parts: [{ id: "error-text", type: "text", text: "failed" }],
		};
		const rest = [user, assistant, secondStep, errored];
		await harness.ingestBatch(
			rest.map((message) => synthesizeSnapshotEvent(sessionId, message)),
		);
		const rows = await harness.sessionMessagesWithParts(sessionId);
		const history = messageRowsToHistory(rows, { pageSize: 50 }).messages;
		const expectedHistory: HistoryMessage[] = rest.map((message) => {
			const normalized = snapshotPayload(message).message;
			return {
				...normalized,
				role: normalized.role === "user" ? "user" : "assistant",
				isBackfilled: true,
				parts: normalized.parts.map((part) => ({
					...part,
					type: part.type as HistoryMessagePart["type"],
				})),
			};
		});
		expect(history).toEqual(expectedHistory);
		const withoutUuid = (messages: ReturnType<typeof historyToChatMessages>) =>
			messages.map(({ uuid: _uuid, ...item }) => item);
		expect(withoutUuid(historyToChatMessages(history))).toEqual(
			withoutUuid(historyToChatMessages(expectedHistory)),
		);
		expect(
			rows.find((row) => row.id === "a1")?.parts.map((part) => part.type),
		).toEqual(assistant.parts?.map((part) => part.type));
		expect(rows.find((row) => row.id === "a1")?.rest_digest).toBe(
			snapshotPayload(assistant).digest,
		);
		const [turn] = await harness.query<{
			state: string;
			assistant_message_id: string;
			tokens_in: number;
			tokens_out: number;
		}>(
			"SELECT state, assistant_message_id, tokens_in, tokens_out FROM turns WHERE id = 'u1'",
		);
		expect(turn).toMatchObject({
			state: "completed",
			assistant_message_id: "a3",
			tokens_in: 30,
			tokens_out: 15,
		});
	});

	it("reparents a non-displayed assistant in both directions and replays the result", async () => {
		const live = makeHarness();
		await live.ingest(
			opencodeSessionCreatedRuntimeEvent(sessionId, "instance"),
		);
		const secondUser: Message = {
			...user,
			id: "u2",
			time: { created: 11 },
			parts: [{ id: "u2-text", type: "text", text: "other" }],
		};
		const first: Message = { ...assistant, tokens: { input: 10, output: 1 } };
		const second: Message = {
			...assistant,
			id: "a2",
			time: { created: 21, completed: 41 },
			tokens: { input: 20, output: 2 },
			parts: [{ id: "a2-text", type: "text", text: "second" }],
		};
		await live.ingestBatch(
			[user, secondUser, first, second].map((message) =>
				synthesizeSnapshotEvent(sessionId, message),
			),
		);
		const turns = () =>
			live.query<{
				id: string;
				assistant_message_id: string | null;
				tokens_in: number | null;
				state: string;
			}>(
				"SELECT id, assistant_message_id, tokens_in, state FROM turns ORDER BY id",
			);
		const moved = { ...first, parentID: "u2" };
		await live.ingest(synthesizeSnapshotEvent(sessionId, moved));
		expect(await turns()).toEqual([
			{
				id: "u1",
				assistant_message_id: "a2",
				tokens_in: 20,
				state: "completed",
			},
			{
				id: "u2",
				assistant_message_id: "a1",
				tokens_in: 10,
				state: "completed",
			},
		]);
		await live.ingest(
			synthesizeSnapshotEvent(
				sessionId,
				first,
				synthesizeSnapshotEvent(sessionId, moved).eventId,
			),
		);
		expect(await turns()).toEqual([
			{
				id: "u1",
				assistant_message_id: "a2",
				tokens_in: 30,
				state: "completed",
			},
			{
				id: "u2",
				assistant_message_id: null,
				tokens_in: null,
				state: "pending",
			},
		]);
		const replay = makeHarness();
		await replay.reproject(await live.storedEvents(sessionId));
		expect(
			await replay.query(
				"SELECT id, assistant_message_id, tokens_in, state FROM turns ORDER BY id",
			),
		).toEqual(await turns());
	});

	it("attaches an assistant snapshotted before its user, including on replay", async () => {
		const live = makeHarness();
		await live.ingest(
			opencodeSessionCreatedRuntimeEvent(sessionId, "instance"),
		);
		await live.ingest(synthesizeSnapshotEvent(sessionId, assistant));
		await live.ingest(synthesizeSnapshotEvent(sessionId, user));
		const ownership = () =>
			live.query<{ turn_id: string | null }>(
				"SELECT turn_id FROM messages WHERE id = 'a1'",
			);
		expect(await ownership()).toEqual([{ turn_id: "u1" }]);
		const replay = makeHarness();
		await replay.reproject(await live.storedEvents(sessionId));
		expect(
			await replay.query("SELECT turn_id FROM messages WHERE id = 'a1'"),
		).toEqual(await ownership());
	});

	it("resets reconciled completeness when rebuilding the read model from events", async () => {
		const live = makeHarness();
		await live.ingest(
			opencodeSessionCreatedRuntimeEvent(sessionId, "instance"),
		);
		await live.ingestBatch(
			[user, assistant].map((message) =>
				synthesizeSnapshotEvent(sessionId, message),
			),
		);
		await live.query(
			"UPDATE sessions SET history_complete = 1 WHERE id = 'snapshot-session'",
		);
		expect(
			await live.query(
				"SELECT history_complete FROM sessions WHERE id = 'snapshot-session'",
			),
		).toEqual([{ history_complete: 1 }]);
		const replay = makeHarness();
		await replay.reproject(await live.storedEvents(sessionId));
		expect(
			await replay.query(
				"SELECT history_complete FROM sessions WHERE id = 'snapshot-session'",
			),
		).toEqual([{ history_complete: 0 }]);
	});

	it("attaches a live assistant to its known parent even after a newer turn", async () => {
		const live = makeHarness();
		await live.ingest(
			opencodeSessionCreatedRuntimeEvent(sessionId, "instance"),
		);
		await live.ingestBatch(
			[
				user,
				{
					...user,
					id: "u2",
					time: { created: 11 },
					parts: [{ id: "u2-text", type: "text", text: "other" }],
				},
			].map((message) => synthesizeSnapshotEvent(sessionId, message)),
		);
		const translator = new OpenCodeRuntimeEventTranslator();
		await live.ingestBatch(
			translator.translate(
				makeSSEEvent("message.updated", {
					sessionID: sessionId,
					info: {
						id: "live-a1",
						role: "assistant",
						parentID: "u1",
						time: { created: 30 },
					},
				}),
				sessionId,
			) ?? [],
		);
		expect((await live.storedEvents(sessionId)).at(-1)?.data).toMatchObject({
			parentID: "u1",
		});
		expect(
			await live.query(
				"SELECT id, parent_id, turn_id FROM messages WHERE id = 'live-a1'",
			),
		).toEqual([{ id: "live-a1", parent_id: "u1", turn_id: "u1" }]);
		expect(
			await live.query(
				"SELECT id, assistant_message_id, state FROM turns ORDER BY id",
			),
		).toEqual([
			{ id: "u1", assistant_message_id: "live-a1", state: "running" },
			{ id: "u2", assistant_message_id: null, state: "pending" },
		]);
		await live.ingest(
			runtime(
				"tool.started",
				"live-tool-started",
				{
					messageId: "live-a1",
					partId: "live-tool",
					toolName: "bash",
					callId: "live-call",
					input: { tool: "Unknown", name: "bash", raw: { command: "pwd" } },
				},
				31,
			),
		);
		expect(
			await live.query(
				"SELECT id, assistant_message_id, state FROM turns ORDER BY id",
			),
		).toEqual([
			{ id: "u1", assistant_message_id: "live-a1", state: "running" },
			{ id: "u2", assistant_message_id: null, state: "pending" },
		]);
		const replay = makeHarness();
		await replay.reproject(await live.storedEvents(sessionId));
		expect(
			await replay.query(
				"SELECT id, assistant_message_id, state FROM turns ORDER BY id",
			),
		).toEqual(
			await live.query(
				"SELECT id, assistant_message_id, state FROM turns ORDER BY id",
			),
		);
	});

	it("replaces live state, ignores late completion, and replays to identical rows", async () => {
		const live = makeHarness();
		await live.ingest(
			opencodeSessionCreatedRuntimeEvent(sessionId, "instance"),
		);
		await live.ingestBatch([
			runtime(
				"message.created",
				"live-user",
				{ messageId: "u1", role: "user", sessionId },
				10,
			),
			runtime(
				"message.created",
				"live-assistant",
				{ messageId: "a1", role: "assistant", sessionId },
				20,
			),
			runtime(
				"text.delta",
				"live-text",
				{ messageId: "a1", partId: "answer", text: "old" },
				21,
			),
			runtime(
				"turn.completed",
				"live-complete",
				{ messageId: "a1", cost: 0.1, tokens: { input: 2, output: 1 } },
				30,
			),
		]);
		await live.ingestBatch([
			synthesizeSnapshotEvent(sessionId, user),
			synthesizeSnapshotEvent(sessionId, assistant),
		]);
		const before = (await live.storedEvents(sessionId)).length;
		await live.ingest(synthesizeSnapshotEvent(sessionId, assistant));
		expect((await live.storedEvents(sessionId)).length).toBe(before);
		await live.ingest(
			runtime(
				"turn.completed",
				"late-complete",
				{ messageId: "a1", tokens: { input: 10, output: 5 } },
				41,
			),
		);
		const corrected: Message = {
			...assistant,
			cost: 0.75,
			tokens: { input: 12, output: 6 },
			parts: [
				...(assistant.parts ?? []),
				{ id: "late-step", type: "step-finish" },
			],
		};
		await live.ingest(synthesizeSnapshotEvent(sessionId, corrected));
		const projected = await live.sessionMessagesWithParts(sessionId);
		expect(
			messageRowsToHistory(projected, { pageSize: 50 }).messages[1],
		).toEqual(snapshotPayload(corrected).message);
		const replay = makeHarness();
		await replay.reproject(await live.storedEvents(sessionId));
		for (const table of ["messages", "message_parts", "turns"] as const) {
			const statement = `SELECT * FROM ${table} ORDER BY id`;
			const current = await live.query<Record<string, unknown>>(statement);
			const rebuilt = await replay.query<Record<string, unknown>>(statement);
			expect(rebuilt.map(({ version: _version, ...row }) => row)).toEqual(
				current.map(({ version: _version, ...row }) => row),
			);
		}
	});
});
