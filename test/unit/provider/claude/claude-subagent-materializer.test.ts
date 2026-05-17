import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reactivity } from "@effect/experimental";
import { SqlClient } from "@effect/sql";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
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
import {
	type ClaudeSubagentSdk,
	type ClaudeSubagentTranscriptCursor,
	claudeSubagentSessionId,
	commitClaudeSubagentTranscriptCursor,
	diffSessionMessagesToEvents,
	makeClaudeSubagentMaterializer,
	stageSessionMessagesToEvents,
} from "../../../../src/lib/provider/claude/claude-subagent-materializer.js";
import type { SessionMessage } from "../../../../src/lib/provider/claude/types.js";

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

describe("Claude subagent materializer", () => {
	it("does nothing when the SDK reports no subagents", async () => {
		const sdk: ClaudeSubagentSdk = {
			listSubagents: vi.fn(async () => []),
			getSubagentMessages: vi.fn(async () => []),
		};
		const persistClaudeSubagent = vi.fn(() => Effect.void);
		const materialize = makeClaudeSubagentMaterializer({
			sdk,
			persist: { persistClaudeSubagent },
		});

		const result = await Effect.runPromise(
			materialize({
				parentConduitSessionId: "parent-session",
				parentClaudeSessionId: "sdk-parent",
				workspaceRoot: "/tmp/project",
				knownTasks: new Map(),
			}),
		);

		expect(result).toEqual([]);
		expect(sdk.getSubagentMessages).not.toHaveBeenCalled();
		expect(persistClaudeSubagent).not.toHaveBeenCalled();
	});

	it("converts one SDK subagent transcript into a deterministic child session", async () => {
		const messages = [
			sessionMessage("user", "sub-user-1", "Inspect auth"),
			sessionMessage("assistant", "sub-assistant-1", "Auth is fine"),
		];
		const sdk: ClaudeSubagentSdk = {
			listSubagents: vi.fn(async () => ["agent-abc"]),
			getSubagentMessages: vi.fn(async () => messages),
		};
		const persistClaudeSubagent = vi.fn(() => Effect.void);
		const materialize = makeClaudeSubagentMaterializer({
			sdk,
			persist: { persistClaudeSubagent },
		});

		const result = await Effect.runPromise(
			materialize({
				parentConduitSessionId: "parent-session",
				parentClaudeSessionId: "sdk-parent",
				workspaceRoot: "/tmp/project",
				knownTasks: new Map([
					[
						"agent-abc",
						{
							toolUseId: "toolu-task",
							description: "Audit auth",
							subagentType: "explore",
						},
					],
				]),
			}),
		);

		const childSessionId = claudeSubagentSessionId({
			parentConduitSessionId: "parent-session",
			parentClaudeSessionId: "sdk-parent",
			sdkSubagentId: "agent-abc",
		});
		expect(result).toEqual([
			{
				sdkSubagentId: "agent-abc",
				childSessionId,
				parentToolUseId: "toolu-task",
			},
		]);
		expect(sdk.getSubagentMessages).toHaveBeenCalledWith(
			"sdk-parent",
			"agent-abc",
			{
				dir: "/tmp/project",
			},
		);
		expect(persistClaudeSubagent).toHaveBeenCalledWith({
			childSessionId,
			parentSessionId: "parent-session",
			providerSessionId: "agent-abc",
			title: "Explore Agent",
			events: [
				expect.objectContaining({
					type: "message.created",
					sessionId: childSessionId,
					data: expect.objectContaining({
						messageId: "sub-user-1",
						role: "user",
					}),
				}),
				expect.objectContaining({
					type: "text.delta",
					data: expect.objectContaining({
						messageId: "sub-user-1",
						text: "Inspect auth",
					}),
				}),
				expect.objectContaining({
					type: "message.created",
					data: expect.objectContaining({
						messageId: "sub-assistant-1",
						role: "assistant",
					}),
				}),
				expect.objectContaining({
					type: "text.delta",
					data: expect.objectContaining({
						messageId: "sub-assistant-1",
						text: "Auth is fine",
					}),
				}),
			],
		});
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
				.map((event) => event.data.text),
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
				.map((event) => event.data.text),
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
				.map((event) => event.data.text),
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
				.map((event) => event.data.text),
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
				.map((event) => event.data.text),
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
				.map((event) => event.data.text),
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
				.map((event) => event.data.text),
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
				.map((event) => event.data.text),
		).toEqual(["Auth"]);

		commitClaudeSubagentTranscriptCursor(cursor, firstStage.cursor);
		const committedStage = stageSessionMessagesToEvents({
			childSessionId: "child-session",
			messages: [sessionMessage("assistant", "sub-assistant-1", "Auth")],
			cursor,
		});
		expect(committedStage.events).toEqual([]);
	});

	it("materializes unmatched SDK subagents without linking a parent tool", async () => {
		const sdk: ClaudeSubagentSdk = {
			listSubagents: vi.fn(async () => ["agent-unmatched"]),
			getSubagentMessages: vi.fn(async () => [
				sessionMessage("assistant", "sub-assistant-1", "Background note"),
			]),
		};
		const persistClaudeSubagent = vi.fn(() => Effect.void);
		const materialize = makeClaudeSubagentMaterializer({
			sdk,
			persist: { persistClaudeSubagent },
		});

		const result = await Effect.runPromise(
			materialize({
				parentConduitSessionId: "parent-session",
				parentClaudeSessionId: "sdk-parent",
				workspaceRoot: "/tmp/project",
				knownTasks: new Map(),
			}),
		);

		expect(result[0]).toMatchObject({
			sdkSubagentId: "agent-unmatched",
		});
		expect(result[0]).not.toHaveProperty("parentToolUseId");
		expect(persistClaudeSubagent).toHaveBeenCalledTimes(1);
	});

	it("persists child transcript events idempotently", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-claude-subagent-"));
		const filename = join(dir, "events.db");
		try {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const persist = yield* ClaudeEventPersistEffectTag;
					const childSessionId = claudeSubagentSessionId({
						parentConduitSessionId: "parent-session",
						parentClaudeSessionId: "sdk-parent",
						sdkSubagentId: "agent-abc",
					});
					const materialize = makeClaudeSubagentMaterializer({
						sdk: {
							listSubagents: async () => ["agent-abc"],
							getSubagentMessages: async () => [
								sessionMessage("user", "sub-user-1", "Inspect auth"),
							],
						},
						persist,
					});
					const input = {
						parentConduitSessionId: "parent-session",
						parentClaudeSessionId: "sdk-parent",
						workspaceRoot: "/tmp/project",
						knownTasks: new Map(),
					};
					yield* materialize(input);
					yield* materialize(input);

					const sql = yield* SqlClient.SqlClient;
					const messages = yield* sql<{ id: string }>`
						SELECT id FROM messages WHERE session_id = ${childSessionId}`;
					const sessionCreatedEvents = yield* sql<{ count: number }>`
						SELECT COUNT(*) AS count FROM events WHERE session_id = ${childSessionId} AND type = 'session.created'`;
					const childRows = yield* sql<{
						parent_id: string | null;
						provider_sid: string | null;
					}>`SELECT parent_id, provider_sid FROM sessions WHERE id = ${childSessionId}`;
					return {
						messages,
						sessionCreatedCount: sessionCreatedEvents[0]?.count,
						child: childRows[0],
					};
				}).pipe(Effect.provide(makePersistenceLayer(filename))),
			);

			expect(result.messages).toEqual([{ id: "sub-user-1" }]);
			expect(result.sessionCreatedCount).toBe(1);
			expect(result.child).toEqual({
				parent_id: "parent-session",
				provider_sid: "agent-abc",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ensures a Claude subagent session idempotently", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-claude-subagent-ensure-"));
		const filename = join(dir, "events.db");
		try {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
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
					return {
						sessionCreatedCount: sessionCreatedEvents[0]?.count,
						preexistingSessionCreatedCount:
							preexistingSessionCreatedEvents[0]?.count,
						concurrentSessionCreatedCount:
							concurrentSessionCreatedEvents[0]?.count,
						child: childRows[0],
						preexisting: preexistingRows[0],
						parent: parentRows[0],
					};
				}).pipe(Effect.provide(makePersistenceLayer(filename))),
			);

			expect(result.sessionCreatedCount).toBe(1);
			expect(result.preexistingSessionCreatedCount).toBe(0);
			expect(result.concurrentSessionCreatedCount).toBe(1);
			expect(result.child).toEqual({
				title: "Explore Agent",
				parent_id: "parent-session",
				provider_sid: "agent-abc",
			});
			expect(result.preexisting).toEqual({ title: "Untitled" });
			expect(result.parent).toEqual({
				id: "parent-session",
				provider: "claude",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
