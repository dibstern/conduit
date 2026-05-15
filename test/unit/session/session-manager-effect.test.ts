import { describe, it } from "@effect/vitest";
import { Effect, HashMap, Layer, Option, Ref } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";

import {
	createSession,
	deleteSession,
	listSessions,
	recordMessageActivity,
} from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeSessionManagerStateLive,
	SessionManagerStateTag,
} from "../../../src/lib/domain/relay/Services/session-manager-state.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";

describe("SessionManager Effect", () => {
	const makeMockApi = () => ({
		session: {
			list: vi.fn(async () => [{ id: "s1", title: "Test" }]),
			create: vi.fn(async () => ({ id: "s-new", title: "New" })),
			delete: vi.fn(async () => undefined),
		},
	});

	const makeTestLayer = (mockApi: ReturnType<typeof makeMockApi>) =>
		Layer.mergeAll(
			makeSessionManagerStateLive(),
			Layer.succeed(OpenCodeAPITag, mockApi as unknown as OpenCodeAPI),
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
});
