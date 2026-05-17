import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKTaskStartedMessage } from "@anthropic-ai/claude-agent-sdk";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Fiber, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import {
	ClaudeEventPersistEffectTag,
	makeClaudeEventPersistEffect,
} from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makeEffectSqlMigrator } from "../../../src/lib/persistence/effect/migrations.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
} from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../../../src/lib/persistence/effect/projector-cursor-effect.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import type {
	MessagePartRow,
	MessageRow,
	MessageWithParts,
} from "../../../src/lib/persistence/read-model-types.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import { ClaudeProviderInstance } from "../../../src/lib/provider/claude/claude-provider-instance.js";
import {
	type ClaudeSubagentSdk,
	claudeSubagentSessionId,
	makeClaudeSubagentMaterializer,
} from "../../../src/lib/provider/claude/claude-subagent-materializer.js";
import type {
	Query,
	SDKMessage,
	SDKPartialAssistantMessage,
	SessionMessage,
} from "../../../src/lib/provider/claude/types.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";
import {
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../helpers/mock-sdk.js";

function makePersistenceLayer(filename: string) {
	const sqliteLayer = SqliteNode.layer({ filename }).pipe(
		Layer.provide(Reactivity.layer),
	);
	const schemaLayer = Layer.effectDiscard(makeEffectSqlMigrator()).pipe(
		Layer.provide(sqliteLayer),
	);
	const baseLayer = Layer.merge(sqliteLayer, schemaLayer);
	const eventStoreLayer = Layer.effect(
		EventStoreEffectTag,
		makeEventStoreEffect,
	).pipe(Layer.provide(baseLayer));
	const cursorLayer = Layer.effect(
		ProjectorCursorEffectTag,
		makeProjectorCursorEffect,
	).pipe(Layer.provide(baseLayer));
	const projectionRunnerLayer = Layer.effect(
		ProjectionRunnerEffectTag,
		makeProjectionRunnerEffect(createAllEffectProjectors()),
	).pipe(Layer.provide(Layer.merge(cursorLayer, baseLayer)));
	const persistLayer = Layer.effect(
		ClaudeEventPersistEffectTag,
		makeClaudeEventPersistEffect,
	).pipe(
		Layer.provide(
			Layer.mergeAll(baseLayer, eventStoreLayer, projectionRunnerLayer),
		),
	);
	return Layer.mergeAll(
		baseLayer,
		eventStoreLayer,
		cursorLayer,
		projectionRunnerLayer,
		persistLayer,
	);
}

function sessionMessage(
	type: "user" | "assistant",
	uuid: string,
	text: string,
): SessionMessage {
	return {
		type,
		uuid,
		session_id: "sdk-parent",
		parent_tool_use_id: null,
		message: {
			role: type,
			content: [{ type: "text", text }],
		},
	};
}

function messageRowsWithParts(
	messages: readonly MessageRow[],
	parts: readonly MessagePartRow[],
): MessageWithParts[] {
	const partsByMessage = new Map<string, MessagePartRow[]>();
	for (const part of parts) {
		const existing = partsByMessage.get(part.message_id);
		if (existing) {
			existing.push(part);
		} else {
			partsByMessage.set(part.message_id, [part]);
		}
	}

	return messages.map((message) => ({
		...message,
		parts: partsByMessage.get(message.id) ?? [],
	}));
}

function describeCause(cause: unknown): string {
	if (cause && typeof cause === "object") {
		const record = cause as Record<string, unknown>;
		return JSON.stringify({
			tag: record["_tag"],
			operation: record["operation"],
			cause: String(record["cause"]),
		});
	}
	return String(cause);
}

describe("Claude subagent materialization pipeline", () => {
	it("links the parent Task tool to a persisted child transcript", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-claude-pipeline-"));
		const filename = join(dir, "events.db");
		try {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const eventStore = yield* EventStoreEffectTag;
					const projectionRunner = yield* ProjectionRunnerEffectTag;
					const persist = yield* ClaudeEventPersistEffectTag;
					const sql = yield* SqlClient.SqlClient;

					const appendProject = (event: CanonicalEvent) =>
						eventStore.append(event).pipe(
							Effect.mapError(
								(cause) =>
									new Error(
										`append ${event.type} failed: ${JSON.stringify(event.data)} (${describeCause(cause)})`,
									),
							),
							Effect.flatMap((stored) =>
								projectionRunner
									.projectEvent(stored)
									.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
							),
						);

					const parentSessionId = "parent-session";
					const parentClaudeSessionId = "sdk-parent";
					const sdkSubagentId = "task-1";
					const childSessionId = claudeSubagentSessionId({
						parentConduitSessionId: parentSessionId,
						parentClaudeSessionId,
						sdkSubagentId,
					});
					yield* sql`
						INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
						VALUES (${parentSessionId}, 'claude', 'Parent', 'idle', 1, 1)`;

					const sdk: ClaudeSubagentSdk = {
						listSubagents: vi.fn(async () => [sdkSubagentId]),
						getSubagentMessages: vi.fn(async () => [
							sessionMessage("user", "sub-user-1", "Inspect auth"),
							sessionMessage("assistant", "sub-assistant-1", "Auth is fine"),
						]),
					};
					const materializeSubagents = makeClaudeSubagentMaterializer({
						sdk,
						persist,
					});
					const relaySink = createRelayEventSink({
						sessionId: parentSessionId,
						send: vi.fn(),
						persist: { persistEvent: appendProject },
					});

					const messageStart: SDKPartialAssistantMessage = {
						type: "stream_event",
						event: {
							type: "message_start",
							message: {
								id: "msg-parent",
								type: "message",
								role: "assistant",
								content: [],
								container: null,
								context_management: null,
								model: "claude-sonnet-4-5",
								stop_reason: null,
								stop_sequence: null,
								usage: {
									cache_creation: null,
									cache_creation_input_tokens: null,
									cache_read_input_tokens: null,
									inference_geo: null,
									input_tokens: 0,
									iterations: null,
									output_tokens: 0,
									server_tool_use: null,
									service_tier: null,
									speed: null,
								},
							},
						},
						parent_tool_use_id: null,
						uuid: "00000000-0000-0000-0000-000000000101",
						session_id: parentClaudeSessionId,
					};
					const taskToolUse: SDKPartialAssistantMessage = {
						type: "stream_event",
						event: {
							type: "content_block_start",
							index: 0,
							content_block: {
								type: "tool_use",
								id: "task-tool-1",
								name: "Task",
								input: {
									description: "Audit auth",
									prompt: "Inspect auth",
									subagent_type: "explore",
								},
							},
						},
						parent_tool_use_id: null,
						uuid: "00000000-0000-0000-0000-000000000102",
						session_id: parentClaudeSessionId,
					};
					const taskToolStop: SDKPartialAssistantMessage = {
						type: "stream_event",
						event: { type: "content_block_stop", index: 0 },
						parent_tool_use_id: null,
						uuid: "00000000-0000-0000-0000-000000000103",
						session_id: parentClaudeSessionId,
					};
					const taskStarted: SDKTaskStartedMessage = {
						type: "system",
						subtype: "task_started",
						task_id: sdkSubagentId,
						tool_use_id: "task-tool-1",
						description: "Audit auth",
						task_type: "explore",
						prompt: "Inspect auth",
						uuid: "00000000-0000-0000-0000-000000000104",
						session_id: parentClaudeSessionId,
					};
					const queryMessages = [
						messageStart,
						taskToolUse,
						taskToolStop,
						taskStarted,
						makeSuccessResult({
							uuid: "00000000-0000-0000-0000-000000000105",
							session_id: parentClaudeSessionId,
						}),
					] satisfies SDKMessage[];

					const instance = new ClaudeProviderInstance({
						workspaceRoot: dir,
						queryFactory: () => createMockQuery(queryMessages),
						materializeSubagents,
					});
					yield* instance.sendTurnEffect(
						makeBaseSendTurnInput({
							sessionId: parentSessionId,
							workspaceRoot: dir,
							providerState: { resumeSessionId: parentClaudeSessionId },
							eventSink: relaySink,
						}),
					);
					const waitForFinalCatchUp = () =>
						Effect.gen(function* () {
							const deadline = Date.now() + 2_000;
							while (Date.now() < deadline) {
								const rows = yield* sql<MessageRow>`
									SELECT * FROM messages WHERE session_id = ${childSessionId}`;
								if (rows.length >= 2) return;
								yield* Effect.promise(
									() => new Promise<void>((resolve) => setTimeout(resolve, 25)),
								);
							}
						});
					yield* waitForFinalCatchUp();

					const parentMessages = yield* sql<MessageRow>`
						SELECT * FROM messages WHERE session_id = ${parentSessionId} ORDER BY created_at ASC, id ASC`;
					const parentParts = yield* sql<MessagePartRow>`
						SELECT * FROM message_parts WHERE message_id IN (SELECT id FROM messages WHERE session_id = ${parentSessionId}) ORDER BY message_id, sort_order`;
					const childMessages = yield* sql<MessageRow>`
						SELECT * FROM messages WHERE session_id = ${childSessionId} ORDER BY created_at ASC, id ASC`;
					const childParts = yield* sql<MessagePartRow>`
						SELECT * FROM message_parts WHERE message_id IN (SELECT id FROM messages WHERE session_id = ${childSessionId}) ORDER BY message_id, sort_order`;
					const childRows = yield* sql<{
						parent_id: string | null;
						provider_sid: string | null;
					}>`SELECT parent_id, provider_sid FROM sessions WHERE id = ${childSessionId}`;
					const roots = yield* sql<{ id: string }>`
						SELECT id FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC`;
					const allSessions = yield* sql<{ id: string }>`
						SELECT id FROM sessions ORDER BY updated_at DESC`;

					return {
						childSessionId,
						parentChat: historyToChatMessages(
							messageRowsToHistory(
								messageRowsWithParts(parentMessages, parentParts),
								{ pageSize: 50 },
							).messages,
						),
						childChat: historyToChatMessages(
							messageRowsToHistory(
								messageRowsWithParts(childMessages, childParts),
								{ pageSize: 50 },
							).messages,
						),
						child: childRows[0],
						rootIds: roots.map((row) => row.id),
						allSessionIds: allSessions.map((row) => row.id),
					};
				}).pipe(Effect.provide(makePersistenceLayer(filename))),
			);

			const taskMessage = result.parentChat.find(
				(message): message is Extract<ChatMessage, { type: "tool" }> =>
					message.type === "tool" && message.name === "Task",
			);
			expect(taskMessage).toBeDefined();
			expect(taskMessage?.metadata?.["childSessionId"]).toBe(
				result.childSessionId,
			);
			expect(taskMessage?.metadata?.["providerTaskId"]).toBe("task-1");

			expect(result.child).toEqual({
				parent_id: "parent-session",
				provider_sid: "task-1",
			});
			expect(result.rootIds).toContain("parent-session");
			expect(result.rootIds).not.toContain(result.childSessionId);
			expect(result.allSessionIds).toContain(result.childSessionId);
			expect(result.childChat).toEqual([
				expect.objectContaining({ type: "user", text: "Inspect auth" }),
				expect.objectContaining({ type: "assistant", rawText: "Auth is fine" }),
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates and streams a child session while the parent Task is still running", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-claude-live-pipeline-"));
		const filename = join(dir, "events.db");
		let releaseResult: (() => void) | undefined;
		try {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const eventStore = yield* EventStoreEffectTag;
					const projectionRunner = yield* ProjectionRunnerEffectTag;
					const persist = yield* ClaudeEventPersistEffectTag;
					const sql = yield* SqlClient.SqlClient;

					const appendProject = (event: CanonicalEvent) =>
						eventStore.append(event).pipe(
							Effect.mapError(
								(cause) =>
									new Error(
										`append ${event.type} failed: ${JSON.stringify(event.data)} (${describeCause(cause)})`,
									),
							),
							Effect.flatMap((stored) =>
								projectionRunner
									.projectEvent(stored)
									.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
							),
						);
					const readProjectedState = () =>
						Effect.gen(function* () {
							const parentMessages = yield* sql<MessageRow>`
								SELECT * FROM messages WHERE session_id = ${parentSessionId} ORDER BY created_at ASC, id ASC`;
							const parentParts = yield* sql<MessagePartRow>`
								SELECT * FROM message_parts WHERE message_id IN (SELECT id FROM messages WHERE session_id = ${parentSessionId}) ORDER BY message_id, sort_order`;
							const childMessages = yield* sql<MessageRow>`
								SELECT * FROM messages WHERE session_id = ${childSessionId} ORDER BY created_at ASC, id ASC`;
							const childParts = yield* sql<MessagePartRow>`
								SELECT * FROM message_parts WHERE message_id IN (SELECT id FROM messages WHERE session_id = ${childSessionId}) ORDER BY message_id, sort_order`;
							const childRows = yield* sql<{
								parent_id: string | null;
								provider_sid: string | null;
							}>`SELECT parent_id, provider_sid FROM sessions WHERE id = ${childSessionId}`;
							return {
								parentChat: historyToChatMessages(
									messageRowsToHistory(
										messageRowsWithParts(parentMessages, parentParts),
										{ pageSize: 50 },
									).messages,
								),
								childChat: historyToChatMessages(
									messageRowsToHistory(
										messageRowsWithParts(childMessages, childParts),
										{ pageSize: 50 },
									).messages,
								),
								child: childRows[0],
							};
						});
					const hasProjectedChildTranscript = (state: {
						readonly child:
							| { parent_id: string | null; provider_sid: string | null }
							| undefined;
						readonly childChat: readonly ChatMessage[];
					}) =>
						state.child?.parent_id === parentSessionId &&
						state.child.provider_sid === sdkSubagentId &&
						state.childChat.some(
							(message) =>
								message.type === "user" && message.text === "Inspect auth",
						) &&
						state.childChat.some(
							(message) =>
								message.type === "assistant" &&
								message.rawText === "Auth is fine",
						);
					const waitForProjectedChildTranscript = () =>
						Effect.gen(function* () {
							const timeoutMs = 2_000;
							const pollIntervalMs = 25;
							const deadline = Date.now() + timeoutMs;
							let state = yield* readProjectedState();
							while (
								!hasProjectedChildTranscript(state) &&
								Date.now() < deadline
							) {
								yield* Effect.promise(
									() =>
										new Promise<void>((resolve) =>
											setTimeout(resolve, pollIntervalMs),
										),
								);
								state = yield* readProjectedState();
							}
							return state;
						});

					const parentSessionId = "parent-live-session";
					const parentClaudeSessionId = "sdk-parent-live";
					const sdkSubagentId = "task-live-1";
					const childSessionId = claudeSubagentSessionId({
						parentConduitSessionId: parentSessionId,
						parentClaudeSessionId,
						sdkSubagentId,
					});
					yield* sql`
						INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
						VALUES (${parentSessionId}, 'claude', 'Parent', 'idle', 1, 1)`;

					let getSubagentMessagesCalls = 0;
					const transcript = [
						sessionMessage("user", "sub-user-live-1", "Inspect auth"),
						sessionMessage("assistant", "sub-assistant-live-1", "Auth is fine"),
					];
					const sdk: ClaudeSubagentSdk = {
						listSubagents: vi.fn(async () => [sdkSubagentId]),
						getSubagentMessages: vi.fn(async () => {
							getSubagentMessagesCalls += 1;
							if (getSubagentMessagesCalls === 1) return [];
							return transcript;
						}),
					};
					const materializeSubagents = makeClaudeSubagentMaterializer({
						sdk,
						persist,
					});
					const relaySink = createRelayEventSink({
						sessionId: parentSessionId,
						send: vi.fn(),
						persist: { persistEvent: appendProject },
					});

					const messageStart: SDKPartialAssistantMessage = {
						type: "stream_event",
						event: {
							type: "message_start",
							message: {
								id: "msg-parent-live",
								type: "message",
								role: "assistant",
								content: [],
								container: null,
								context_management: null,
								model: "claude-sonnet-4-5",
								stop_reason: null,
								stop_sequence: null,
								usage: {
									cache_creation: null,
									cache_creation_input_tokens: null,
									cache_read_input_tokens: null,
									inference_geo: null,
									input_tokens: 0,
									iterations: null,
									output_tokens: 0,
									server_tool_use: null,
									service_tier: null,
									speed: null,
								},
							},
						},
						parent_tool_use_id: null,
						uuid: "00000000-0000-0000-0000-000000000201",
						session_id: parentClaudeSessionId,
					};
					const taskToolUse: SDKPartialAssistantMessage = {
						type: "stream_event",
						event: {
							type: "content_block_start",
							index: 0,
							content_block: {
								type: "tool_use",
								id: "task-tool-live-1",
								name: "Task",
								input: {
									description: "Audit auth",
									prompt: "Inspect auth",
									subagent_type: "explore",
								},
							},
						},
						parent_tool_use_id: null,
						uuid: "00000000-0000-0000-0000-000000000202",
						session_id: parentClaudeSessionId,
					};
					const taskToolStop: SDKPartialAssistantMessage = {
						type: "stream_event",
						event: { type: "content_block_stop", index: 0 },
						parent_tool_use_id: null,
						uuid: "00000000-0000-0000-0000-000000000203",
						session_id: parentClaudeSessionId,
					};
					const taskStarted: SDKTaskStartedMessage = {
						type: "system",
						subtype: "task_started",
						task_id: sdkSubagentId,
						tool_use_id: "task-tool-live-1",
						description: "Audit auth",
						task_type: "explore",
						prompt: "Inspect auth",
						uuid: "00000000-0000-0000-0000-000000000204",
						session_id: parentClaudeSessionId,
					};
					let taskStartedTranslated: (() => void) | undefined;
					const afterTaskStarted = new Promise<void>((resolve) => {
						taskStartedTranslated = resolve;
					});
					const resultReady = new Promise<void>((resolve) => {
						releaseResult = resolve;
					});
					const gen = (async function* () {
						yield messageStart as SDKMessage;
						yield taskToolUse as SDKMessage;
						yield taskToolStop as SDKMessage;
						yield taskStarted as SDKMessage;
						for (const message of transcript) {
							yield {
								...message,
								parent_tool_use_id: "task-tool-live-1",
							} as unknown as SDKMessage;
						}
						taskStartedTranslated?.();
						await resultReady;
						yield makeSuccessResult({
							uuid: "00000000-0000-0000-0000-000000000205",
							session_id: parentClaudeSessionId,
						}) as SDKMessage;
					})();
					const query = Object.assign(gen, {
						interrupt: vi.fn(async () => {}),
						close: vi.fn(),
						setModel: vi.fn(async () => {}),
						setPermissionMode: vi.fn(async () => {}),
						streamInput: vi.fn(async () => {}),
						setMaxThinkingTokens: vi.fn(async () => {}),
						applyFlagSettings: vi.fn(async () => {}),
						initializationResult: vi.fn(async () => ({})),
						supportedCommands: vi.fn(async () => []),
						supportedModels: vi.fn(async () => []),
						supportedAgents: vi.fn(async () => []),
						mcpServerStatus: vi.fn(async () => []),
						getContextUsage: vi.fn(async () => ({})),
						reloadPlugins: vi.fn(async () => ({})),
						accountInfo: vi.fn(async () => ({})),
						rewindFiles: vi.fn(async () => ({ canRewind: false })),
						seedReadState: vi.fn(async () => {}),
						reconnectMcpServer: vi.fn(async () => {}),
						toggleMcpServer: vi.fn(async () => {}),
						setMcpServers: vi.fn(async () => ({})),
						stopTask: vi.fn(async () => {}),
						next: gen.next.bind(gen),
						return: gen.return.bind(gen),
						throw: gen.throw.bind(gen),
						[Symbol.asyncIterator]: () => gen,
					}) as unknown as Query;
					const instance = new ClaudeProviderInstance({
						workspaceRoot: dir,
						queryFactory: () => query,
						subagentSdk: sdk,
						materializeSubagents,
					});
					const turnFiber = yield* Effect.fork(
						instance.sendTurnEffect(
							makeBaseSendTurnInput({
								sessionId: parentSessionId,
								workspaceRoot: dir,
								providerState: { resumeSessionId: parentClaudeSessionId },
								eventSink: relaySink,
							}),
						),
					);

					yield* Effect.promise(() => afterTaskStarted);
					const immediate = yield* readProjectedState();
					const beforeResult = yield* waitForProjectedChildTranscript();
					const getSubagentMessagesCallsBeforeResult = getSubagentMessagesCalls;
					releaseResult?.();
					yield* Fiber.join(turnFiber);
					yield* instance.shutdownEffect();

					return {
						childSessionId,
						immediate,
						beforeResult,
						getSubagentMessagesCallsBeforeResult,
					};
				}).pipe(Effect.provide(makePersistenceLayer(filename))),
			);

			const immediateTaskMessage = result.immediate.parentChat.find(
				(message): message is Extract<ChatMessage, { type: "tool" }> =>
					message.type === "tool" && message.name === "Task",
			);
			expect(result.immediate.child).toEqual({
				parent_id: "parent-live-session",
				provider_sid: "task-live-1",
			});
			expect(immediateTaskMessage?.metadata?.["childSessionId"]).toBe(
				result.childSessionId,
			);
			expect(result.getSubagentMessagesCallsBeforeResult).toBe(0);
			expect(result.beforeResult.childChat).toEqual([
				expect.objectContaining({ type: "user", text: "Inspect auth" }),
				expect.objectContaining({ type: "assistant", rawText: "Auth is fine" }),
			]);
		} finally {
			releaseResult?.();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
