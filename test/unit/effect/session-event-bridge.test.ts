import EventEmitter from "node:events";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Queue } from "effect";
import { assert, expect } from "vitest";
import {
	DaemonEventBusLive,
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
});
