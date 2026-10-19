import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, expect, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { sessionPickEvents } from "../../../../src/lib/domain/relay/Services/session-pick.js";
import { ClaudeEventPersistEffectTag } from "../../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { applyClaudeOwnershipDecisionEffect } from "../../../../src/lib/provider/claude/claude-message-ownership-runtime.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { stageSessionMessagesToEvents } from "../../../../src/lib/provider/claude/claude-subagent-materializer.js";
import type {
	ClaudeSessionContext,
	SessionMessage,
} from "../../../../src/lib/provider/claude/types.js";
import type { EventSink } from "../../../../src/lib/provider/types.js";

// Test seams: ownership's route-transcript operation, real runtime ingestion,
// and the SQLite message/part projections used to serve session history.
const PARENT = "transcript-parent";
const CHILD = "transcript-child";
const MESSAGE = "2be3b9f8-91a1-4bb7-b718-e2f41a381493";
const TOOL = "tool-resume";

function message(
	type: "user" | "assistant",
	uuid: string,
	content: readonly unknown[],
): SessionMessage {
	return {
		type,
		uuid,
		session_id: "sdk-child",
		parent_tool_use_id: null,
		parent_agent_id: null,
		message: { role: type, content },
	};
}

function transcript(text = "echo", completed = false, thinking = "reason") {
	return [
		message("user", "4be3b9f8-91a1-4bb7-b718-e2f41a381493", [
			{ type: "text", text: "inspect" },
		]),
		message("assistant", MESSAGE, [
			{ type: "thinking", thinking: "" },
			{
				type: "tool_use",
				id: TOOL,
				name: "Read",
				input: { file_path: "/tmp/example" },
			},
			{ type: "text", text },
			{ type: "thinking", thinking },
		]),
		...(completed
			? [
					message("user", "6be3b9f8-91a1-4bb7-b718-e2f41a381493", [
						{
							type: "tool_result",
							tool_use_id: TOOL,
							content: "file contents",
						},
					]),
				]
			: []),
	];
}

function context(sink: EventSink): ClaudeSessionContext {
	return {
		sessionId: PARENT,
		workspaceRoot: "/tmp/ws",
		configDir: configuredClaudeConfigDir("/tmp/claude-account"),
		startedAt: "2026-10-16T00:00:00Z",
		promptQueue: {
			enqueue: () => Effect.void,
			close: () => Effect.void,
			async *[Symbol.asyncIterator]() {},
		},
		query: (async function* () {})() as ClaudeSessionContext["query"],
		pendingApprovals: new Map(),
		pendingQuestions: new Map(),
		inFlightTools: new Map(),
		eventSink: sink,
		currentTurnId: "turn-1",
		turnInFlight: true,
		currentModel: "claude-sonnet-5",
		resumeSessionId: undefined,
		lastAssistantUuid: undefined,
		turnCount: 0,
		stopped: false,
	};
}

function withStore<A, E, R>(test: Effect.Effect<A, E, R>) {
	const dir = mkdtempSync(join(tmpdir(), "conduit-transcript-resume-"));
	const persistence = makePersistenceEffectLayer(
		join(dir, "events.db"),
		"test-project",
	);
	return test.pipe(
		Effect.provide(
			Layer.merge(
				persistence,
				ProviderRuntimeIngestionLive.pipe(Layer.provide(persistence)),
			),
		),
		Effect.ensuring(
			Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
		),
	);
}

const setup = Effect.gen(function* () {
	const store = yield* EventStoreEffectTag;
	const runner = yield* ProjectionRunnerEffectTag;
	const persist = yield* ClaudeEventPersistEffectTag;
	const ingestion = yield* ProviderRuntimeIngestionTag;
	const read = yield* ReadQueryEffectTag;
	yield* runner.recover();
	yield* runner.projectBatch(
		yield* store.appendBatch([
			canonicalEvent(
				"session.created",
				PARENT,
				{
					sessionId: PARENT,
					title: "Parent",
					provider: "claude",
					providerSessionId: "sdk-parent",
				},
				{ provider: "claude" },
			),
			...sessionPickEvents(PARENT, {
				harness: "claude",
				model: { providerId: "claude", modelId: "sonnet" },
				effort: "high",
				contextWindow: "1m",
			}),
		]),
	);
	yield* persist.ensureClaudeSubagentSession({
		childSessionId: CHILD,
		parentSessionId: PARENT,
		providerSessionId: "sdk-child",
		title: "Child",
	});
	const emitted: ProviderRuntimeEvent[] = [];
	const sink: EventSink = {
		push: (event) =>
			ingestion.ingest(event).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						emitted.push(event);
					}),
				),
				Effect.asVoid,
			),
		requestPermission: () => Effect.succeed({ decision: "once" as const }),
		requestQuestion: () => Effect.succeed({}),
		resolvePermission: () => Effect.void,
		resolveQuestion: () => Effect.void,
	};
	const feed = (
		ctx: ClaudeSessionContext,
		messages: readonly SessionMessage[],
	) =>
		applyClaudeOwnershipDecisionEffect(undefined, ctx, {
			kind: "route-transcript",
			childSessionId: CHILD,
			messages,
		});
	const parts = () =>
		read
			.getSessionMessagesWithParts(CHILD)
			.pipe(Effect.map((messages) => messages.flatMap((item) => item.parts)));
	return { store, persist, ingestion, emitted, sink, feed, parts };
});

afterEach(() => vi.restoreAllMocks());

describe("Claude subagent transcripts across session contexts", () => {
	it.effect("retains a parent launcher's run on a delayed child link", () =>
		withStore(
			Effect.gen(function* () {
				const { emitted, sink } = yield* setup;
				const ctx = context(sink);
				ctx.currentRunId = "new-run";
				ctx.toolRunIds = new Map([["launcher", "launcher-run"]]);
				const link = yield* applyClaudeOwnershipDecisionEffect(undefined, ctx, {
					kind: "open-child",
					childSessionId: "later-child",
					taskId: "later-task",
					toolUseId: "launcher",
					issuer: { kind: "parent" },
					issuingMessageId: "launcher-message",
				});
				if (link) yield* link;
				expect(
					emitted.find((event) => event.type === "tool.running")?.runId,
				).toBe("launcher-run");
			}),
		),
	);
	it.effect(
		"emits nothing for persisted messages, indexed text, empty thinking and completed tools in a fresh context",
		() =>
			withStore(
				Effect.gen(function* () {
					const { store, emitted, sink, feed, parts } = yield* setup;
					yield* feed(context(sink), transcript("echo", true));
					const before = JSON.stringify(yield* parts());
					const count = (yield* store.readBySession(CHILD)).length;
					emitted.length = 0;
					yield* feed(context(sink), transcript("echo", true));
					expect(emitted).toEqual([]);
					expect((yield* store.readBySession(CHILD)).length).toBe(count);
					expect(JSON.stringify(yield* parts())).toBe(before);
				}),
			),
	);

	it.effect(
		"emits only the new suffix and a later message's tool result, retaining the issuing message",
		() =>
			withStore(
				Effect.gen(function* () {
					const { emitted, sink, feed, parts } = yield* setup;
					yield* feed(context(sink), transcript());
					emitted.length = 0;
					yield* feed(context(sink), transcript("echoecho", true));
					expect(emitted.map(({ type, data }) => ({ type, data }))).toEqual([
						{
							type: "text.delta",
							data: {
								messageId: MESSAGE,
								partId: `${MESSAGE}-2`,
								text: "echo",
							},
						},
						{
							type: "tool.completed",
							data: {
								messageId: MESSAGE,
								partId: TOOL,
								result: "file contents",
								duration: 0,
							},
						},
					]);
					const projected = yield* parts();
					expect(
						projected.find((part) => part.id === `${MESSAGE}-2`)?.text,
					).toBe("echoecho");
					expect(projected.find((part) => part.id === TOOL)).toMatchObject({
						message_id: MESSAGE,
						status: "completed",
						result: '"file contents"',
					});
				}),
			),
	);

	it.effect(
		"retains a persisted tool's owner when only its later result is delivered after restart",
		() =>
			withStore(
				Effect.gen(function* () {
					const { emitted, sink, feed, parts } = yield* setup;
					yield* feed(context(sink), transcript());
					emitted.length = 0;
					yield* feed(context(sink), transcript("echo", true).slice(-1));
					expect(emitted).toHaveLength(1);
					expect(emitted[0]?.data).toMatchObject({
						messageId: MESSAGE,
						partId: TOOL,
					});
					expect(
						(yield* parts()).find((part) => part.id === TOOL)?.status,
					).toBe("completed");
				}),
			),
	);

	it.effect(
		"re-emits cascade-deleted parts after a message replacement even when their event ids already exist",
		() =>
			withStore(
				Effect.gen(function* () {
					const { store, persist, emitted, sink, feed, parts } = yield* setup;
					yield* feed(context(sink), transcript("echo", true));
					// Commit the replacement after the removal's tombstone version so
					// ingestion accepts it; replay must still reproduce the FK cascade.
					yield* persist.persistEvent(
						canonicalEvent(
							"message.removed",
							CHILD,
							{ messageId: MESSAGE },
							{ provider: "claude" },
						),
					);
					yield* persist.persistEvent(
						canonicalEvent(
							"message.created",
							CHILD,
							{ messageId: MESSAGE, sessionId: CHILD, role: "assistant" },
							{ provider: "claude" },
						),
					);
					expect(
						(yield* parts()).filter((part) => part.message_id === MESSAGE),
					).toEqual([]);
					emitted.length = 0;
					yield* feed(context(sink), transcript("echo", true));
					expect(emitted.map((event) => event.type)).toEqual([
						"thinking.start",
						"thinking.end",
						"tool.started",
						"text.delta",
						"thinking.start",
						"thinking.delta",
						"thinking.end",
						"tool.completed",
					]);
					expect(
						(yield* parts()).filter((part) => part.message_id === MESSAGE),
					).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								id: `${MESSAGE}-0`,
								text: "",
								status: "completed",
							}),
							expect.objectContaining({ id: `${MESSAGE}-2`, text: "echo" }),
							expect.objectContaining({
								id: `${MESSAGE}-3`,
								text: "reason",
								status: "completed",
							}),
							expect.objectContaining({
								id: TOOL,
								status: "completed",
								result: '"file contents"',
							}),
						]),
					);
					emitted.length = 0;
					yield* feed(context(sink), transcript("echo", true));
					expect(emitted).toEqual([]);

					const liveParts = (yield* parts())
						.filter((part) => part.message_id === MESSAGE)
						.map(({ id, text }) => ({ id, text }))
						.sort((a, b) => a.id.localeCompare(b.id));
					const events = yield* store.readFromSequence(0);
					yield* withStore(
						Effect.gen(function* () {
							const replayStore = yield* EventStoreEffectTag;
							const replayRunner = yield* ProjectionRunnerEffectTag;
							const replayRead = yield* ReadQueryEffectTag;
							const liveEvents = events.filter(
								(event) =>
									event.type !== "session.read" &&
									event.type !== "session.unread" &&
									event.type !== "tool.input_updated",
							);
							expect(liveEvents).toHaveLength(events.length);
							yield* replayStore.appendBatch(liveEvents);
							const recovered = yield* replayRunner.recover();
							expect(recovered.startCursor).toBe(0);
							expect(recovered.totalReplayed).toBeGreaterThan(0);
							expect(yield* replayRunner.getFailures()).toEqual([]);
							const replayedParts =
								(yield* replayRead.getSessionMessagesWithParts(CHILD))
									.flatMap((item) => item.parts)
									.filter((part) => part.message_id === MESSAGE)
									.map(({ id, text }) => ({ id, text }))
									.sort((a, b) => a.id.localeCompare(b.id));
							expect(replayedParts).toEqual(liveParts);
						}),
					);
				}),
			),
	);

	it.effect(
		"materializes a child with no message rows and never re-emits persisted thinking, including empty parts",
		() =>
			withStore(
				Effect.gen(function* () {
					const { emitted, sink, feed, parts } = yield* setup;
					expect(yield* parts()).toEqual([]);
					yield* feed(context(sink), transcript());
					emitted.length = 0;
					yield* feed(context(sink), transcript("echo", false, "reasonreason"));
					yield* feed(context(sink), [
						message("assistant", MESSAGE, [
							{ type: "thinking", thinking: "later thought" },
						]),
					]);
					expect(emitted).toEqual([]);
					expect(
						(yield* parts()).find((part) => part.id === `${MESSAGE}-0`)?.text,
					).toBe("");
					expect(
						(yield* parts()).find((part) => part.id === `${MESSAGE}-3`)?.text,
					).toBe("reason");
				}),
			),
	);

	it.effect(
		"uses stable ids across clocks, distinguishes repeated slices by offset, and silently skips duplicate batches",
		() =>
			withStore(
				Effect.gen(function* () {
					const { ingestion, store, parts } = yield* setup;
					const cursor = () => ({
						messageRoles: new Map<string, "user" | "assistant">(),
						textOffsets: new Map<string, number>(),
						toolStarts: new Set<string>(),
						toolCompletions: new Set<string>(),
					});
					vi.spyOn(Date, "now").mockReturnValue(1_000);
					const first = stageSessionMessagesToEvents({
						childSessionId: CHILD,
						messages: transcript("echo", true),
						cursor: cursor(),
					});
					vi.mocked(Date.now).mockReturnValue(9_000);
					const repeated = stageSessionMessagesToEvents({
						childSessionId: CHILD,
						messages: transcript("echo", true),
						cursor: cursor(),
					});
					expect(repeated.events.map((event) => event.eventId)).toEqual(
						first.events.map((event) => event.eventId),
					);
					const grown = stageSessionMessagesToEvents({
						childSessionId: CHILD,
						messages: transcript("echoecho", true, "reasonreason"),
						cursor: first.cursor,
					});
					const original = first.events.find(
						(event) =>
							event.type === "text.delta" &&
							event.providerRefs.providerMessageId === MESSAGE,
					);
					const suffix = grown.events.find(
						(event) => event.type === "text.delta",
					);
					expect(suffix?.data).toEqual(original?.data);
					expect(suffix?.eventId).not.toBe(original?.eventId);
					expect(grown.events.map((event) => event.type)).toEqual([
						"text.delta",
					]);
					yield* ingestion.ingestBatch(first.events);
					const before = JSON.stringify(yield* parts());
					const count = (yield* store.readBySession(CHILD)).length;
					yield* ingestion.ingestBatch([
						...repeated.events,
						...grown.events,
						...repeated.events,
					]);
					expect(
						(yield* parts()).find((part) => part.id === `${MESSAGE}-2`)?.text,
					).toBe("echoecho");
					expect((yield* store.readBySession(CHILD)).length).toBe(
						count + grown.events.length,
					);
					yield* ingestion.ingestBatch(repeated.events);
					expect(JSON.stringify(yield* parts())).not.toBe(before);
					const after = JSON.stringify(yield* parts());
					yield* ingestion.ingestBatch(repeated.events);
					expect(JSON.stringify(yield* parts())).toBe(after);
				}),
			),
	);
});
