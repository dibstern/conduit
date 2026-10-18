import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

describe("ClaudeEventPersistEffect session lifecycle", () => {
	it.effect(
		"omits empty user deltas without losing attachments or nonempty text",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-empty-delta-"));
			const layer = makePersistenceEffectLayer(
				join(dir, "events.db"),
				"test-project",
			);
			const sessionId = "attachment-session";

			return Effect.gen(function* () {
				const eventStore = yield* EventStoreEffectTag;
				const projectionRunner = yield* ProjectionRunnerEffectTag;
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* projectionRunner.recover();
				const created = yield* eventStore.append(
					canonicalEvent("session.created", sessionId, {
						sessionId,
						title: "Attachments",
						provider: "claude",
						providerSessionId: "sdk-session",
					}),
				);
				yield* projectionRunner.projectEvent(created);
				yield* persist.persistUserMessage(sessionId, "", {
					messageId: "image-message",
				});
				yield* persist.persistEvent(
					canonicalEvent("file.attached", sessionId, {
						messageId: "image-message",
						partId: "image-part",
						mime: "image/png",
						url: "data:image/png;base64,aW1hZ2U=",
					}),
				);
				yield* persist.persistUserMessage(sessionId, "Hello", {
					messageId: "text-message",
				});
				yield* persist.persistUserMessage(sessionId, " ", {
					messageId: "space-message",
				});
				const events = yield* eventStore.readBySession(sessionId);
				expect(
					events
						.filter((event) => event.type !== "session.created")
						.map((event) => ({ type: event.type, data: event.data })),
				).toEqual([
					{
						type: "message.created",
						data: { messageId: "image-message", role: "user", sessionId },
					},
					{
						type: "file.attached",
						data: {
							messageId: "image-message",
							partId: "image-part",
							mime: "image/png",
							url: "data:image/png;base64,aW1hZ2U=",
						},
					},
					{
						type: "message.created",
						data: { messageId: "text-message", role: "user", sessionId },
					},
					{
						type: "text.delta",
						data: {
							messageId: "text-message",
							partId: "text-message-0",
							text: "Hello",
						},
					},
					{
						type: "message.created",
						data: { messageId: "space-message", role: "user", sessionId },
					},
					{
						type: "text.delta",
						data: {
							messageId: "space-message",
							partId: "space-message-0",
							text: " ",
						},
					},
				]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"preserves delayed authoritative OpenCode ownership during user-message persistence",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-interleaving-"));
			const filename = join(dir, "events.db");
			const layer = makePersistenceEffectLayer(filename, "test-project");
			const sessionId = "interleaved-opencode-session";

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const eventStore = yield* EventStoreEffectTag;
				const projectionRunner = yield* ProjectionRunnerEffectTag;
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* projectionRunner.recover();
				yield* sql`
				INSERT INTO sessions (
					id, project_id, provider, provider_sid, title, status, created_at, updated_at
				) VALUES (
					${sessionId}, 'test-project', 'opencode', ${sessionId}, 'OpenCode Session', 'idle', 1, 1
				)`;
				const delayedCreation = yield* eventStore.append(
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title: "OpenCode Session",
							provider: "opencode",
							providerSessionId: sessionId,
						},
						{ provider: "opencode", createdAt: 2 },
					),
				);

				yield* persist.persistUserMessage(sessionId, "switch to Claude");
				yield* projectionRunner.projectEvent(delayedCreation);

				const sessions = yield* sql<{
					readonly provider: string;
					readonly provider_sid: string | null;
				}>`SELECT provider, provider_sid FROM sessions WHERE id = ${sessionId}`;
				const creations = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM events
				WHERE session_id = ${sessionId} AND type = 'session.created'`;
				const bindings = yield* sql<{
					readonly id: string;
					readonly provider: string;
				}>`
				SELECT id, provider FROM session_providers
				WHERE session_id = ${sessionId} AND status = 'active'`;

				expect(sessions).toEqual([
					{ provider: "opencode", provider_sid: sessionId },
				]);
				expect(creations[0]?.count).toBe(1);
				expect(bindings).toEqual([
					{ id: `${sessionId}:initial`, provider: "opencode" },
				]);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"rejects a user message for a missing session without writing or publishing",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-lifecycle-"));
			const filename = join(dir, "events.db");
			const publish = vi.fn(() => Effect.void);
			const busLayer = Layer.succeed(SessionEventBusTag, {
				publish,
				publishAdvance: () => Effect.void,
				subscribe: () => Effect.dieMessage("unused test subscription"),
				subscribeAdvances: () => Effect.dieMessage("unused test subscription"),
			} satisfies SessionEventBus);
			const layer = makePersistenceEffectLayer(
				filename,
				"test-project",
				undefined,
				busLayer,
			);

			return Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const result = yield* Effect.result(
					persist.persistUserMessage("missing-session", "hello"),
				);
				const sql = yield* SqlClient.SqlClient;
				const sessionRows = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM sessions WHERE id = 'missing-session'`;
				const eventRows = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM events WHERE session_id = 'missing-session'`;

				expect(result).toMatchObject({
					_tag: "Left",
					left: expect.objectContaining({
						_tag: "ClaudeSessionLifecycleError",
						operation: "persistUserMessage",
						sessionId: "missing-session",
						role: "existing-session",
						reason: "missing-session",
					}),
				});
				expect(sessionRows[0]?.count).toBe(0);
				expect(eventRows[0]?.count).toBe(0);
				expect(publish).not.toHaveBeenCalled();
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"rejects a raw-only session row without a durable creation event",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-raw-only-"));
			const filename = join(dir, "events.db");
			const layer = makePersistenceEffectLayer(filename, "test-project");
			const sessionId = "legacy-raw-only-session";

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* sql`
					INSERT INTO sessions (
						id, provider, provider_sid, title, status, created_at, updated_at
					) VALUES (
						${sessionId}, 'opencode', ${sessionId}, 'Legacy raw seed', 'idle', 1, 1
					)`;

				const result = yield* Effect.result(
					persist.persistUserMessage(sessionId, "must not dispatch"),
				);
				const events = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM events WHERE session_id = ${sessionId}`;

				expect(result).toMatchObject({
					_tag: "Left",
					left: expect.objectContaining({
						_tag: "ClaudeSessionLifecycleError",
						operation: "persistUserMessage",
						sessionId,
						role: "existing-session",
						reason: "missing-session",
					}),
				});
				expect(events[0]?.count).toBe(0);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"rejects an ordinary content event for a raw-only session row",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-raw-content-"));
			const filename = join(dir, "events.db");
			const layer = makePersistenceEffectLayer(filename, "test-project");
			const sessionId = "legacy-raw-content-session";

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* sql`
					INSERT INTO sessions (
						id, provider, provider_sid, title, status, created_at, updated_at
					) VALUES (
						${sessionId}, 'opencode', ${sessionId}, 'Legacy raw seed', 'idle', 1, 1
					)`;

				const result = yield* Effect.result(
					persist.persistEvent(
						canonicalEvent(
							"message.created",
							sessionId,
							{
								messageId: "raw-content-message",
								role: "user",
								sessionId,
							},
							{ provider: "claude" },
						),
					),
				);
				const events = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM events WHERE session_id = ${sessionId}`;

				expect(result).toMatchObject({
					_tag: "Left",
					left: expect.objectContaining({
						_tag: "ClaudeSessionLifecycleError",
						operation: "persistEvent",
						sessionId,
						role: "existing-session",
						reason: "missing-session",
					}),
				});
				expect(events[0]?.count).toBe(0);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"deletes an existing session but rejects a missing compatibility delete",
		() => {
			const dir = mkdtempSync(
				join(tmpdir(), "conduit-claude-event-lifecycle-"),
			);
			const filename = join(dir, "events.db");
			const layer = makePersistenceEffectLayer(filename, "test-project");

			return Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const eventStore = yield* EventStoreEffectTag;
				const projectionRunner = yield* ProjectionRunnerEffectTag;
				yield* projectionRunner.recover();
				const existingCreation = yield* eventStore.append(
					canonicalEvent(
						"session.created",
						"existing-delete-session",
						{
							sessionId: "existing-delete-session",
							title: "Existing",
							provider: "claude",
						},
						{ provider: "claude" },
					),
				);
				yield* projectionRunner.projectEvent(existingCreation);
				yield* persist.persistEvent(
					canonicalEvent(
						"session.deleted",
						"existing-delete-session",
						{ sessionId: "existing-delete-session" },
						{ provider: "claude" },
					),
				);
				const result = yield* Effect.result(
					persist.persistEvent(
						canonicalEvent(
							"session.deleted",
							"missing-event-session",
							{ sessionId: "missing-event-session" },
							{ provider: "claude" },
						),
					),
				);
				const sql = yield* SqlClient.SqlClient;
				const sessions = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM sessions WHERE id = 'missing-event-session'`;
				const events = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM events WHERE session_id = 'missing-event-session'`;
				const existingSessions = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM sessions WHERE id = 'existing-delete-session'`;
				const existingEvents = yield* sql<{ readonly count: number }>`
				SELECT COUNT(*) AS count FROM events WHERE session_id = 'existing-delete-session'`;

				expect(result).toMatchObject({
					_tag: "Left",
					left: expect.objectContaining({
						_tag: "ClaudeSessionLifecycleError",
						operation: "persistEvent",
						sessionId: "missing-event-session",
						role: "existing-session",
						reason: "missing-session",
					}),
				});
				expect(sessions[0]?.count).toBe(0);
				expect(events[0]?.count).toBe(0);
				expect(existingSessions[0]?.count).toBe(0);
				expect(existingEvents[0]?.count).toBe(2);
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);
});
