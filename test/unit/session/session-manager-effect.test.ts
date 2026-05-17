import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, HashMap, Layer, Option, Ref } from "effect";
import { expect, vi } from "vitest";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import {
	createSession,
	deleteSession,
	listSessions,
	recordMessageActivity,
	SessionManagerServiceLive,
	SessionManagerServiceTag,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { makeMockLogger } from "../../helpers/mock-factories.js";

describe("SessionManager Effect", () => {
	const makeMockApi = () => ({
		session: {
			list: vi.fn(async () => [{ id: "s1", title: "Test" }]),
			create: vi.fn(async () => ({ id: "s-new", title: "New" })),
			delete: vi.fn(async () => undefined),
			update: vi.fn(async () => undefined),
		},
	});

	const makeTestLayer = (mockApi: ReturnType<typeof makeMockApi>) =>
		Layer.mergeAll(
			makeSessionManagerStateLive(),
			Layer.succeed(OpenCodeAPITag, mockApi as unknown as OpenCodeAPI),
		);

	const makeLiveServiceLayer = (
		mockApi: ReturnType<typeof makeMockApi>,
		filename: string,
		readQueryOverride?: ReadQueryEffect,
	) =>
		Layer.provideMerge(
			SessionManagerServiceLive,
			Layer.mergeAll(
				Layer.fresh(makeTestLayer(mockApi)),
				Layer.succeed(LoggerTag, makeMockLogger()),
				DaemonEventBusLive,
				makePersistenceEffectLayer(filename),
				...(readQueryOverride
					? [Layer.succeed(ReadQueryEffectTag, readQueryOverride)]
					: []),
			),
		);

	it.effect("listSessions fetches from API and caches parent map", () => {
		const mockApi = makeMockApi();
		// Return sessions with a parentID to verify parent-map caching
		mockApi.session.list.mockResolvedValue([
			{ id: "child1", title: "Child", parentID: "parent1" },
			{ id: "parent1", title: "Parent" },
			// biome-ignore lint/suspicious/noExplicitAny: test mock with extra parentID field
		] as any);

		return Effect.gen(function* () {
			const result = yield* listSessions();

			expect(result).toHaveLength(2);
			expect(mockApi.session.list).toHaveBeenCalled();

			// Verify parent map was cached
			const ref = yield* SessionManagerStateTag;
			const state = yield* Ref.get(ref);
			const parentId = HashMap.get(state.cachedParentMap, "child1").pipe(
				Option.getOrNull,
			);
			expect(parentId).toBe("parent1");
		}).pipe(Effect.provide(Layer.fresh(makeTestLayer(mockApi))));
	});

	it.effect("createSession calls API and returns session", () => {
		const mockApi = makeMockApi();

		return Effect.gen(function* () {
			const result = yield* createSession("My session");

			expect(result.id).toBe("s-new");
			expect(mockApi.session.create).toHaveBeenCalled();
		}).pipe(Effect.provide(Layer.fresh(makeTestLayer(mockApi))));
	});

	it.effect("recordMessageActivity updates timestamp", () => {
		const mockApi = makeMockApi();

		return Effect.gen(function* () {
			yield* recordMessageActivity("s1", 12345);
			const ref = yield* SessionManagerStateTag;
			const state = yield* Ref.get(ref);
			const result = HashMap.get(state.lastMessageAt, "s1").pipe(
				Option.getOrNull,
			);

			expect(result).toBe(12345);
		}).pipe(Effect.provide(Layer.fresh(makeTestLayer(mockApi))));
	});

	it.effect("deleteSession clears all state maps", () => {
		const mockApi = makeMockApi();

		return Effect.gen(function* () {
			// Seed some state first
			yield* recordMessageActivity("s1", 12345);
			const ref = yield* SessionManagerStateTag;
			yield* Ref.update(ref, (s) => ({
				...s,
				cachedParentMap: HashMap.make(["child1", "s1"]),
				paginationCursors: HashMap.make(["s1", "cursor-1"]),
				forkMeta: HashMap.make([
					"s1",
					{
						forkMessageId: "m1",
						parentID: "p1",
						forkPointTimestamp: 100,
					},
				]),
				pendingQuestionCounts: HashMap.make(["s1", 3]),
			}));

			// Delete
			yield* deleteSession("s1");

			const state = yield* Ref.get(ref);
			const result = {
				hasActivity: HashMap.has(state.lastMessageAt, "s1"),
				hasCursor: HashMap.has(state.paginationCursors, "s1"),
				// child1's parent was s1, so it should be removed from parent map
				hasChildInParentMap: HashMap.has(state.cachedParentMap, "child1"),
			};

			expect(result.hasActivity).toBe(false);
			expect(result.hasCursor).toBe(false);
			expect(result.hasChildInParentMap).toBe(false);
			expect(HashMap.has(state.forkMeta, "s1")).toBe(false);
			expect(HashMap.has(state.pendingQuestionCounts, "s1")).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(makeTestLayer(mockApi))));
	});

	it.effect(
		"renames SQLite-backed Claude sessions through the event store",
		() => {
			const mockApi = makeMockApi();
			const dir = mkdtempSync(join(tmpdir(), "conduit-rename-session-"));
			const filename = join(dir, "events.db");
			const sessionId = "ses-claude-rename";
			const layer = makeLiveServiceLayer(mockApi, filename);

			return Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const runner = yield* ProjectionRunnerEffectTag;
				const readQuery = yield* ReadQueryEffectTag;
				const service = yield* SessionManagerServiceTag;
				const sql = yield* SqlClient.SqlClient;
				yield* runner.markRecovered();
				yield* sql`
					INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
					VALUES (${sessionId}, 'claude', 'Claude Session', 'idle', 1000, 1000)`;

				const created = yield* store.append(
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title: "Claude Session",
							provider: "claude",
						},
						{ provider: "claude", createdAt: 1000 },
					),
				);
				yield* runner.projectEvent(created);

				yield* service.renameSession(sessionId, "Useful title");

				let row = yield* readQuery.getSession(sessionId);
				let events = yield* store.readBySession(sessionId);
				expect(mockApi.session.update).not.toHaveBeenCalled();
				expect(row?.title).toBe("Useful title");
				expect(events.map((event) => event.type)).toEqual([
					"session.created",
					"session.renamed",
				]);
				expect(events[1]?.data).toEqual({
					sessionId,
					title: "Useful title",
				});

				const duplicateCreated = yield* store.append(
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title: "Claude Session",
							provider: "claude",
						},
						{ provider: "claude", createdAt: 3000 },
					),
				);
				yield* runner.projectEvent(duplicateCreated);

				row = yield* readQuery.getSession(sessionId);
				events = yield* store.readBySession(sessionId);
				const rows = yield* sql<{ title: string }>`
					SELECT title FROM sessions WHERE id = ${sessionId}`;
				expect(row?.title).toBe("Useful title");
				expect(rows[0]?.title).toBe("Useful title");
				expect(events.map((event) => event.type)).toEqual([
					"session.created",
					"session.renamed",
					"session.created",
				]);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"falls back to API rename when persistence has no matching session row",
		() => {
			const mockApi = makeMockApi();
			const dir = mkdtempSync(join(tmpdir(), "conduit-rename-missing-"));
			const filename = join(dir, "events.db");
			const sessionId = "ses-missing-rename";
			const layer = makeLiveServiceLayer(mockApi, filename);

			return Effect.gen(function* () {
				const store = yield* EventStoreEffectTag;
				const service = yield* SessionManagerServiceTag;

				yield* service.renameSession(sessionId, "API title");

				const events = yield* store.readBySession(sessionId);
				expect(mockApi.session.update).toHaveBeenCalledWith(sessionId, {
					title: "API title",
				});
				expect(events).toEqual([]);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"falls back to API rename when the persisted session provider is not Claude",
		() => {
			const mockApi = makeMockApi();
			const dir = mkdtempSync(join(tmpdir(), "conduit-rename-opencode-"));
			const filename = join(dir, "events.db");
			const sessionId = "ses-opencode-rename";
			const layer = makeLiveServiceLayer(mockApi, filename);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				const store = yield* EventStoreEffectTag;
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
					VALUES (${sessionId}, 'opencode', 'OpenCode Session', 'idle', 1000, 1000)`;

				yield* service.renameSession(sessionId, "API title");

				const events = yield* store.readBySession(sessionId);
				expect(mockApi.session.update).toHaveBeenCalledWith(sessionId, {
					title: "API title",
				});
				expect(events).toEqual([]);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"fails instead of falling back to API rename when the persisted session lookup fails",
		() => {
			const mockApi = makeMockApi();
			const dir = mkdtempSync(join(tmpdir(), "conduit-rename-read-fails-"));
			const filename = join(dir, "events.db");
			const sessionId = "ses-read-fails-rename";
			const readQueryFailure = new ReadQueryEffectError({
				operation: "getSession",
				cause: "read model unavailable",
			});
			const readQuery: ReadQueryEffect = {
				getToolContent: vi.fn(() => Effect.succeed(undefined)),
				getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
				getSession: vi.fn(() => Effect.fail(readQueryFailure)),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				listSessions: vi.fn(() => Effect.succeed([])),
				getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
			};
			const layer = makeLiveServiceLayer(mockApi, filename, readQuery);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;

				const result = yield* Effect.either(
					service.renameSession(sessionId, "API title"),
				);

				expect(result._tag).toBe("Left");
				expect(mockApi.session.update).not.toHaveBeenCalled();
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);
});
