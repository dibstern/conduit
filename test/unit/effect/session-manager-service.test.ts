import { describe, it } from "@effect/vitest";
import { Effect, HashMap, Layer, Ref, TestClock } from "effect";
import { expect, vi } from "vitest";
import {
	LoggerTag,
	OpenCodeAPITag,
	StatusPollerTag,
} from "../../../src/lib/effect/services.js";
import {
	listSessions,
	SessionManagerServiceLive,
	SessionManagerServiceTag,
	sendDualSessionLists,
} from "../../../src/lib/effect/session-manager-service.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/effect/session-manager-state.js";
import type { SessionStatus } from "../../../src/lib/instance/sdk-types.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

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
});
