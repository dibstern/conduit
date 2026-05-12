import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, HashMap, Layer, Ref, TestClock } from "effect";
import { expect, vi } from "vitest";
import {
	loadForkMetadata,
	saveForkMetadata,
} from "../../../src/lib/daemon/fork-metadata.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	ReadQueryTag,
	StatusPollerTag,
} from "../../../src/lib/effect/services.js";
import {
	listSessions,
	SessionManagerServiceLive,
	SessionManagerServiceTag,
	sendDualSessionLists,
	setForkEntry,
} from "../../../src/lib/effect/session-manager-service.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/effect/session-manager-state.js";
import type { SessionStatus } from "../../../src/lib/instance/sdk-types.js";
import type { ReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { runMigrations } from "../../../src/lib/persistence/migrations.js";
import type { SessionRow } from "../../../src/lib/persistence/read-model-types.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { schemaMigrations } from "../../../src/lib/persistence/schema.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

function makeRow(id: string, overrides?: Partial<SessionRow>): SessionRow {
	return {
		id,
		provider: "opencode",
		provider_sid: null,
		title: "Untitled",
		status: "idle",
		parent_id: null,
		fork_point_event: null,
		last_message_at: null,
		created_at: 1000,
		updated_at: 2000,
		...overrides,
	};
}

function makeReadQueryEffect(rows: readonly SessionRow[]): ReadQueryEffect {
	return {
		getToolContent: vi.fn(() => Effect.succeed(undefined)),
		getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
		getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
		listSessions: vi.fn(() => Effect.succeed(rows)),
		getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
	};
}

describe("SessionManagerService", () => {
	it.effect("projects provider sessions into frontend session info", () => {
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "list").mockResolvedValue([
			{
				id: "child-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: undefined as unknown as string,
				version: "1.0.0",
				parentID: "root-1",
				time: { created: 10, updated: 20 },
			},
			{
				id: "root-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Root",
				version: "1.0.0",
				time: { created: 30, updated: 40 },
			},
		]);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			makeSessionManagerStateLive({
				lastMessageAt: HashMap.fromIterable([["child-1", 100]]),
				forkMeta: HashMap.fromIterable([
					[
						"child-1",
						{
							parentID: "fallback-parent",
							forkMessageId: "msg-1",
							forkPointTimestamp: 90,
						},
					],
				]),
				pendingQuestionCounts: HashMap.fromIterable([["child-1", 2]]),
			}),
		);

		return Effect.gen(function* () {
			const sessions = yield* listSessions({
				statuses: {
					"child-1": { type: "busy" } as SessionStatus,
				},
			});
			const stateRef = yield* SessionManagerStateTag;
			const state = yield* Ref.get(stateRef);

			expect(sessions).toEqual([
				{
					id: "child-1",
					title: "Untitled",
					updatedAt: 100,
					messageCount: 0,
					parentID: "root-1",
					forkMessageId: "msg-1",
					forkPointTimestamp: 90,
					processing: true,
					pendingQuestionCount: 2,
				},
				{
					id: "root-1",
					title: "Root",
					updatedAt: 30,
					messageCount: 0,
				},
			]);
			expect(Array.from(HashMap.toEntries(state.cachedParentMap))).toEqual([
				["child-1", "root-1"],
			]);
		}).pipe(Effect.provide(layer));
	});

	it.effect("stores fork metadata for subsequent service session lists", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "conduit-fork-meta-"));
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "list").mockResolvedValue([
			{
				id: "forked-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Forked",
				version: "1.0.0",
				time: { created: 50, updated: 60 },
			},
		]);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			makeSessionManagerStateLive(),
		);

		return Effect.gen(function* () {
			yield* setForkEntry(
				"forked-1",
				{
					parentID: "parent-1",
					forkMessageId: "msg-1",
					forkPointTimestamp: 40,
				},
				tmpDir,
			);

			const sessions = yield* listSessions();

			expect(sessions).toEqual([
				{
					id: "forked-1",
					title: "Forked",
					updatedAt: 50,
					messageCount: 0,
					parentID: "parent-1",
					forkMessageId: "msg-1",
					forkPointTimestamp: 40,
				},
			]);
			expect(loadForkMetadata(tmpDir).get("forked-1")).toEqual({
				parentID: "parent-1",
				forkMessageId: "msg-1",
				forkPointTimestamp: 40,
			});
		}).pipe(
			Effect.provide(layer),
			Effect.ensuring(Effect.sync(() => rmSync(tmpDir, { recursive: true }))),
		);
	});

	it.effect("prefers the Effect SQLite read path when available", () => {
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "list").mockRejectedValue(
			new Error("provider API should not be called"),
		);
		const readQuery = makeReadQueryEffect([
			makeRow("forked-1", {
				title: "Forked",
				parent_id: null,
				fork_point_event: null,
				updated_at: 300,
			}),
		]);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			Layer.succeed(ReadQueryEffectTag, readQuery),
			makeSessionManagerStateLive({
				forkMeta: HashMap.fromIterable([
					[
						"forked-1",
						{
							parentID: "parent-1",
							forkMessageId: "msg-1",
							forkPointTimestamp: 250,
						},
					],
				]),
			}),
		);

		return Effect.gen(function* () {
			const sessions = yield* listSessions();

			expect(readQuery.listSessions).toHaveBeenCalledWith(undefined);
			expect(api.session.list).not.toHaveBeenCalled();
			expect(sessions).toEqual([
				{
					id: "forked-1",
					title: "Forked",
					updatedAt: 300,
					messageCount: 0,
					parentID: "parent-1",
					forkMessageId: "msg-1",
					forkPointTimestamp: 250,
				},
			]);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"falls back to the sync SQLite read path before provider API",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "list").mockRejectedValue(
				new Error("provider API should not be called"),
			);
			const db = SqliteClient.memory();
			runMigrations(db, schemaMigrations);
			db.execute(
				`INSERT INTO sessions (id, provider, title, status, parent_id, fork_point_event, created_at, updated_at)
				 VALUES (?, 'opencode', ?, 'idle', NULL, NULL, ?, ?)`,
				["session-1", "SQLite Session", 100, 400],
			);
			const readQuery = new ReadQueryService(db);
			const listSessionsSpy = vi.spyOn(readQuery, "listSessions");
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(ReadQueryTag, readQuery),
				makeSessionManagerStateLive(),
			);

			return Effect.gen(function* () {
				const sessions = yield* listSessions();

				expect(listSessionsSpy).toHaveBeenCalledWith(undefined);
				expect(api.session.list).not.toHaveBeenCalled();
				expect(sessions).toEqual([
					{
						id: "session-1",
						title: "SQLite Session",
						updatedAt: 400,
						messageCount: 0,
					},
				]);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(Effect.sync(() => db.close())),
			);
		},
	);

	it.effect("keeps the parent map when fetching roots only", () => {
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "list").mockResolvedValue([
			{
				id: "root-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Root",
				version: "1.0.0",
				time: { created: 1, updated: 1 },
			},
		]);
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			makeSessionManagerStateLive({
				cachedParentMap: HashMap.fromIterable([["child-1", "root-1"]]),
			}),
		);

		return Effect.gen(function* () {
			yield* listSessions({ roots: true });
			const stateRef = yield* SessionManagerStateTag;
			const state = yield* Ref.get(stateRef);

			expect(Array.from(HashMap.toEntries(state.cachedParentMap))).toEqual([
				["child-1", "root-1"],
			]);
			expect(api.session.list).toHaveBeenCalledWith({ roots: true });
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"sends roots immediately and all sessions in the background",
		() => {
			const api = makeMockOpenCodeAPI();
			let resolveAllSessions!: (
				value: Awaited<ReturnType<typeof api.session.list>>,
			) => void;
			const allSessions = new Promise<
				Awaited<ReturnType<typeof api.session.list>>
			>((resolve) => {
				resolveAllSessions = resolve;
			});
			vi.spyOn(api.session, "list").mockImplementation(async (options) => {
				if (options?.roots) {
					return [
						{
							id: "root-1",
							projectID: "project-1",
							directory: "/tmp/project",
							title: "Root",
							version: "1.0.0",
							time: { created: 1, updated: 1 },
						},
					];
				}
				return allSessions;
			});
			const logger = makeMockLogger();
			const messages: unknown[] = [];
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, logger),
				makeSessionManagerStateLive(),
			);

			return Effect.gen(function* () {
				yield* sendDualSessionLists((msg) => messages.push(msg));
				expect(messages).toEqual([
					{
						type: "session_list",
						sessions: [
							{
								id: "root-1",
								title: "Root",
								updatedAt: 1,
								messageCount: 0,
							},
						],
						roots: true,
					},
				]);

				resolveAllSessions([
					{
						id: "child-1",
						projectID: "project-1",
						directory: "/tmp/project",
						title: "Child",
						version: "1.0.0",
						parentID: "root-1",
						time: { created: 2, updated: 2 },
					},
				]);
				yield* Effect.promise(
					() => new Promise((resolve) => setTimeout(resolve, 0)),
				);
				expect(messages).toEqual([
					{
						type: "session_list",
						sessions: [
							{
								id: "root-1",
								title: "Root",
								updatedAt: 1,
								messageCount: 0,
							},
						],
						roots: true,
					},
					{
						type: "session_list",
						sessions: [
							{
								id: "child-1",
								title: "Child",
								updatedAt: 2,
								messageCount: 0,
								parentID: "root-1",
							},
						],
						roots: false,
					},
				]);
				expect(logger.warn).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"logs background all-session failures without failing roots",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "list").mockImplementation(async (options) => {
				if (options?.roots) {
					return [
						{
							id: "root-1",
							projectID: "project-1",
							directory: "/tmp/project",
							title: "Root",
							version: "1.0.0",
							time: { created: 1, updated: 1 },
						},
					];
				}
				throw new Error("all sessions unavailable");
			});
			const logger = makeMockLogger();
			const messages: unknown[] = [];
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, logger),
				makeSessionManagerStateLive(),
			);

			return Effect.gen(function* () {
				yield* sendDualSessionLists((msg) => messages.push(msg));
				expect(messages).toEqual([
					{
						type: "session_list",
						sessions: [
							{
								id: "root-1",
								title: "Root",
								updatedAt: 1,
								messageCount: 0,
							},
						],
						roots: true,
					},
				]);

				yield* Effect.yieldNow();
				yield* TestClock.adjust("4 seconds");
				yield* Effect.yieldNow();

				expect(logger.warn).toHaveBeenCalledWith(
					expect.stringContaining("Background all-sessions fetch failed:"),
				);
				expect(messages).toHaveLength(1);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("live service falls back to current status poller statuses", () => {
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "list").mockResolvedValue([
			{
				id: "session-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Session 1",
				version: "1.0.0",
				time: { created: 1, updated: 1 },
			},
		]);
		const layer = SessionManagerServiceLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(StatusPollerTag, {
						isProcessing: vi.fn(() => true),
						clearMessageActivity: vi.fn(),
						getCurrentStatuses: vi.fn(() => ({
							"session-1": { type: "busy" } as SessionStatus,
						})),
					}),
					makeSessionManagerStateLive(),
				),
			),
		);

		return Effect.gen(function* () {
			const service = yield* SessionManagerServiceTag;
			const sessions = yield* service.listSessions();

			expect(sessions).toEqual([
				{
					id: "session-1",
					title: "Session 1",
					updatedAt: 1,
					messageCount: 0,
					processing: true,
				},
			]);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"live service loads persisted fork metadata into service state",
		() => {
			const tmpDir = mkdtempSync(join(tmpdir(), "conduit-fork-meta-live-"));
			saveForkMetadata(
				new Map([
					[
						"forked-1",
						{
							parentID: "parent-1",
							forkMessageId: "msg-1",
							forkPointTimestamp: 250,
						},
					],
				]),
				tmpDir,
			);
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "list").mockResolvedValue([
				{
					id: "forked-1",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "Forked",
					version: "1.0.0",
					time: { created: 50, updated: 60 },
				},
			]);
			const config: ProjectRelayConfig = {
				httpServer: createServer(),
				opencodeUrl: "http://localhost:4096",
				projectDir: "/tmp/project",
				slug: "project",
				configDir: tmpDir,
			};
			const layer = SessionManagerServiceLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(OpenCodeAPITag, api),
						Layer.succeed(LoggerTag, makeMockLogger()),
						Layer.succeed(ConfigTag, config),
						makeSessionManagerStateLive(),
					),
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				const sessions = yield* service.listSessions();

				expect(sessions).toEqual([
					{
						id: "forked-1",
						title: "Forked",
						updatedAt: 50,
						messageCount: 0,
						parentID: "parent-1",
						forkMessageId: "msg-1",
						forkPointTimestamp: 250,
					},
				]);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(Effect.sync(() => rmSync(tmpDir, { recursive: true }))),
			);
		},
	);
});
