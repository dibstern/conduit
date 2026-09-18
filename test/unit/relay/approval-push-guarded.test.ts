// The approval and question dings go through the guarded sender (ni8.23 delta 1).
//
// Two bugs met here. The production approval/question paths called the
// unguarded `sendPushForEvent`, so every reconnect re-dinged every pending
// request; and the question ding carried `toolId: ""`, so two different
// questions in one turn were one alert — the ledger claimed the first and
// silently swallowed the second.
//
// Driven through `handleSSEEventEffect`, which is the path the live relay runs,
// against a real ledger on a real store.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import { AlertLedgerLive } from "../../../src/lib/domain/relay/Services/alert-ledger.js";
import {
	PendingInteractionServiceLive,
	type PendingInteractionServiceTag,
} from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	makeOverridesStateLive,
	type OverridesStateTag,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	type EffectSSEWiringDeps,
	handleSSEEventEffect,
} from "../../../src/lib/relay/sse-wiring.js";
import type { PushDeliveryReport } from "../../../src/lib/server/push.js";
import type { OpenCodeEvent } from "../../../src/lib/types.js";
import { createMockSSEWiringDeps } from "../../helpers/mock-factories.js";

const SESSION = "session-1";

const delivered: PushDeliveryReport = {
	delivered: ["client-1"],
	expired: [],
	failed: [],
};

const silentBus = Layer.succeed(SessionEventBusTag, {
	publish: () => Effect.void,
	publishAdvance: () => Effect.void,
	subscribe: () => Effect.succeed(Stream.empty),
	subscribeAdvances: () => Effect.succeed(Stream.empty),
} satisfies SessionEventBus);

const makeDeps = (pushed: string[]) => {
	const deps = createMockSSEWiringDeps({
		pushManager: {
			sendToAll: (payload: { tag: string }) => {
				pushed.push(payload.tag);
				return Promise.resolve(delivered);
			},
		} as unknown as NonNullable<
			ReturnType<typeof createMockSSEWiringDeps>["pushManager"]
		>,
	});
	const {
		processingTimeouts: _processingTimeouts,
		pendingInteractions: _pendingInteractions,
		sessionService: _sessionService,
		getSessionParentMap: _getSessionParentMap,
		getSessionStatuses: _getSessionStatuses,
		statusPoller: _statusPoller,
		...base
	} = deps;
	const effectDeps = {
		...base,
		providerInstanceId: "opencode",
	} satisfies EffectSSEWiringDeps;
	return effectDeps;
};

const run = async (
	body: (
		pushed: string[],
	) => Effect.Effect<
		void,
		unknown,
		| SqlClient.SqlClient
		| PendingInteractionServiceTag
		| OverridesStateTag
		| SessionManagerServiceTag
	>,
): Promise<string[]> => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-approval-push-"));
	const pushed: string[] = [];
	const persistence = makePersistenceEffectLayer(
		join(dir, "events.db"),
		createAllEffectProjectors(),
		silentBus,
	);
	const layer = Layer.mergeAll(
		persistence,
		silentBus,
		PendingInteractionServiceLive,
		makeOverridesStateLive(),
		Layer.succeed(SessionManagerServiceTag, {
			getSessionParentMap: () => Effect.succeed(new Map()),
		} as never),
	).pipe(Layer.provideMerge(persistence));
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent("session.created", SESSION, {
						sessionId: SESSION,
						title: SESSION,
						provider: "opencode",
					}),
				]);
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
					INSERT INTO turns (id, session_id, state, requested_at, completed_at)
					VALUES ('turn-1', ${SESSION}, 'completed', 1000, 1001)`;
				yield* body(pushed);
			}).pipe(
				Effect.provide(Layer.provideMerge(AlertLedgerLive, layer)),
				Effect.orDie,
			),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return pushed;
};

const permissionAsked = (id: string): OpenCodeEvent => ({
	type: "permission.asked",
	properties: {
		id,
		sessionID: SESSION,
		permission: "edit",
		patterns: [],
		metadata: {},
	},
});

const questionAsked = (id: string): OpenCodeEvent => ({
	type: "question.asked",
	properties: {
		id,
		sessionID: SESSION,
		questions: [{ question: "which?", options: [{ label: "a" }] }],
	},
});

it("dings once for a permission request the stream delivers twice", async () => {
	const pushed = await run((p) =>
		Effect.gen(function* () {
			const deps = makeDeps(p);
			yield* handleSSEEventEffect(deps, permissionAsked("perm-1"));
			// SSE reconnects and the same request arrives again.
			yield* handleSSEEventEffect(deps, permissionAsked("perm-1"));
		}),
	);
	expect(pushed).toEqual(["perm-perm-1"]);
});

it("dings twice for two different permission requests", async () => {
	const pushed = await run((p) =>
		Effect.gen(function* () {
			const deps = makeDeps(p);
			yield* handleSSEEventEffect(deps, permissionAsked("perm-1"));
			yield* handleSSEEventEffect(deps, permissionAsked("perm-2"));
		}),
	);
	expect(pushed).toEqual(["perm-perm-1", "perm-perm-2"]);
});

it("dings once for a question the stream delivers twice", async () => {
	const pushed = await run((p) =>
		Effect.gen(function* () {
			const deps = makeDeps(p);
			yield* handleSSEEventEffect(deps, questionAsked("que-1"));
			yield* handleSSEEventEffect(deps, questionAsked("que-1"));
		}),
	);
	expect(pushed).toEqual(["opencode-ask"]);
});

it("dings twice for two different questions in the same turn", async () => {
	// With `toolId: ""` these two were the same alert, and the second question
	// was never announced to anyone who was not looking at the screen.
	const pushed = await run((p) =>
		Effect.gen(function* () {
			const deps = makeDeps(p);
			yield* handleSSEEventEffect(deps, questionAsked("que-1"));
			yield* handleSSEEventEffect(deps, questionAsked("que-2"));
		}),
	);
	expect(pushed).toEqual(["opencode-ask", "opencode-ask"]);
});

it("claims each question under its own id, not an empty one", async () => {
	// The identity is the assertion. `ask_user:` for every question is what made
	// the second one vanish; the key has to name the question.
	await run((p) =>
		Effect.gen(function* () {
			const deps = makeDeps(p);
			yield* handleSSEEventEffect(deps, questionAsked("que-1"));
			yield* handleSSEEventEffect(deps, questionAsked("que-2"));

			const sql = yield* SqlClient.SqlClient;
			const rows = yield* sql<{
				alert_key: string;
			}>`SELECT alert_key FROM sent_alerts WHERE session_id = ${SESSION} ORDER BY alert_key`;
			expect(rows.map((r) => r.alert_key)).toEqual([
				"ask_user:que-1",
				"ask_user:que-2",
			]);
		}),
	);
});

it("preserves distinct question identities even when their details are unavailable", async () => {
	const pushed = await run((p) =>
		Effect.gen(function* () {
			const deps = makeDeps(p);
			for (const id of ["que-1", "que-2", "que-1"]) {
				yield* handleSSEEventEffect(deps, {
					type: "question.asked",
					properties: { id, sessionID: SESSION },
				});
			}
		}),
	);
	expect(pushed).toEqual(["opencode-ask", "opencode-ask"]);
});
