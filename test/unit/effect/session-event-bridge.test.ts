import EventEmitter from "node:events";
import { readFileSync } from "node:fs";
import { describe, it } from "@effect/vitest";
import {
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	PubSub,
	Queue,
	Scope,
} from "effect";
import { assert, expect } from "vitest";
import {
	DaemonEventBusLive,
	DaemonEventBusTag,
	subscribeToDaemonEvents,
} from "../../../src/lib/effect/daemon-pubsub.js";
import type { SessionManagerShape } from "../../../src/lib/effect/services.js";
import { SessionManagerTag } from "../../../src/lib/effect/services.js";
import type { SessionDetail } from "../../../src/lib/instance/sdk-types.js";
import { SessionEventBridgeLive } from "../../../src/lib/relay/session-event-bridge.js";

// ─── FakeSessionManager ───────────────────────────────────────────────────
// Minimal EventEmitter stub satisfying SessionManagerShape for bridge tests.

class FakeSessionManager extends EventEmitter implements SessionManagerShape {
	listSessions() {
		return Promise.resolve([]);
	}
	searchSessions() {
		return Promise.resolve([]);
	}
	loadPreRenderedHistory() {
		return Promise.resolve({ messages: [], hasMore: false });
	}
	getDefaultSessionId() {
		return Promise.resolve("fake-id");
	}
	getLastKnownSessionCount() {
		return 0;
	}
	getSessionParentMap() {
		return new Map();
	}
	getLastMessageAtMap() {
		return new Map();
	}
	getForkEntry() {
		return undefined;
	}
	createSession() {
		return Promise.resolve({} as unknown as SessionDetail);
	}
	deleteSession() {
		return Promise.resolve();
	}
	renameSession() {
		return Promise.resolve();
	}
	initialize() {
		return Promise.resolve("fake-id");
	}
	recordMessageActivity() {}
	addToParentMap() {}
	setForkEntry() {}
	clearPaginationCursor() {}
	seedPaginationCursor() {}
	incrementPendingQuestionCount() {}
	decrementPendingQuestionCount() {}
	setPendingQuestionCounts() {}
	sendDualSessionLists() {
		return Promise.resolve();
	}
}

// ─── Test helpers ─────────────────────────────────────────────────────────

function makeTestLayer(mgr: FakeSessionManager) {
	return Layer.fresh(
		Layer.provideMerge(
			SessionEventBridgeLive,
			Layer.mergeAll(
				Layer.succeed(SessionManagerTag, mgr as unknown as SessionManagerShape),
				DaemonEventBusLive,
			),
		),
	);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("SessionEventBridge", () => {
	it.scoped(
		"forwards session_lifecycle created to SessionCreated on PubSub",
		() =>
			Effect.gen(function* () {
				const sessionMgr = yield* SessionManagerTag;
				const sub = yield* subscribeToDaemonEvents;

				(sessionMgr as unknown as FakeSessionManager).emit(
					"session_lifecycle",
					{ type: "created", sessionId: "sess-1" },
				);

				const event = yield* Queue.take(sub);
				assert(event._tag === "SessionCreated");
				expect(event.sessionId).toBe("sess-1");
			}).pipe(Effect.provide(makeTestLayer(new FakeSessionManager()))),
	);

	it.scoped(
		"forwards session_lifecycle deleted to SessionDeleted on PubSub",
		() =>
			Effect.gen(function* () {
				const sessionMgr = yield* SessionManagerTag;
				const sub = yield* subscribeToDaemonEvents;

				(sessionMgr as unknown as FakeSessionManager).emit(
					"session_lifecycle",
					{ type: "deleted", sessionId: "sess-2" },
				);

				const event = yield* Queue.take(sub);
				assert(event._tag === "SessionDeleted");
				expect(event.sessionId).toBe("sess-2");
			}).pipe(Effect.provide(makeTestLayer(new FakeSessionManager()))),
	);

	it.scoped("forwards broadcast to RelayBroadcast on PubSub", () =>
		Effect.gen(function* () {
			const sessionMgr = yield* SessionManagerTag;
			const sub = yield* subscribeToDaemonEvents;

			const msg = { type: "session_list" as const, sessions: [] };
			(sessionMgr as unknown as FakeSessionManager).emit("broadcast", msg);

			const event = yield* Queue.take(sub);
			assert(event._tag === "RelayBroadcast");
			expect(event.message).toEqual(msg);
		}).pipe(Effect.provide(makeTestLayer(new FakeSessionManager()))),
	);

	it("does not escape callback handling through Effect.run* calls", () => {
		const source = readFileSync(
			new URL(
				"../../../src/lib/relay/session-event-bridge.ts",
				import.meta.url,
			),
			"utf8",
		);
		expect(source).not.toMatch(/Effect\.run(Promise|Sync)/);
	});

	it.scoped("removes EventEmitter listeners when the layer scope closes", () =>
		Effect.gen(function* () {
			const sessionMgr = new FakeSessionManager();
			const layerScope = yield* Scope.make();
			const context = yield* Layer.buildWithScope(
				makeTestLayer(sessionMgr),
				layerScope,
			);
			const bus = Context.get(context, DaemonEventBusTag);
			const sub = yield* PubSub.subscribe(bus);

			expect(sessionMgr.listenerCount("broadcast")).toBe(1);
			expect(sessionMgr.listenerCount("session_lifecycle")).toBe(1);

			yield* Scope.close(layerScope, Exit.void);

			expect(sessionMgr.listenerCount("broadcast")).toBe(0);
			expect(sessionMgr.listenerCount("session_lifecycle")).toBe(0);

			sessionMgr.emit("session_lifecycle", {
				type: "created",
				sessionId: "after-close",
			});
			const event = yield* Queue.poll(sub);
			expect(Option.isNone(event)).toBe(true);
		}),
	);

	it.scoped("forwards a synchronous event burst in order", () =>
		Effect.gen(function* () {
			const sessionMgr = yield* SessionManagerTag;
			const sub = yield* subscribeToDaemonEvents;
			const msg = { type: "session_list" as const, sessions: [] };

			(sessionMgr as unknown as FakeSessionManager).emit("session_lifecycle", {
				type: "created",
				sessionId: "sess-burst",
			});
			(sessionMgr as unknown as FakeSessionManager).emit("broadcast", msg);
			(sessionMgr as unknown as FakeSessionManager).emit("session_lifecycle", {
				type: "deleted",
				sessionId: "sess-burst",
			});

			const first = yield* Queue.take(sub);
			const second = yield* Queue.take(sub);
			const third = yield* Queue.take(sub);

			expect(first._tag).toBe("SessionCreated");
			expect(second._tag).toBe("RelayBroadcast");
			expect(third._tag).toBe("SessionDeleted");
		}).pipe(Effect.provide(makeTestLayer(new FakeSessionManager()))),
	);
});
