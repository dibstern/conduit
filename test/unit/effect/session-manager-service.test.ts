import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, HashMap, Layer, Option, Queue, Ref, TestClock } from "effect";
import { expect, vi } from "vitest";
import {
	loadForkMetadata,
	saveForkMetadata,
} from "../../../src/lib/daemon/fork-metadata.js";
import {
	DaemonEventBusLive,
	subscribeToDaemonEvents,
} from "../../../src/lib/effect/daemon-pubsub.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeAPITag,
	SessionManagerTag,
	StatusPollerTag,
} from "../../../src/lib/effect/services.js";
import {
	clearPaginationCursor,
	decrementPendingQuestionCount,
	incrementPendingQuestionCount,
	listSessions,
	loadHistory,
	loadPreRenderedHistory,
	renameSession,
	SessionManagerServiceLive,
	SessionManagerServiceTag,
	seedPaginationCursor,
	sendDualSessionLists,
	setForkEntry,
	setPendingQuestionCounts,
} from "../../../src/lib/effect/session-manager-service.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/effect/session-manager-state.js";
import { OpenCodeApiError } from "../../../src/lib/errors.js";
import type { SessionStatus } from "../../../src/lib/instance/sdk-types.js";
import type { ReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { SessionRow } from "../../../src/lib/persistence/read-model-types.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
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

function makeHistoryMessage(
	id: string,
	role: "user" | "assistant" = "assistant",
	text?: string,
): HistoryMessage {
	return {
		id,
		role,
		...(text
			? {
					parts: [
						{
							id: `part-${id}`,
							type: "text",
							text,
						},
					],
				}
			: {}),
	};
}

describe("SessionManagerService", () => {
	it.effect("updates pending question counts in service state", () =>
		Effect.gen(function* () {
			const stateRef = yield* SessionManagerStateTag;

			yield* incrementPendingQuestionCount("session-1");
			yield* incrementPendingQuestionCount("session-1");
			yield* incrementPendingQuestionCount("session-2");

			let state = yield* Ref.get(stateRef);
			expect(HashMap.get(state.pendingQuestionCounts, "session-1")).toEqual(
				Option.some(2),
			);
			expect(HashMap.get(state.pendingQuestionCounts, "session-2")).toEqual(
				Option.some(1),
			);

			yield* decrementPendingQuestionCount("session-1");
			state = yield* Ref.get(stateRef);
			expect(HashMap.get(state.pendingQuestionCounts, "session-1")).toEqual(
				Option.some(1),
			);

			yield* decrementPendingQuestionCount("session-1");
			yield* decrementPendingQuestionCount("missing-session");
			state = yield* Ref.get(stateRef);
			expect(HashMap.has(state.pendingQuestionCounts, "session-1")).toBe(false);
			expect(HashMap.has(state.pendingQuestionCounts, "missing-session")).toBe(
				false,
			);

			yield* setPendingQuestionCounts(
				new Map([
					["session-3", 3],
					["session-4", 1],
				]),
			);
			state = yield* Ref.get(stateRef);
			expect(HashMap.has(state.pendingQuestionCounts, "session-2")).toBe(false);
			expect(HashMap.get(state.pendingQuestionCounts, "session-3")).toEqual(
				Option.some(3),
			);
			expect(HashMap.get(state.pendingQuestionCounts, "session-4")).toEqual(
				Option.some(1),
			);
		}).pipe(Effect.provide(makeSessionManagerStateLive())),
	);

	it.effect("live service exposes pending question count operations", () => {
		const api = makeMockOpenCodeAPI();
		const layer = Layer.provideMerge(
			SessionManagerServiceLive,
			Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, makeMockLogger()),
				makeSessionManagerStateLive(),
				DaemonEventBusLive,
			),
		);

		return Effect.gen(function* () {
			const service = yield* SessionManagerServiceTag;
			const stateRef = yield* SessionManagerStateTag;

			yield* service.incrementPendingQuestionCount("session-1");
			yield* service.decrementPendingQuestionCount("session-1");

			const state = yield* Ref.get(stateRef);
			expect(HashMap.has(state.pendingQuestionCounts, "session-1")).toBe(false);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"live service projects pending question counts into session lists",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "list").mockResolvedValue([
				{
					id: "session-1",
					projectID: "project-1",
					directory: "/tmp/project",
					title: "Session 1",
					version: "1.0.0",
					time: { created: 10, updated: 20 },
				},
			]);
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;

				yield* service.incrementPendingQuestionCount("session-1");
				yield* service.incrementPendingQuestionCount("session-1");
				let sessions = yield* service.listSessions();
				expect(sessions).toEqual([
					expect.objectContaining({
						id: "session-1",
						pendingQuestionCount: 2,
					}),
				]);

				yield* service.decrementPendingQuestionCount("session-1");
				yield* service.decrementPendingQuestionCount("session-1");
				sessions = yield* service.listSessions();
				expect(sessions).toEqual([
					expect.not.objectContaining({
						pendingQuestionCount: expect.any(Number),
					}),
				]);
			}).pipe(Effect.provide(layer));
		},
	);

	it.scoped(
		"live service publishes one SessionCreated after create succeeds",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "create").mockResolvedValue({
				id: "created-session",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Created",
				version: "1.0.0",
				time: { created: 10, updated: 10 },
			});
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
				),
			);

			return Effect.gen(function* () {
				const sub = yield* subscribeToDaemonEvents;
				const service = yield* SessionManagerServiceTag;

				const session = yield* service.createSession("Created");

				expect(session.id).toBe("created-session");
				expect(api.session.create).toHaveBeenCalledWith({ title: "Created" });
				const event = yield* Queue.poll(sub);
				expect(Option.getOrNull(event)).toMatchObject({
					_tag: "SessionCreated",
					sessionId: "created-session",
				});
				const extra = yield* Queue.poll(sub);
				expect(Option.isNone(extra)).toBe(true);
			}).pipe(Effect.provide(Layer.fresh(layer)));
		},
	);

	it.scoped(
		"live service publishes one SessionDeleted after delete succeeds",
		() => {
			const api = makeMockOpenCodeAPI();
			vi.spyOn(api.session, "delete").mockResolvedValue(undefined);
			const layer = Layer.provideMerge(
				SessionManagerServiceLive,
				Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, api),
					Layer.succeed(LoggerTag, makeMockLogger()),
					makeSessionManagerStateLive(),
					DaemonEventBusLive,
				),
			);

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				yield* service.recordMessageActivity("deleted-session", 123);
				const sub = yield* subscribeToDaemonEvents;

				yield* service.deleteSession("deleted-session");

				expect(api.session.delete).toHaveBeenCalledWith("deleted-session");
				const event = yield* Queue.poll(sub);
				expect(Option.getOrNull(event)).toMatchObject({
					_tag: "SessionDeleted",
					sessionId: "deleted-session",
				});
				const extra = yield* Queue.poll(sub);
				expect(Option.isNone(extra)).toBe(true);
			}).pipe(Effect.provide(Layer.fresh(layer)));
		},
	);

	it.effect(
		"loads pre-rendered history and stores the oldest message cursor",
		() => {
			const api = makeMockOpenCodeAPI();
			const messages = [
				makeHistoryMessage("msg-oldest", "user", "hello"),
				makeHistoryMessage("msg-newest", "assistant", "**bold**"),
			];
			vi.spyOn(api.session, "messagesPage").mockResolvedValue(
				messages as unknown as Awaited<
					ReturnType<typeof api.session.messagesPage>
				>,
			);
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, makeMockLogger()),
				makeSessionManagerStateLive(),
			);

			return Effect.gen(function* () {
				const page = yield* loadPreRenderedHistory("session-1");
				const stateRef = yield* SessionManagerStateTag;
				const state = yield* Ref.get(stateRef);

				expect(api.session.messagesPage).toHaveBeenCalledWith("session-1", {
					limit: 50,
				});
				expect(page.messages).toHaveLength(2);
				expect(page.messages[1]?.parts?.[0]?.renderedHtml).toContain(
					"<strong>bold</strong>",
				);
				const cursor = HashMap.get(state.paginationCursors, "session-1");
				expect(cursor._tag).toBe("Some");
				if (cursor._tag === "Some") {
					expect(cursor.value).toBe("msg-oldest");
				}
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("returns an empty older page when no cursor is known", () => {
		const api = makeMockOpenCodeAPI();
		const messagesPage = vi.spyOn(api.session, "messagesPage");
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			Layer.succeed(LoggerTag, makeMockLogger()),
			makeSessionManagerStateLive(),
		);

		return Effect.gen(function* () {
			const page = yield* loadHistory("session-1", 50);

			expect(page).toEqual({ messages: [], hasMore: false });
			expect(messagesPage).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"keeps seed/clear pagination cursor ownership in service state",
		() => {
			const layer = makeSessionManagerStateLive();

			return Effect.gen(function* () {
				yield* seedPaginationCursor("session-1", "msg-oldest");
				yield* seedPaginationCursor("session-1", "msg-newer");

				const stateRef = yield* SessionManagerStateTag;
				const seeded = yield* Ref.get(stateRef);
				const seededCursor = HashMap.get(seeded.paginationCursors, "session-1");
				expect(seededCursor._tag).toBe("Some");
				if (seededCursor._tag === "Some") {
					expect(seededCursor.value).toBe("msg-oldest");
				}

				yield* clearPaginationCursor("session-1");
				const cleared = yield* Ref.get(stateRef);
				expect(HashMap.get(cleared.paginationCursors, "session-1")._tag).toBe(
					"None",
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"falls back to cursor scan when an older page cursor is stale",
		() => {
			const api = makeMockOpenCodeAPI();
			const staleCursor = new OpenCodeApiError({
				message: "Invalid cursor",
				endpoint: "/session/session-1/message",
				responseStatus: 400,
				responseBody: { error: "Invalid cursor" },
			});
			const messagesPage = vi
				.spyOn(api.session, "messagesPage")
				.mockRejectedValueOnce(staleCursor)
				.mockResolvedValueOnce([
					makeHistoryMessage("msg-older"),
					makeHistoryMessage("msg-cursor"),
					makeHistoryMessage("msg-newer"),
				] as unknown as Awaited<ReturnType<typeof api.session.messagesPage>>);
			const logger = makeMockLogger();
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(LoggerTag, logger),
				makeSessionManagerStateLive({
					paginationCursors: HashMap.fromIterable([
						["session-1", "msg-cursor"],
					]),
				}),
			);

			return Effect.gen(function* () {
				const page = yield* loadHistory("session-1", 50);
				const stateRef = yield* SessionManagerStateTag;
				const state = yield* Ref.get(stateRef);

				expect(messagesPage).toHaveBeenNthCalledWith(1, "session-1", {
					limit: 50,
					before: "msg-cursor",
				});
				expect(messagesPage).toHaveBeenNthCalledWith(2, "session-1", {
					limit: 10000,
				});
				expect(page.messages.map((message) => message.id)).toEqual([
					"msg-older",
				]);
				expect(page.hasMore).toBe(false);
				expect(HashMap.get(state.paginationCursors, "session-1")._tag).toBe(
					"None",
				);
				expect(logger.warn).toHaveBeenCalledWith(
					expect.stringContaining("Pagination cursor failed for session-1"),
				);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("renames a session through the provider API", () => {
		const api = makeMockOpenCodeAPI();
		const update = vi.spyOn(api.session, "update").mockResolvedValue(undefined);
		const layer = Layer.succeed(OpenCodeAPITag, api);

		return Effect.gen(function* () {
			yield* renameSession("session-1", "New Title");

			expect(update).toHaveBeenCalledWith("session-1", {
				title: "New Title",
			});
		}).pipe(Effect.provide(layer));
	});

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
					DaemonEventBusLive,
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
						DaemonEventBusLive,
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

	it.effect(
		"live service mirrors fork metadata into the legacy session manager bridge",
		() => {
			const tmpDir = mkdtempSync(join(tmpdir(), "conduit-fork-meta-bridge-"));
			const api = makeMockOpenCodeAPI();
			const legacySetForkEntry = vi.fn();
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
						Layer.succeed(SessionManagerTag, {
							setForkEntry: legacySetForkEntry,
						} as never),
						makeSessionManagerStateLive(),
						DaemonEventBusLive,
					),
				),
			);
			const entry = {
				parentID: "parent-1",
				forkMessageId: "msg-1",
				forkPointTimestamp: 250,
			};

			return Effect.gen(function* () {
				const service = yield* SessionManagerServiceTag;
				yield* service.setForkEntry("forked-1", entry);

				expect(legacySetForkEntry).toHaveBeenCalledWith("forked-1", entry);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(Effect.sync(() => rmSync(tmpDir, { recursive: true }))),
			);
		},
	);
});
