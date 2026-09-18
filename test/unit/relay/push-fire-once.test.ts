// ─── The ding, wired (ni8.23, loop 4b) ──────────────────────────────────────
// `sendPushForEventEffect` is the only push path the live relay uses. These
// tests pin the two halves of the guarantee at the seam where real events
// arrive: the same alert observed twice pushes once, and a push that never
// left the process is never recorded as delivered.
//
// The replay cases are the ones that matter. Three pipelines observe a
// completed turn (SSE, message poller, status-poller safety net) and SSE
// reconnect recovery re-emits every pending question — so "arrived twice" is
// the normal case here, not the pathological one.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
import {
	AlertLedgerLive,
	AlertLedgerTag,
} from "../../../src/lib/domain/relay/Services/alert-ledger.js";
import { PendingInteractionServiceLive } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import type { Logger } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type {
	SSEStreamCallbacks,
	SSEStreamEvents,
} from "../../../src/lib/relay/sse-stream.js";
import {
	sendPushForEventEffect,
	wireSSEConsumerEffect,
} from "../../../src/lib/relay/sse-wiring.js";
import type {
	PushDeliveryReport,
	PushSubscriptionData,
	WebPushModule,
} from "../../../src/lib/server/push.js";
import { PushNotificationManager } from "../../../src/lib/server/push.js";
import {
	PermissionId,
	type RelayMessage,
} from "../../../src/lib/shared-types.js";
import {
	createMockSSEWiringDeps,
	makeMockSessionManagerService,
} from "../../helpers/mock-factories.js";

const silentBus = Layer.succeed(SessionEventBusTag, {
	publish: () => Effect.void,
	publishAdvance: () => Effect.void,
	subscribe: () => Effect.succeed(Stream.empty),
	subscribeAdvances: () => Effect.succeed(Stream.empty),
} satisfies SessionEventBus);

const withStore = <A>(
	body: Effect.Effect<A, unknown, PersistenceEffectContext>,
): Promise<A> => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-push-fire-once-"));
	const layer = makePersistenceEffectLayer(
		join(dir, "events.db"),
		createAllEffectProjectors(),
		silentBus,
	);
	return Effect.runPromise(
		body.pipe(Effect.provide(Layer.merge(layer, silentBus)), Effect.orDie),
	).finally(() => rmSync(dir, { recursive: true, force: true }));
};

const reachedOneDevice: PushDeliveryReport = {
	delivered: ["client-1"],
	expired: [],
	failed: [],
};

/** Records what actually reached the push layer, and what the relay said about it. */
const recorder = () => {
	const pushed: string[] = [];
	const warned: string[] = [];
	const fail = { next: false };
	/** Override the delivery report for the next send only. */
	const reports: PushDeliveryReport[] = [];
	const pushManager = {
		sendToAll: (payload: { type: string; tag: string }) => {
			if (fail.next) {
				fail.next = false;
				return Promise.reject(new Error("push endpoint gone"));
			}
			pushed.push(payload.tag);
			return Promise.resolve(reports.shift() ?? reachedOneDevice);
		},
	};
	const say = (...args: unknown[]) => void warned.push(args.join(" "));
	const log: Logger = {
		debug: say,
		verbose: () => {},
		info: () => {},
		warn: say,
		error: say,
		child: () => log,
	};
	return { pushed, warned, fail, reports, pushManager, log };
};

const seed = (sessionId: string, turnId: string) =>
	Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		yield* commit([
			canonicalEvent(
				"session.created",
				sessionId,
				{ sessionId, title: sessionId, provider: "claude" },
				{ provider: "claude" },
			),
		]);
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			INSERT INTO turns (id, session_id, state, requested_at, completed_at)
			VALUES (${turnId}, ${sessionId}, 'completed', 1000, 1001)`;
	});

const done: RelayMessage = {
	type: "done",
	sessionId: "s1",
	code: 0,
	alertId: "turn-1",
};
const askUser = (toolId: string): RelayMessage => ({
	type: "ask_user",
	sessionId: "s1",
	toolId,
	questions: [],
});
const permission = (requestId: string): RelayMessage => ({
	type: "permission_request",
	sessionId: "s1",
	requestId: PermissionId.make(requestId),
	toolName: "bash",
	toolInput: {},
});

it.each([
	"question",
	"permission",
] as const)("recovery pushes an abandoned pending %s and suppresses delivered replay", async (kind) => {
	const payloads: Array<Record<string, unknown>> = [];
	const deps = createMockSSEWiringDeps({
		pushManager: {
			getPublicKey: () => "pub",
			addSubscription: () => {},
			removeSubscription: () => {},
			sendToAll: async (payload) => {
				payloads.push(payload);
				return reachedOneDevice;
			},
		},
		listPendingQuestions: async () =>
			kind === "question"
				? [
						{
							id: "q1",
							sessionID: "s1",
							questions: [{ question: "Continue?", header: "Approval" }],
						},
					]
				: [],
		listPendingPermissions: async () =>
			kind === "permission"
				? [{ id: "p1", sessionID: "s1", permission: "bash" }]
				: [],
	});
	const {
		processingTimeouts: _timeouts,
		pendingInteractions: _pending,
		sessionService: _sessions,
		getSessionParentMap: _parents,
		getSessionStatuses: _statuses,
		statusPoller: _poller,
		...base
	} = deps;
	const callbacks: {
		[K in keyof SSEStreamCallbacks]: SSEStreamCallbacks[K][];
	} = {
		connected: [],
		disconnected: [],
		reconnecting: [],
		error: [],
		event: [],
		heartbeat: [],
	};
	const consumer: SSEStreamEvents = {
		on: (event, callback) => {
			callbacks[event].push(callback);
		},
	};
	await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			const sql = yield* SqlClient.SqlClient;
			const alertKey = kind === "question" ? "ask_user" : "permission_request";
			const ledgerKey =
				kind === "question" ? "ask_user:q1" : "permission_request:p1";
			const anchor =
				kind === "question" ? "s1:question:q1" : "s1:permission:p1";
			yield* sql`INSERT INTO sent_alerts (session_id, alert_key, anchor, sent_at, state, claim_id)
			VALUES ('s1', ${ledgerKey}, ${anchor}, 1, 'pending', 'dead-process')`;
			yield* wireSSEConsumerEffect(
				{ ...base, providerInstanceId: "opencode" },
				consumer,
			);
			for (const callback of callbacks.connected) callback();
			yield* Effect.tryPromise({
				try: () => vi.waitFor(() => expect(payloads).toHaveLength(1)),
				catch: (cause) => cause,
			});
			expect(payloads[0]).toMatchObject({
				type: alertKey,
				alertId: anchor,
				sessionId: "s1",
				slug: "test-project",
			});
			// Wait for the receipt, then simulate another connection returning stale pending data.
			yield* sql`SELECT state FROM sent_alerts WHERE anchor = ${anchor} AND alert_key = ${ledgerKey}`.pipe(
				Effect.repeat({ until: (rows) => rows[0]?.["state"] === "delivered" }),
				Effect.timeout("1 second"),
			);
			for (const callback of callbacks.connected) callback();
			yield* Effect.sleep("50 millis");
			expect(payloads).toHaveLength(1);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					AlertLedgerLive,
					PendingInteractionServiceLive,
					makeOverridesStateLive(),
					Layer.succeed(
						SessionManagerServiceTag,
						makeMockSessionManagerService(),
					),
				),
			),
		),
	);
});

it.each([
	"HTTP 500",
	"ECONNRESET",
])("recovery pushes the whole batch after a recheck fails with %s", async (reason) => {
	const cause = new Error(reason);
	const questions = ["q1", "q2"].map((id) => ({
		id,
		sessionID: "s1",
		questions: [{ question: "Continue?" }],
	}));
	const listPendingQuestions = vi
		.fn()
		.mockResolvedValueOnce(questions)
		.mockRejectedValueOnce(cause)
		.mockResolvedValue(questions);
	const pushed: string[] = [];
	const deps = createMockSSEWiringDeps({
		listPendingQuestions,
		pushManager: {
			getPublicKey: () => "pub",
			addSubscription: () => {},
			removeSubscription: () => {},
			sendToAll: async (payload) => {
				pushed.push(String(payload["alertId"]));
				return reachedOneDevice;
			},
		},
	});
	const warn = vi.spyOn(deps.log, "warn");
	const {
		processingTimeouts: _timeouts,
		pendingInteractions: _pending,
		sessionService: _sessions,
		getSessionParentMap: _parents,
		getSessionStatuses: _statuses,
		statusPoller: _poller,
		...base
	} = deps;
	const callbacks: {
		[K in keyof SSEStreamCallbacks]: SSEStreamCallbacks[K][];
	} = {
		connected: [],
		disconnected: [],
		reconnecting: [],
		error: [],
		event: [],
		heartbeat: [],
	};
	await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			yield* wireSSEConsumerEffect(
				{ ...base, providerInstanceId: "opencode" },
				{
					on: (event, callback) => {
						callbacks[event].push(callback);
					},
				},
			);
			for (const callback of callbacks.connected) callback();
			yield* Effect.tryPromise({
				try: () =>
					vi.waitFor(() =>
						expect(pushed).toEqual(["s1:question:q1", "s1:question:q2"]),
					),
				catch: (error) => error,
			});
			expect(listPendingQuestions).toHaveBeenCalledTimes(3);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("q1"), cause);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					AlertLedgerLive,
					PendingInteractionServiceLive,
					makeOverridesStateLive(),
					Layer.succeed(
						SessionManagerServiceTag,
						makeMockSessionManagerService(),
					),
				),
			),
		),
	);
});

it("recovery skips a question answered while the preceding push is in flight", async () => {
	let pending = ["q1", "q2"];
	let finishFirst = () => {};
	const firstPush = new Promise<void>((resolve) => {
		finishFirst = resolve;
	});
	const pushed: string[] = [];
	const deps = createMockSSEWiringDeps({
		listPendingQuestions: async () =>
			pending.map((id) => ({
				id,
				sessionID: "s1",
				questions: [{ question: "Continue?" }],
			})),
		pushManager: {
			getPublicKey: () => "pub",
			addSubscription: () => {},
			removeSubscription: () => {},
			sendToAll: async (payload) => {
				pushed.push(String(payload["alertId"]));
				if (pushed.length === 1) await firstPush;
				return reachedOneDevice;
			},
		},
	});
	const {
		processingTimeouts: _timeouts,
		pendingInteractions: _pending,
		sessionService: _sessions,
		getSessionParentMap: _parents,
		getSessionStatuses: _statuses,
		statusPoller: _poller,
		...base
	} = deps;
	const callbacks: {
		[K in keyof SSEStreamCallbacks]: SSEStreamCallbacks[K][];
	} = {
		connected: [],
		disconnected: [],
		reconnecting: [],
		error: [],
		event: [],
		heartbeat: [],
	};
	await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			yield* wireSSEConsumerEffect(
				{ ...base, providerInstanceId: "opencode" },
				{
					on: (event, callback) => {
						callbacks[event].push(callback);
					},
				},
			);
			for (const callback of callbacks.connected) callback();
			yield* Effect.tryPromise(() =>
				vi.waitFor(() => expect(pushed).toHaveLength(1)),
			);
			expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({ toolId: "q2" }),
			);
			// The provider has accepted the other device's answer before Q1 finishes.
			pending = ["q1"];
			finishFirst();
			yield* Effect.sleep("100 millis");
			expect(pushed).toEqual(["s1:question:q1"]);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					AlertLedgerLive,
					PendingInteractionServiceLive,
					makeOverridesStateLive(),
					Layer.succeed(
						SessionManagerServiceTag,
						makeMockSessionManagerService(),
					),
				),
			),
		),
	);
});

it("pushes one ding however many pipelines notice the same completed turn", async () => {
	const r = recorder();
	await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			const send = sendPushForEventEffect(r.pushManager, done, r.log, {
				slug: "proj",
				sessionId: "s1",
			});
			yield* send; // SSE
			yield* send; // message poller
			yield* send; // status-poller safety net
		}).pipe(Effect.provide(AlertLedgerLive)),
	);
	expect(r.pushed).toEqual(["opencode-done"]);
});

it("uses the originating alert identity after the next turn exists", async () => {
	const payloads: Array<Record<string, unknown>> = [];
	const pushManager = {
		sendToAll: async (payload: Record<string, unknown>) => {
			payloads.push(payload);
			return reachedOneDevice;
		},
	};
	await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			const r = recorder();
			yield* sendPushForEventEffect(pushManager, done, r.log, {
				sessionId: "s1",
			});
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO turns (id, session_id, state, requested_at)
			VALUES ('turn-2', 's1', 'running', 2000)`;
			yield* sendPushForEventEffect(pushManager, done, r.log, {
				sessionId: "s1",
			});
			yield* sendPushForEventEffect(
				pushManager,
				{ ...done, alertId: "turn-2" },
				r.log,
				{ sessionId: "s1" },
			);
		}).pipe(Effect.provide(AlertLedgerLive)),
	);
	expect(payloads.map((payload) => payload["alertId"])).toEqual([
		"turn-1",
		"turn-2",
	]);
});

it("does not re-ask a question that reconnect recovery re-emits", async () => {
	const r = recorder();
	await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			yield* sendPushForEventEffect(r.pushManager, askUser("tool-a"), r.log, {
				sessionId: "s1",
			});
			// The SSE stream drops and recoverPendingQuestions replays it.
			yield* sendPushForEventEffect(r.pushManager, askUser("tool-a"), r.log, {
				sessionId: "s1",
			});
			// A genuinely new question in the same turn is a new ding.
			yield* sendPushForEventEffect(r.pushManager, askUser("tool-b"), r.log, {
				sessionId: "s1",
			});
		}).pipe(Effect.provide(AlertLedgerLive)),
	);
	expect(r.pushed).toEqual(["opencode-ask", "opencode-ask"]);
});

it("treats two permission requests as two alerts and one replayed as none", async () => {
	const r = recorder();
	await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			yield* sendPushForEventEffect(r.pushManager, permission("p1"), r.log, {
				sessionId: "s1",
			});
			yield* sendPushForEventEffect(r.pushManager, permission("p2"), r.log, {
				sessionId: "s1",
			});
			yield* sendPushForEventEffect(r.pushManager, permission("p1"), r.log, {
				sessionId: "s1",
			});
		}).pipe(Effect.provide(AlertLedgerLive)),
	);
	// Two live permissions are two alerts, and neither pushes the other out of
	// the ledger — which is what makes reconnect recovery, that re-emits every
	// pending question at once, silent rather than a burst of dings.
	expect(r.pushed).toEqual(["perm-p1", "perm-p2"]);
});

it("does not record a push that failed as delivered", async () => {
	const r = recorder();
	await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			r.fail.next = true;
			yield* sendPushForEventEffect(r.pushManager, done, r.log, {
				sessionId: "s1",
			});
			// The next pipeline to notice the same turn must still get through.
			yield* sendPushForEventEffect(r.pushManager, done, r.log, {
				sessionId: "s1",
			});
		}).pipe(Effect.provide(AlertLedgerLive)),
	);
	expect(r.pushed).toEqual(["opencode-done"]);
	expect(r.warned.join("\n")).toContain("push endpoint gone");
});

it("does not deliver unguarded when the ledger is unwired", async () => {
	const r = recorder();
	await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			yield* sendPushForEventEffect(r.pushManager, done, r.log, {
				sessionId: "s1",
			});
			yield* sendPushForEventEffect(r.pushManager, done, r.log, {
				sessionId: "s1",
			});
		}),
	);
	expect(r.pushed).toEqual([]);
	expect(r.warned.join("\n")).toContain("alert ledger");
});

it("leaves a claim behind the moment the ledger is wired in", async () => {
	const claimed = await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			const r = recorder();
			yield* sendPushForEventEffect(r.pushManager, done, r.log, {
				sessionId: "s1",
			});
			const sql = yield* SqlClient.SqlClient;
			return yield* sql<{
				alert_key: string;
				anchor: string;
			}>`SELECT alert_key, anchor FROM sent_alerts WHERE session_id = 's1'`;
		}).pipe(Effect.provide(AlertLedgerLive)),
	);
	expect(claimed).toEqual([{ alert_key: "done", anchor: "turn-1" }]);
});

it("waits for a working ledger after a storage failure before delivering", async () => {
	const r = recorder();
	await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			const sql = yield* SqlClient.SqlClient;
			yield* sql`CREATE TRIGGER reject_alert_claim BEFORE INSERT ON sent_alerts BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`;
			yield* sendPushForEventEffect(r.pushManager, done, r.log, {
				sessionId: "s1",
			});
			expect(r.pushed).toEqual([]);
			expect(r.warned.join("\n")).toContain("Alert ledger unavailable");
			yield* sql`DROP TRIGGER reject_alert_claim`;
			yield* sendPushForEventEffect(r.pushManager, done, r.log, {
				sessionId: "s1",
			});
			yield* sendPushForEventEffect(r.pushManager, done, r.log, {
				sessionId: "s1",
			});
			expect(r.pushed).toEqual(["opencode-done"]);
		}).pipe(Effect.provide(AlertLedgerLive)),
	);
});

it("is reachable from the tag, so the relay can hand it in", async () => {
	const seen = await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			const ledger = yield* AlertLedgerTag;
			return yield* ledger.deliver(
				{ sessionId: "s1", kind: "done", originId: "turn-1" },
				Effect.void,
			);
		}).pipe(Effect.provide(AlertLedgerLive)),
	);
	expect(seen).toBe(true);
});

// ─── Through the real adapter (ni8.23 delta 1, P1-4) ────────────────────────
// The mock above can be told to reject. The shipped adapter never did: it caught
// every per-device error and resolved, so a 503 and a delivered push were the
// same value. The ledger wrote a claim either way, and the alert was gone.
// These drive the real PushNotificationManager with a stubbed web-push.

const failingWebPush = (
	failFor: (endpoint: string) => unknown | undefined,
): { module: WebPushModule; sent: string[] } => {
	const sent: string[] = [];
	const module: WebPushModule = {
		generateVAPIDKeys: () => ({ publicKey: "pub", privateKey: "priv" }),
		sendNotification: async (subscription: PushSubscriptionData) => {
			const failure = failFor(subscription.endpoint);
			if (failure !== undefined) throw failure;
			sent.push(subscription.endpoint);
			return { statusCode: 201 };
		},
	};
	return { module, sent };
};

const withRealAdapter = async (
	failFor: (endpoint: string) => unknown | undefined,
	endpoints: readonly string[],
	body: (manager: PushNotificationManager, sent: string[]) => Promise<void>,
): Promise<void> => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-push-adapter-"));
	const { module, sent } = failingWebPush(failFor);
	const manager = new PushNotificationManager({
		configDir: dir,
		_webpush: module,
	});
	await manager.init();
	endpoints.forEach((endpoint, i) => {
		manager.addSubscription(`client-${i}`, {
			endpoint,
			keys: { p256dh: "p", auth: "a" },
		});
	});
	try {
		await body(manager, sent);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

it("keeps no claim when the real adapter answers 503 for every device", async () => {
	const failure = Object.assign(new Error("Service Unavailable"), {
		statusCode: 503,
	});
	await withRealAdapter(
		() => failure,
		["https://push.example/a"],
		async (manager, sent) => {
			await withStore(
				Effect.gen(function* () {
					yield* seed("s1", "turn-1");
					const r = recorder();
					yield* sendPushForEventEffect(manager, done, r.log, {
						sessionId: "s1",
					});
					const sql = yield* SqlClient.SqlClient;
					const claims = yield* sql<{
						n: number;
					}>`SELECT COUNT(*) AS n FROM sent_alerts WHERE session_id = 's1'`;
					// Nothing was delivered, so nothing may claim to have been.
					expect(claims[0]?.n).toBe(0);
					expect(sent).toEqual([]);
					expect(r.warned.join("\n")).toContain("reached no device");
				}).pipe(Effect.provide(AlertLedgerLive)),
			);
		},
	);
});

it("retries after a network error and does not re-push the device that already got it", async () => {
	// Retry only the unreachable device once its network recovers.
	const network = new Error("ECONNRESET");
	let deadUnavailable = true;
	await withRealAdapter(
		(endpoint) =>
			endpoint.endsWith("/dead") && deadUnavailable ? network : undefined,
		["https://push.example/live", "https://push.example/dead"],
		async (manager, sent) => {
			await withStore(
				Effect.gen(function* () {
					yield* seed("s1", "turn-1");
					const r = recorder();
					const send = sendPushForEventEffect(manager, done, r.log, {
						sessionId: "s1",
					});
					yield* send;
					deadUnavailable = false;
					yield* send;

					expect(sent).toEqual([
						"https://push.example/live",
						"https://push.example/dead",
					]);
					const sql = yield* SqlClient.SqlClient;
					const claims = yield* sql<{
						n: number;
					}>`SELECT COUNT(*) AS n FROM sent_alerts WHERE session_id = 's1'`;
					expect(claims[0]?.n).toBe(2);
				}).pipe(Effect.provide(AlertLedgerLive)),
			);
		},
	);
});

it("does not claim a ding for a session with no subscribed device", async () => {
	await withRealAdapter(
		() => undefined,
		[],
		async (manager) => {
			await withStore(
				Effect.gen(function* () {
					yield* seed("s1", "turn-1");
					const r = recorder();
					yield* sendPushForEventEffect(manager, done, r.log, {
						sessionId: "s1",
					});
					const sql = yield* SqlClient.SqlClient;
					const claims = yield* sql<{
						n: number;
					}>`SELECT COUNT(*) AS n FROM sent_alerts WHERE session_id = 's1'`;
					expect(claims[0]?.n).toBe(0);
				}).pipe(Effect.provide(AlertLedgerLive)),
			);
		},
	);
});

it("releases the claim when a partial send degrades to reaching nobody", async () => {
	const r = recorder();
	await withStore(
		Effect.gen(function* () {
			yield* seed("s1", "turn-1");
			// The promise resolves — the old adapter's only outcome — but the
			// report says every device refused it.
			r.reports.push({
				delivered: [],
				expired: [],
				failed: [{ clientId: "client-1", cause: "503" }],
			});
			yield* sendPushForEventEffect(r.pushManager, done, r.log, {
				sessionId: "s1",
			});
			yield* sendPushForEventEffect(r.pushManager, done, r.log, {
				sessionId: "s1",
			});
		}).pipe(Effect.provide(AlertLedgerLive)),
	);
	// Two attempts: the first left no claim behind, so the second was allowed.
	expect(r.pushed).toEqual(["opencode-done", "opencode-done"]);
});
