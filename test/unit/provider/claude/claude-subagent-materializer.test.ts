// Failure modes: subagent reads inherit the daemon account; a blank folder starts
// a worker; transcript staging advances cursors before persistence succeeds.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistenceProjectTag } from "../../../../src/lib/domain/persistence/Services/persistence-service.js";
import { sessionPickEvents } from "../../../../src/lib/domain/relay/Services/session-pick.js";
import {
	ClaudeEventPersistEffectTag,
	makeClaudeEventPersistEffect,
} from "../../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makeEffectSqlMigrator } from "../../../../src/lib/persistence/effect/migrations.js";
import {
	makeProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
} from "../../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	makeProjectorCursorEffect,
	ProjectorCursorEffectTag,
} from "../../../../src/lib/persistence/effect/projector-cursor-effect.js";
import { createAllEffectProjectors } from "../../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	type ClaudeSubagentTranscriptCursor,
	commitClaudeSubagentTranscriptCursor,
	defaultClaudeSubagentSdk,
	diffSessionMessagesToEvents,
	stageSessionMessagesToEvents,
} from "../../../../src/lib/provider/claude/claude-subagent-materializer.js";
import type { SessionMessage } from "../../../../src/lib/provider/claude/types.js";
import { makeEffectProjectionHarness } from "../../../helpers/effect-projection-harness.js";

afterEach(() => vi.unstubAllEnvs());

it.each([
	"",
	"  ",
])("rejects a blank folder before reading any subagent transcript: %j", async (configDir) => {
	vi.stubEnv("CLAUDE_CONFIG_DIR", "/daemon/claude");
	await expect(
		defaultClaudeSubagentSdk.listSubagents("sdk-parent", {
			dir: "/project",
			configDir: {
				...configuredClaudeConfigDir("/instance-config"),
				path: configDir,
			},
		}),
	).rejects.toThrow("Claude config directory must be non-empty");
	await expect(
		defaultClaudeSubagentSdk.getSubagentMessages("sdk-parent", "agent", {
			dir: "/project",
			configDir: {
				...configuredClaudeConfigDir("/instance-config"),
				path: configDir,
			},
		}),
	).rejects.toThrow("Claude config directory must be non-empty");
});

function dataOf(event: { readonly data: unknown }): Record<string, unknown> {
	return event.data as Record<string, unknown>;
}

function newCursor(): ClaudeSubagentTranscriptCursor {
	return {
		messageRoles: new Map(),
		textOffsets: new Map(),
		toolStarts: new Set(),
		toolCompletions: new Set(),
	};
}

function contentMessage(
	type: "user" | "assistant",
	uuid: string,
	content: readonly unknown[],
): SessionMessage {
	return {
		type,
		uuid,
		session_id: "sdk-parent",
		parent_tool_use_id: null,
		parent_agent_id: null,
		message: {
			role: type,
			content,
		},
	};
}

function sessionMessage(
	type: "user" | "assistant",
	uuid: string,
	text: string,
): SessionMessage {
	return contentMessage(type, uuid, [{ type: "text", text }]);
}

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
		makeEventStoreEffect.pipe(
			Effect.provideService(PersistenceProjectTag, {
				projectId: "test-project",
			}),
		),
	).pipe(Layer.provide(baseLayer));
	const cursorLayer = Layer.effect(
		ProjectorCursorEffectTag,
		makeProjectorCursorEffect.pipe(
			Effect.provideService(PersistenceProjectTag, {
				projectId: "test-project",
			}),
		),
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

function establishCanonicalSession(sessionId: string, provider: string) {
	return Effect.gen(function* () {
		const eventStore = yield* EventStoreEffectTag;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		if (!(yield* projectionRunner.isRecovered())) {
			yield* projectionRunner.recover();
		}
		const stored = yield* eventStore.appendBatch([
			canonicalEvent(
				"session.created",
				sessionId,
				{
					sessionId,
					title: "Parent Session",
					provider,
					providerSessionId: sessionId,
				},
				{ provider },
			),
			...sessionPickEvents(sessionId, {
				harness: "claude",
				model: { providerId: "claude", modelId: "sonnet" },
				effort: "high",
				contextWindow: "1m",
			}),
		]);
		yield* projectionRunner.projectBatch(stored);
	});
}

describe("Claude subagent transcripts and session establishment", () => {
	it("skips repeated empty deltas while preserving whitespace and nonempty transcript content", () => {
		const cursor = newCursor();
		const messages = [
			contentMessage("assistant", "sub-assistant-1", [
				{ type: "text", text: "" },
				{ type: "thinking", thinking: "" },
				{ type: "text", text: " " },
				{ type: "thinking", thinking: " " },
				{ type: "text", text: "Visible" },
				{ type: "thinking", thinking: "Reasoning" },
			]),
		];
		const stage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages,
			cursor,
		});
		expect(
			stage.events
				.filter(
					(event) =>
						event.type === "text.delta" || event.type === "thinking.delta",
				)
				.map((event) => ({ type: event.type, text: dataOf(event)["text"] })),
		).toEqual([
			{ type: "text.delta", text: "" },
			{ type: "text.delta", text: " " },
			{ type: "thinking.delta", text: " " },
			{ type: "text.delta", text: "Visible" },
			{ type: "thinking.delta", text: "Reasoning" },
		]);
		commitClaudeSubagentTranscriptCursor(cursor, stage.cursor);
		expect(
			stageSessionMessagesToEvents({
				childSessionId: "child-session",
				messages,
				cursor,
			}).events,
		).toEqual([]);
	});

	it("preserves projected part order when initially empty text grows after thinking", async () => {
		const harness = makeEffectProjectionHarness();
		const cursor = newCursor();
		const sessionId = "child-session";
		try {
			await harness.query(
				"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				[sessionId, "claude", "Child", "idle", 1, 1],
			);
			for (const text of ["", "", "Visible", "Visible"]) {
				const stage = stageSessionMessagesToEvents({
					childSessionId: sessionId,
					messages: [
						contentMessage("assistant", "sub-assistant-1", [
							{ type: "text", text },
							{ type: "thinking", thinking: "Reasoning" },
						]),
					],
					cursor,
				});
				await harness.ingestBatch(stage.events);
				commitClaudeSubagentTranscriptCursor(cursor, stage.cursor);
			}
			const messages = await harness.sessionMessagesWithParts(sessionId);
			expect(
				messages[0]?.parts.map(({ type, text }) => ({ type, text })),
			).toEqual([
				{ type: "text", text: "Visible" },
				{ type: "thinking", text: "Reasoning" },
			]);
		} finally {
			await harness.dispose();
		}
	});

	it("diffs repeated subagent snapshots by text cursor", () => {
		const cursor = newCursor();
		const firstEvents = diffSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [sessionMessage("assistant", "sub-assistant-1", "Auth")],
			cursor,
		});
		expect(
			firstEvents
				.filter((event) => event.type === "text.delta")
				.map((event) => dataOf(event)["text"]),
		).toEqual(["Auth"]);
		expect(cursor.messageRoles.get("sub-assistant-1")).toBe("assistant");
		expect(cursor.textOffsets.get("sub-assistant-1:0")).toBe("Auth".length);

		const secondEvents = diffSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [
				sessionMessage("assistant", "sub-assistant-1", "Auth is fine"),
			],
			cursor,
		});
		expect(
			secondEvents
				.filter((event) => event.type === "text.delta")
				.map((event) => dataOf(event)["text"]),
		).toEqual([" is fine"]);

		const retryEvents = diffSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [
				sessionMessage("assistant", "sub-assistant-1", "Auth is fine"),
			],
			cursor,
		});
		expect(retryEvents).toEqual([]);
	});

	it("stages repeated subagent snapshots by text cursor", async () => {
		const cursor = newCursor();
		const firstStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [sessionMessage("assistant", "sub-assistant-1", "Auth")],
			cursor,
		});
		expect(
			firstStage.events
				.filter((event) => event.type === "text.delta")
				.map((event) => dataOf(event)["text"]),
		).toEqual(["Auth"]);
		commitClaudeSubagentTranscriptCursor(cursor, firstStage.cursor);

		const secondStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [
				sessionMessage("assistant", "sub-assistant-1", "Auth is fine"),
			],
			cursor,
		});
		expect(
			secondStage.events
				.filter((event) => event.type === "text.delta")
				.map((event) => dataOf(event)["text"]),
		).toEqual([" is fine"]);
		commitClaudeSubagentTranscriptCursor(cursor, secondStage.cursor);

		const repeatedStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [
				sessionMessage("assistant", "sub-assistant-1", "Auth is fine"),
			],
			cursor,
		});
		expect(repeatedStage.events).toEqual([]);
	});

	it("does not rewind text offsets when a snapshot shrinks", () => {
		const cursor = newCursor();
		const firstStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [
				sessionMessage("assistant", "sub-assistant-1", "Auth is fine"),
			],
			cursor,
		});
		commitClaudeSubagentTranscriptCursor(cursor, firstStage.cursor);

		const shrinkStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [sessionMessage("assistant", "sub-assistant-1", "Auth")],
			cursor,
		});
		expect(shrinkStage.events).toEqual([]);
		commitClaudeSubagentTranscriptCursor(cursor, shrinkStage.cursor);
		expect(cursor.textOffsets.get("sub-assistant-1:0")).toBe(
			"Auth is fine".length,
		);

		const growStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [
				sessionMessage("assistant", "sub-assistant-1", "Auth is fine today"),
			],
			cursor,
		});
		expect(
			growStage.events
				.filter((event) => event.type === "text.delta")
				.map((event) => dataOf(event)["text"]),
		).toEqual([" today"]);
	});

	it("diffs repeated thinking snapshots by thinking cursor", () => {
		const cursor = newCursor();
		const firstStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [
				contentMessage("assistant", "sub-assistant-1", [
					{ type: "thinking", thinking: "Checking" },
				]),
			],
			cursor,
		});
		expect(firstStage.events.map((event) => event.type)).toEqual([
			"message.created",
			"thinking.start",
			"thinking.delta",
			"thinking.end",
		]);
		expect(
			firstStage.events
				.filter((event) => event.type === "thinking.delta")
				.map((event) => dataOf(event)["text"]),
		).toEqual(["Checking"]);
		commitClaudeSubagentTranscriptCursor(cursor, firstStage.cursor);

		const repeatedStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [
				contentMessage("assistant", "sub-assistant-1", [
					{ type: "thinking", thinking: "Checking" },
				]),
			],
			cursor,
		});
		expect(repeatedStage.events).toEqual([]);

		const growStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [
				contentMessage("assistant", "sub-assistant-1", [
					{ type: "thinking", thinking: "Checking auth" },
				]),
			],
			cursor,
		});
		expect(growStage.events).toEqual([]);
	});

	it("dedupes repeated tool start and completion snapshots", () => {
		const cursor = newCursor();
		const messages = [
			contentMessage("assistant", "sub-assistant-1", [
				{
					type: "tool_use",
					id: "toolu-1",
					name: "Bash",
					input: { command: "pnpm test" },
				},
			]),
			contentMessage("user", "sub-user-1", [
				{
					type: "tool_result",
					tool_use_id: "toolu-1",
					content: "ok",
				},
			]),
		];

		const firstStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages,
			cursor,
		});
		expect(
			firstStage.events
				.filter(
					(event) =>
						event.type === "tool.started" || event.type === "tool.completed",
				)
				.map((event) => event.type),
		).toEqual(["tool.started", "tool.completed"]);
		commitClaudeSubagentTranscriptCursor(cursor, firstStage.cursor);

		const repeatedStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages,
			cursor,
		});
		expect(repeatedStage.events).toEqual([]);
	});

	it("does not create empty user messages for tool_result-only snapshots", () => {
		const cursor = newCursor();
		const messages = [
			contentMessage("assistant", "sub-assistant-tool-1", [
				{
					type: "tool_use",
					id: "toolu-1",
					name: "Bash",
					input: { command: "pnpm test" },
				},
			]),
			contentMessage("user", "sub-user-tool-result-1", [
				{
					type: "tool_result",
					tool_use_id: "toolu-1",
					content: "ok",
				},
			]),
		];

		const stage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages,
			cursor,
		});

		expect(
			stage.events.filter((event) => event.type === "message.created"),
		).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({
					messageId: "sub-assistant-tool-1",
					role: "assistant",
				}),
			}),
		]);
		expect(stage.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "tool.completed",
					data: expect.objectContaining({
						partId: "toolu-1",
						result: "ok",
					}),
				}),
			]),
		);
	});

	it("lets callers stage cursor advances before committing them", () => {
		const cursor = newCursor();
		const firstStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [sessionMessage("assistant", "sub-assistant-1", "Auth")],
			cursor,
		});
		expect(
			firstStage.events
				.filter((event) => event.type === "text.delta")
				.map((event) => dataOf(event)["text"]),
		).toEqual(["Auth"]);
		expect(cursor.messageRoles.has("sub-assistant-1")).toBe(false);
		expect(cursor.textOffsets.get("sub-assistant-1:0")).toBeUndefined();

		const retryStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [sessionMessage("assistant", "sub-assistant-1", "Auth")],
			cursor,
		});
		expect(
			retryStage.events
				.filter((event) => event.type === "text.delta")
				.map((event) => dataOf(event)["text"]),
		).toEqual(["Auth"]);

		commitClaudeSubagentTranscriptCursor(cursor, firstStage.cursor);
		const committedStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [sessionMessage("assistant", "sub-assistant-1", "Auth")],
			cursor,
		});
		expect(committedStage.events).toEqual([]);
	});

	it("ensures a Claude subagent session idempotently", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-claude-subagent-ensure-"));
		const filename = join(dir, "events.db");
		try {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					yield* establishCanonicalSession("parent-session", "claude");
					const persist = yield* ClaudeEventPersistEffectTag;
					const input = {
						childSessionId: "child-session",
						parentSessionId: "parent-session",
						providerSessionId: "agent-abc",
						title: "Explore Agent",
					};
					yield* persist.ensureClaudeSubagentSession(input);
					yield* persist.ensureClaudeSubagentSession(input);

					const sql = yield* SqlClient.SqlClient;
					const preexisting = {
						childSessionId: "child-session-preexisting",
						parentSessionId: "parent-session",
						providerSessionId: "agent-preexisting",
						title: "Preexisting Agent",
					};
					yield* sql`
						INSERT INTO sessions (id, provider, provider_sid, title, status, parent_id, created_at, updated_at)
						VALUES (${preexisting.childSessionId}, 'claude', ${preexisting.providerSessionId}, 'Untitled', 'idle', ${preexisting.parentSessionId}, 1, 1)`;
					yield* persist.ensureClaudeSubagentSession(preexisting);

					const concurrent = {
						childSessionId: "child-session-concurrent",
						parentSessionId: "parent-session",
						providerSessionId: "agent-concurrent",
						title: "Concurrent Agent",
					};
					yield* Effect.all(
						[
							persist.ensureClaudeSubagentSession(concurrent),
							persist.ensureClaudeSubagentSession(concurrent),
						],
						{ concurrency: "unbounded" },
					);

					const sessionCreatedEvents = yield* sql<{ count: number }>`
						SELECT COUNT(*) AS count FROM events WHERE session_id = ${input.childSessionId} AND type = 'session.created'`;
					const preexistingSessionCreatedEvents = yield* sql<{ count: number }>`
						SELECT COUNT(*) AS count FROM events WHERE session_id = ${preexisting.childSessionId} AND type = 'session.created'`;
					const concurrentSessionCreatedEvents = yield* sql<{ count: number }>`
						SELECT COUNT(*) AS count FROM events WHERE session_id = ${concurrent.childSessionId} AND type = 'session.created'`;
					const childRows = yield* sql<{
						title: string;
						parent_id: string | null;
						provider_sid: string | null;
					}>`SELECT title, parent_id, provider_sid FROM sessions WHERE id = ${input.childSessionId}`;
					const preexistingRows = yield* sql<{
						title: string;
					}>`SELECT title FROM sessions WHERE id = ${preexisting.childSessionId}`;
					const parentRows = yield* sql<{ id: string; provider: string }>`
						SELECT id, provider FROM sessions WHERE id = ${input.parentSessionId}`;
					const childPicks = yield* sql<{
						id: string;
						model_provider: string | null;
						model_id: string | null;
						variant: string | null;
						context_window: string | null;
					}>`SELECT id, model_provider, model_id, variant, context_window FROM sessions
						WHERE parent_id = 'parent-session' ORDER BY id`;
					const pickEvents = yield* sql<{
						session_id: string;
						type: string;
						count: number;
					}>`SELECT session_id, type, COUNT(*) AS count FROM events
						WHERE session_id IN (${input.childSessionId}, ${preexisting.childSessionId}, ${concurrent.childSessionId})
						AND type IN ('session.model_changed', 'session.variant_changed', 'session.context_window_changed')
						GROUP BY session_id, type ORDER BY session_id, type`;
					return {
						sessionCreatedCount: sessionCreatedEvents[0]?.count,
						preexistingSessionCreatedCount:
							preexistingSessionCreatedEvents[0]?.count,
						concurrentSessionCreatedCount:
							concurrentSessionCreatedEvents[0]?.count,
						child: childRows[0],
						preexisting: preexistingRows[0],
						parent: parentRows[0],
						childPicks,
						pickEvents,
					};
				}).pipe(Effect.provide(makePersistenceLayer(filename))),
			);

			expect(result.sessionCreatedCount).toBe(1);
			expect(result.preexistingSessionCreatedCount).toBe(1);
			expect(result.concurrentSessionCreatedCount).toBe(1);
			expect(result.child).toEqual({
				title: "Explore Agent",
				parent_id: "parent-session",
				provider_sid: "agent-abc",
			});
			expect(result.preexisting).toEqual({ title: "Preexisting Agent" });
			expect(result.parent).toEqual({
				id: "parent-session",
				provider: "claude",
			});
			const childIds = [
				"child-session",
				"child-session-concurrent",
				"child-session-preexisting",
			];
			expect(result.childPicks).toEqual(
				childIds.map((id) => ({
					id,
					model_provider: "claude",
					model_id: "sonnet",
					variant: "high",
					context_window: "1m",
				})),
			);
			expect(result.pickEvents).toEqual(
				childIds.flatMap((session_id) =>
					[
						"session.context_window_changed",
						"session.model_changed",
						"session.variant_changed",
					].map((type) => ({ session_id, type, count: 1 })),
				),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		false,
		true,
	])("leaves a retried child's title, version and sidebar unchanged, renamed=%s", async (renamed) => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-subagent-seed-retry-"));
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* establishCanonicalSession("parent-session", "claude");
					const persist = yield* ClaudeEventPersistEffectTag;
					const store = yield* EventStoreEffectTag;
					const sql = yield* SqlClient.SqlClient;
					const input = {
						childSessionId: "child-session",
						parentSessionId: "parent-session",
						providerSessionId: "agent-abc",
						title: "Explore Agent",
					};
					yield* persist.ensureClaudeSubagentSession(input);
					if (renamed) {
						yield* persist.persistEvent(
							canonicalEvent("session.renamed", input.childSessionId, {
								sessionId: input.childSessionId,
								title: "Renamed child",
							}),
						);
					}
					const before =
						yield* sql`SELECT title, version, updated_at FROM sessions WHERE id = 'child-session'`;
					const sidebarBefore =
						yield* sql`SELECT session_id, version, last_activity, row FROM session_sidebar ORDER BY session_id`;
					expect(before).toMatchObject([
						{ title: renamed ? "Renamed child" : "Explore Agent" },
					]);
					expect(sidebarBefore).toHaveLength(1);

					yield* persist.ensureClaudeSubagentSession(input);

					expect(
						yield* sql`SELECT title, version, updated_at FROM sessions WHERE id = 'child-session'`,
					).toEqual(before);
					expect(
						yield* sql`SELECT session_id, version, last_activity, row FROM session_sidebar ORDER BY session_id`,
					).toEqual(sidebarBefore);
					const creations = (yield* store.readBySession(
						input.childSessionId,
					)).filter((event) => event.type === "session.created");
					expect(creations).toHaveLength(1);
					expect(creations[0]?.eventId).toBe(
						"evt_claude_subagent_session_created_child-session",
					);
				}).pipe(Effect.provide(makePersistenceLayer(join(dir, "events.db")))),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects an invalid subagent seed through append's schema check and rolls back establishment", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-subagent-invalid-seed-"));
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* establishCanonicalSession("parent-session", "claude");
					const persist = yield* ClaudeEventPersistEffectTag;
					const result = yield* Effect.either(
						persist.ensureClaudeSubagentSession({
							childSessionId: "invalid-child",
							parentSessionId: "parent-session",
							providerSessionId: "agent-invalid",
							// @ts-expect-error Exercise malformed input arriving at runtime.
							title: 123,
						}),
					);
					expect(result).toMatchObject({
						_tag: "Left",
						left: {
							_tag: "ClaudeEventPersistEffectError",
							operation: "ensureClaudeSubagentSession",
							cause: {
								_tag: "EventStoreError",
								operation: "validateCanonicalEvent",
							},
						},
					});
					const store = yield* EventStoreEffectTag;
					expect(yield* store.readBySession("invalid-child")).toEqual([]);
					const sql = yield* SqlClient.SqlClient;
					expect(
						yield* sql`SELECT id FROM sessions WHERE id = 'invalid-child'`,
					).toEqual([]);
				}).pipe(Effect.provide(makePersistenceLayer(join(dir, "events.db")))),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects subagent establishment when the parent session is missing or has no pick", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-claude-subagent-parent-"));
		const filename = join(dir, "events.db");
		try {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const persist = yield* ClaudeEventPersistEffectTag;
					const outcome = yield* Effect.either(
						persist.ensureClaudeSubagentSession({
							childSessionId: "missing-parent-child",
							parentSessionId: "missing-parent",
							providerSessionId: "agent-missing-parent",
							title: "Explore Agent",
						}),
					);
					const sql = yield* SqlClient.SqlClient;
					const sessions = yield* sql<{ count: number }>`
						SELECT COUNT(*) AS count FROM sessions
						WHERE id IN ('missing-parent', 'missing-parent-child')`;
					const events = yield* sql<{ count: number }>`
						SELECT COUNT(*) AS count FROM events
						WHERE session_id IN ('missing-parent', 'missing-parent-child')`;
					const store = yield* EventStoreEffectTag;
					const runner = yield* ProjectionRunnerEffectTag;
					yield* runner.projectEvent(
						yield* store.append(
							canonicalEvent("session.created", "legacy-parent", {
								sessionId: "legacy-parent",
								provider: "claude",
								title: "Legacy parent",
							}),
						),
					);
					const missingPickOutcome = yield* Effect.either(
						persist.ensureClaudeSubagentSession({
							childSessionId: "legacy-parent-child",
							parentSessionId: "legacy-parent",
							providerSessionId: "agent-legacy-parent",
							title: "Explore Agent",
						}),
					);
					const legacyChildSessions = yield* sql<{ count: number }>`
						SELECT COUNT(*) AS count FROM sessions WHERE id = 'legacy-parent-child'`;
					const legacyChildEvents = yield* sql<{ count: number }>`
						SELECT COUNT(*) AS count FROM events WHERE session_id = 'legacy-parent-child'`;
					return {
						outcome,
						sessions: sessions[0]?.count,
						events: events[0]?.count,
						missingPickOutcome,
						legacyChildSessions: legacyChildSessions[0]?.count,
						legacyChildEvents: legacyChildEvents[0]?.count,
					};
				}).pipe(Effect.provide(makePersistenceLayer(filename))),
			);

			expect(result.outcome).toMatchObject({
				_tag: "Left",
				left: expect.objectContaining({
					_tag: "ClaudeSessionLifecycleError",
					operation: "ensureClaudeSubagentSession",
					sessionId: "missing-parent",
					role: "subagent-parent",
					reason: "missing-session",
				}),
			});
			expect(result.sessions).toBe(0);
			expect(result.events).toBe(0);
			expect(result.missingPickOutcome).toMatchObject({
				_tag: "Left",
				left: { _tag: "PickRequired" },
			});
			expect(result.legacyChildSessions).toBe(0);
			expect(result.legacyChildEvents).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a conflicting existing child without rebinding it", async () => {
		const dir = mkdtempSync(
			join(tmpdir(), "conduit-claude-subagent-conflict-"),
		);
		const filename = join(dir, "events.db");
		try {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					yield* establishCanonicalSession("parent-session", "claude");
					const sql = yield* SqlClient.SqlClient;
					yield* sql`
						INSERT INTO sessions (
							id, provider, provider_sid, title, status, parent_id, created_at, updated_at
						) VALUES (
							'conflicting-child', 'opencode', 'upstream-child', 'Existing', 'idle', 'parent-session', 1, 1
						)`;
					const persist = yield* ClaudeEventPersistEffectTag;
					const outcome = yield* Effect.either(
						persist.ensureClaudeSubagentSession({
							childSessionId: "conflicting-child",
							parentSessionId: "parent-session",
							providerSessionId: "agent-conflict",
							title: "Explore Agent",
						}),
					);
					const child = yield* sql<{
						provider: string;
						provider_sid: string | null;
						parent_id: string | null;
					}>`
						SELECT provider, provider_sid, parent_id FROM sessions
						WHERE id = 'conflicting-child'`;
					const creations = yield* sql<{ count: number }>`
						SELECT COUNT(*) AS count FROM events
						WHERE session_id = 'conflicting-child' AND type = 'session.created'`;
					return { outcome, child: child[0], creations: creations[0]?.count };
				}).pipe(Effect.provide(makePersistenceLayer(filename))),
			);

			expect(result.outcome).toMatchObject({
				_tag: "Left",
				left: expect.objectContaining({
					_tag: "ClaudeSessionLifecycleError",
					operation: "ensureClaudeSubagentSession",
					sessionId: "conflicting-child",
					role: "subagent-child",
					reason: "conflicting-subagent-session",
				}),
			});
			expect(result.child).toEqual({
				provider: "opencode",
				provider_sid: "upstream-child",
				parent_id: "parent-session",
			});
			expect(result.creations).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
