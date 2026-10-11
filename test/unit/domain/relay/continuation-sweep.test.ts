// Failure modes: future or cancelled rows fire; a dismissed/answered cut-off,
// newer user turn, busy/retrying/processing session, changed driver or account
// reaches quota; a cancel, Dismiss, new turn or changed schedule during the probe
// loses to resume; one bad row prevents other due rows from being swept;
// Available/Unknown fails to resume; Unavailable resumes; Limited uses a stale
// reset, omits the five-minute fallback, counts the initial schedule as a re-arm,
// or re-arms more than three times. Replaying the sweep must not dispatch twice.
// Limit-policy failures: auto-resume wins before auto-switch; a refusal/defect
// skips auto-resume; disabled/empty failover switches; an automatic turn bounces
// after service reconstruction or an assistant event; a newer user turn with
// the same timestamp, or a later user/reset continuation, stays blocked;
// the limited account is not excluded or the durable reason is lost.
// A newer turn during failover selection or its gate probe is interrupted by
// stale automation, or a newer reply still permits switching/scheduling.
// Send-at-reset failures: a limited account dispatches an idle/steered input;
// repeated submits replace an existing schedule; missing/expired resets hold;
// a schedule without a cut-off never drains; stale quota re-arms after its reset;
// queued turns overtake the scheduled resume or each other; Edit/Remove bypass
// the hold, a busy session cannot schedule its queued input, a cancellation
// reschedules itself, or releasing the hold overrides a later Stop.
// A pending rewind refuses a future schedule or quota-reset inbox admission;
// permitting either to schedule must never permit an immediate continuation.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { it as effectIt } from "@effect/vitest";
import {
	Context,
	Effect,
	Layer,
	Queue,
	Schedule,
	Stream,
	TestClock,
} from "effect";
import { expect, it } from "vitest";
import type { UsageReading } from "../../../../src/lib/contracts/limit-recovery.js";
import { Usage } from "../../../../src/lib/domain/daemon/Services/usage.js";
import { OpenCodeAPITag } from "../../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../../../../src/lib/domain/relay/Services/agent-service.js";
import { AlertsLive } from "../../../../src/lib/domain/relay/Services/alerts.js";
import {
	ContinuationTag,
	makeContinuation,
} from "../../../../src/lib/domain/relay/Services/continuation.js";
import { ProviderTurnServiceTag } from "../../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../../src/lib/domain/relay/Services/services.js";
import { SessionEventBusLive } from "../../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	decideInbox,
	type InboxView,
	SessionInboxLive,
	SessionInboxTag,
} from "../../../../src/lib/domain/relay/Services/session-inbox.js";
import {
	makeOverridesStateLive,
	startProcessingTimeout,
} from "../../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { OrchestrationEngine } from "../../../../src/lib/provider/orchestration-engine.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../../src/lib/provider/provider-registry.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../../helpers/mock-factories.js";
import { usageReading } from "../../../helpers/usage.js";

const seed = (at = 10) =>
	Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		const sql = yield* SqlClient.SqlClient;
		const store = yield* EventStoreEffectTag;
		const read = yield* ReadQueryEffectTag;
		const continuation = yield* makeContinuation;
		yield* commit([
			canonicalEvent("session.created", "s1", {
				sessionId: "s1",
				title: "Cut off",
				provider: "claude",
			}),
			canonicalEvent("message.created", "s1", {
				sessionId: "s1",
				messageId: "u1",
				role: "user",
			}),
			canonicalEvent("session.usage_limited", "s1", {
				instanceId: "claude",
				rateLimitType: "seven_day",
				cutOffMessageId: "u1",
				resetsAt: 5,
			}),
			canonicalEvent("session.resume_scheduled", "s1", {
				instanceId: "claude",
				at,
			}),
		]);
		return { commit, sql, store, read, continuation };
	});

const config = {
	httpServer: createServer(),
	projectDir: "/tmp",
	slug: "sweep-test",
	configDir: "/tmp/conduit-eon2-no-config",
	persistenceDbPath: ":memory:",
	publishGlobalSetting: () => Effect.void,
};

// Policies can switch; the sweep only resumes the limited account.
const withSwitchServices = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const registry = new ProviderRegistry([
		{
			providerId: "claude",
			steering: false,
			discoverEffect: () => Effect.die("Continuation never discovers"),
			sendTurnEffect: () => Effect.die("Turns use ProviderTurnService"),
			interruptTurnEffect: () => Effect.void,
			resolvePermissionEffect: () => Effect.void,
			resolveQuestionEffect: () => Effect.void,
			endSessionEffect: () => Effect.void,
			shutdownEffect: () => Effect.void,
		},
	]);
	return effect.pipe(
		Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
		Effect.provideService(LoggerTag, makeMockLogger()),
		Effect.provideService(
			OrchestrationEngineTag,
			new OrchestrationEngine({
				registry,
				resolveProviderDriver: () => "claude",
			}),
		),
		Effect.provideService(ProviderRegistryTag, registry),
		Effect.provideService(AgentServiceTag, {
			getActiveAgent: () => Effect.succeed(undefined),
			listAgents: () => Effect.die("The sweep never switches agents"),
			switchAgent: () => Effect.die("The sweep never switches agents"),
		}),
		Effect.provide(AlertsLive),
	);
};

for (const delivery of ["queue", "steer"] as const) {
	it(`the usage hold admits ${delivery} inputs and blocks Drain but not SendNow`, () => {
		const request = { text: "wait", modelUserSelected: false };
		const view: InboxView = {
			provider: "claude",
			queued: [],
			steering: false,
			busy: false,
			stoppedSinceHandoff: false,
			limited: false,
			usageResetsAt: 10,
			scheduled: false,
			known: false,
			providerSteers: true,
			promptOpen: false,
			running: undefined,
		};
		const submitted = decideInbox("s1", view, {
			_tag: "Submit",
			inputId: "q1",
			delivery,
			request,
		});
		expect(submitted).toEqual({
			_tag: "Accepted",
			events: [
				{
					type: "input.admitted",
					data: { sessionId: "s1", inputId: "q1", delivery, request },
				},
			],
		});
		const queued = { ...view, queued: [{ inputId: "q1", request }] };
		expect(decideInbox("s1", queued, { _tag: "Drain" })).toEqual({
			_tag: "Accepted",
			events: [],
		});
		// Send now / Resume is the user's explicit call, so the hold yields to it.
		expect(
			decideInbox("s1", queued, { _tag: "SendNow", inputId: "q1" }),
		).toMatchObject({ handoff: { inputId: "q1" } });
		expect(
			decideInbox("s1", queued, { _tag: "Cancel", inputId: "q1" }),
		).toEqual({
			_tag: "Accepted",
			events: [
				{ type: "input.cancelled", data: { sessionId: "s1", inputId: "q1" } },
			],
		});
	});
}

const resetInboxFixture = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	const store = yield* EventStoreEffectTag;
	const read = yield* ReadQueryEffectTag;
	const sql = yield* SqlClient.SqlClient;
	const continuation = yield* makeContinuation;
	const sent = yield* Queue.unbounded<string>();
	const dispatches: string[] = [];
	const turns: ProviderTurnServiceTag["Type"] = {
		holdUserTurnsForAccountSwitch: () => Effect.void,
		prepareTurnSession: (input) => Effect.succeed(input.sessionId),
		interruptTurn: () => Effect.void,
		sendTurn: (input) =>
			Effect.gen(function* () {
				dispatches.push(input.continuation ? "resume" : input.text);
				yield* commit([
					...(input.events ?? []),
					...(input.continuation
						? []
						: [
								canonicalEvent("message.created", input.sessionId, {
									sessionId: input.sessionId,
									messageId: input.commandId,
									inputId: input.commandId,
									role: "user",
								}),
							]),
					canonicalEvent("session.status", input.sessionId, {
						sessionId: input.sessionId,
						status: "busy",
					}),
				]);
				yield* Queue.offer(sent, input.continuation ? "resume" : input.text);
			}).pipe(Effect.orDie),
	};
	const inboxContext = yield* Layer.build(SessionInboxLive).pipe(
		Effect.provideService(ContinuationTag, continuation),
		Effect.provideService(ProviderTurnServiceTag, turns),
	);
	const inbox = Context.get(inboxContext, SessionInboxTag);
	yield* commit([
		canonicalEvent("session.created", "s1", {
			sessionId: "s1",
			title: "Send at reset",
			provider: "claude",
		}),
	]);
	return {
		inbox,
		continuation,
		commit,
		store,
		read,
		sql,
		turns,
		dispatches,
		next: Queue.take(sent),
		sweep: continuation
			.sweepDueContinuations(10)
			.pipe(Effect.provideService(ProviderTurnServiceTag, turns)),
		submit: (inputId: string) =>
			inbox.submit({
				clientId: "c1",
				sessionId: "s1",
				inputId,
				delivery: "queue",
				request: { text: inputId, modelUserSelected: false },
			}),
		finish: (inputId: string) =>
			commit([
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: `a-${inputId}`,
					parentID: inputId,
					role: "assistant",
				}),
				canonicalEvent("turn.completed", "s1", { messageId: `a-${inputId}` }),
				canonicalEvent("session.status", "s1", {
					sessionId: "s1",
					status: "idle",
				}),
			]),
	};
});

const withResetInbox = <A, E, R>(
	reading: () => UsageReading,
	use: (
		fixture: Effect.Effect.Success<typeof resetInboxFixture>,
	) => Effect.Effect<A, E, R>,
) =>
	Effect.flatMap(resetInboxFixture, use).pipe(
		Effect.provideService(ConfigTag, config),
		Effect.provideService(Usage, {
			readings: Stream.empty,
			latest: () => Effect.sync(reading),
			refresh: () => Effect.sync(() => [reading()]),
			turnEnded: () => Effect.void,
			pickFailover: () => Effect.succeed(undefined),
		}),
		withSwitchServices,
		Effect.provide(makeOverridesStateLive()),
		Effect.provide(
			Layer.merge(
				makePersistenceEffectLayer(
					":memory:",
					"test-project",
					undefined,
					SessionEventBusLive,
				),
				SessionEventBusLive,
			),
		),
	);

for (const admission of ["user", "quota-reset"] as const) {
	effectIt.scoped(
		`pending rewind allows ${admission} scheduling and blocks continuation dispatch`,
		() =>
			withResetInbox(
				() =>
					usageReading("claude", {
						status: "limited",
						windows: [
							{
								kind: "five_hour",
								utilization: 100,
								resetsAt: new Date(10_000).toISOString(),
							},
						],
					}),
				(fixture) =>
					Effect.gen(function* () {
						yield* TestClock.setTime(1_000);
						yield* fixture.commit([
							canonicalEvent("message.created", "s1", {
								sessionId: "s1",
								messageId: "cut",
								role: "user",
							}),
							canonicalEvent("session.rewound", "s1", { messageId: "cut" }),
						]);
						const scheduled = yield* (
							admission === "user"
								? fixture.continuation
										.requestContinuation("s1", {
											instanceId: "claude",
											expectedInstanceId: "claude",
											reason: "user",
											at: 10,
										})
										.pipe(
											Effect.provideService(
												ProviderTurnServiceTag,
												fixture.turns,
											),
										)
								: fixture.submit("q1")
						).pipe(Effect.either);
						expect(scheduled).toMatchObject({ _tag: "Right" });
						expect(
							(yield* fixture.read.listSessionInfos())[0]?.limitRecovery
								?.scheduledAt,
						).toBe(10);
						expect(
							(yield* fixture.read.getSession("s1"))?.pending_rewind_message_id,
						).toBe("cut");
						expect(fixture.dispatches).toEqual([]);
						const before = yield* fixture.store.readAllBySession("s1");
						const immediate = yield* fixture.continuation
							.requestContinuation("s1", {
								instanceId: "claude",
								expectedInstanceId: "claude",
								reason: "user",
							})
							.pipe(
								Effect.provideService(ProviderTurnServiceTag, fixture.turns),
								Effect.either,
							);
						expect(immediate).toMatchObject({
							_tag: "Left",
							left: { _tag: "SessionBusy" },
						});
						expect(yield* fixture.store.readAllBySession("s1")).toEqual(before);
						expect(fixture.dispatches).toEqual([]);
					}),
			),
	);
}

for (const schedule of [
	"none",
	"existing",
	"cut-off",
	"cut-off-stale",
	"busy",
	"stopped",
	"model-window",
	"cancelled",
	"later-stopped",
] as const) {
	effectIt.scoped(
		`send at reset: ${schedule} schedules once and releases in turn order`,
		() => {
			let reading = usageReading("claude", {
				status: "limited",
				windows: [
					{
						kind: "five_hour",
						utilization: 100,
						resetsAt: new Date(10_000).toISOString(),
					},
				],
			});
			if (schedule === "model-window")
				reading = {
					...reading,
					windows: [
						...reading.windows,
						{
							kind: "seven_day_model",
							model: "opus",
							utilization: 100,
							resetsAt: new Date(20_000).toISOString(),
						},
					],
				};
			return withResetInbox(
				() => reading,
				(fixture) =>
					Effect.gen(function* () {
						const cutOff =
							schedule === "cut-off" || schedule === "cut-off-stale";
						yield* TestClock.setTime(1_000);
						if (cutOff)
							yield* fixture.commit([
								canonicalEvent("message.created", "s1", {
									sessionId: "s1",
									messageId: "u1",
									role: "user",
								}),
								canonicalEvent("session.usage_limited", "s1", {
									instanceId: "claude",
									rateLimitType: "five_hour",
									cutOffMessageId: "u1",
									resetsAt: 10,
								}),
							]);
						if (schedule === "existing" || cutOff)
							yield* fixture.commit([
								canonicalEvent("session.resume_scheduled", "s1", {
									instanceId: "claude",
									at: 10,
								}),
							]);
						if (schedule === "busy")
							yield* fixture.commit([
								canonicalEvent("session.status", "s1", {
									sessionId: "s1",
									status: "busy",
								}),
							]);
						if (schedule === "stopped")
							yield* fixture.commit([
								canonicalEvent("message.created", "s1", {
									sessionId: "s1",
									messageId: "u0",
									role: "user",
								}),
								canonicalEvent("message.created", "s1", {
									sessionId: "s1",
									messageId: "a0",
									parentID: "u0",
									role: "assistant",
								}),
								canonicalEvent("turn.interrupted", "s1", { messageId: "a0" }),
							]);
						yield* fixture.inbox.start;
						expect(yield* fixture.submit("q1")).toEqual({ handedOff: false });
						expect(yield* fixture.submit("q2")).toEqual({ handedOff: false });
						expect(yield* fixture.submit("q1")).toEqual({ handedOff: false });
						expect(fixture.dispatches).toEqual([]);
						expect(
							(yield* fixture.store.readAllBySession("s1")).filter(
								(event) => event.type === "session.resume_scheduled",
							),
						).toHaveLength(1);
						expect(
							(yield* fixture.read.listSessionInfos())[0]?.limitRecovery
								?.scheduledAt,
						).toBe(10);
						expect(
							yield* fixture.sql<{
								input_id: string;
							}>`SELECT input_id FROM pending_inputs WHERE state = 'queued' ORDER BY admitted_at, rowid`,
						).toEqual([{ input_id: "q1" }, { input_id: "q2" }]);
						if (schedule === "cancelled") {
							yield* fixture.continuation.cancelContinuation("s1");
							yield* Effect.yieldNow().pipe(Effect.repeat(Schedule.recurs(10)));
							expect(
								(yield* fixture.store.readAllBySession("s1")).filter(
									(event) => event.type === "session.resume_scheduled",
								),
							).toHaveLength(1);
							expect(fixture.dispatches).toEqual([]);
							return;
						}
						if (schedule === "later-stopped")
							yield* fixture.commit([
								canonicalEvent("message.created", "s1", {
									sessionId: "s1",
									messageId: "u0",
									role: "user",
								}),
								canonicalEvent("message.created", "s1", {
									sessionId: "s1",
									messageId: "a0",
									parentID: "u0",
									role: "assistant",
								}),
								canonicalEvent("turn.interrupted", "s1", { messageId: "a0" }),
							]);
						yield* TestClock.setTime(10_000);
						if (schedule === "cut-off")
							reading = usageReading("claude", { status: "available" });
						if (schedule === "busy")
							yield* fixture.commit([
								canonicalEvent("session.status", "s1", {
									sessionId: "s1",
									status: "idle",
								}),
							]);
						yield* fixture.sweep;
						if (schedule === "later-stopped") {
							yield* Effect.yieldNow().pipe(Effect.repeat(Schedule.recurs(10)));
							expect(fixture.dispatches).toEqual([]);
							return;
						}
						if (cutOff) {
							expect(fixture.dispatches).toEqual(["resume"]);
							expect(yield* fixture.next).toBe("resume");
							yield* fixture.finish("u1");
						} else
							expect(
								(yield* fixture.read.listSessionInfos())[0]?.limitRecovery,
							).toBeNull();
						expect(yield* fixture.next).toBe("q1");
						expect(fixture.dispatches).toEqual(
							cutOff ? ["resume", "q1"] : ["q1"],
						);
						yield* fixture.finish("q1");
						expect(yield* fixture.next).toBe("q2");
						expect(fixture.dispatches).toEqual(
							cutOff ? ["resume", "q1", "q2"] : ["q1", "q2"],
						);
					}),
			);
		},
	);
}

for (const reset of ["expired", "missing", "invalid"] as const) {
	effectIt.scoped(`send at reset: a ${reset} reset holds nothing`, () =>
		withResetInbox(
			() =>
				usageReading("claude", {
					status: "limited",
					windows: [
						{
							kind: "five_hour",
							utilization: 100,
							...(reset === "missing"
								? {}
								: {
										resetsAt:
											reset === "expired"
												? new Date(1_000).toISOString()
												: "bad-time",
									}),
						},
					],
				}),
			(fixture) =>
				Effect.gen(function* () {
					yield* TestClock.setTime(1_000);
					expect(yield* fixture.submit("q1")).toEqual({ handedOff: true });
					expect(fixture.dispatches).toEqual(["q1"]);
					expect(
						(yield* fixture.store.readAllBySession("s1")).filter(
							(event) => event.type === "session.resume_scheduled",
						),
					).toHaveLength(0);
				}),
		),
	);
}

for (const scenario of [
	"future",
	"cancelled",
	"dismissed",
	"answered",
	"continued",
	"newer-turn",
	"busy",
	"retry",
	"processing",
	"driver",
	"account",
	"limit-account",
	"unavailable",
	"cancel-during-probe",
	"dismiss-during-probe",
	"turn-during-probe",
	"busy-during-probe",
	"account-during-probe",
	"rescheduled-during-probe",
	"available",
	"unknown",
] as const) {
	it(`due-row gate: ${scenario}`, async () => {
		let probes = 0;
		let dispatches = 0;
		await Effect.runPromise(
			Effect.gen(function* () {
				const { commit, sql, store, read, continuation } = yield* seed(
					scenario === "future" ? 11 : 10,
				);
				const newerTurn = commit([
					canonicalEvent("message.created", "s1", {
						sessionId: "s1",
						messageId: "u2",
						role: "user",
					}),
				]);
				switch (scenario) {
					case "cancelled":
						yield* continuation.cancelContinuation("s1");
						break;
					case "dismissed":
						yield* sql`UPDATE sessions SET limit_recovery = json_remove(limit_recovery, '$.cutOffMessageId') WHERE id = 's1'`;
						break;
					case "answered":
						yield* commit([
							canonicalEvent("message.created", "s1", {
								sessionId: "s1",
								messageId: "a1",
								role: "assistant",
							}),
						]);
						break;
					case "continued":
						yield* sql`UPDATE sessions SET limit_recovery = json_set(limit_recovery, '$.continued', json('true')) WHERE id = 's1'`;
						break;
					case "newer-turn":
						yield* newerTurn;
						break;
					case "busy":
					case "retry":
						yield* sql`UPDATE sessions SET status = ${scenario} WHERE id = 's1'`;
						break;
					case "processing":
						yield* startProcessingTimeout("s1", "1 minute", () => Effect.void);
						break;
					case "driver":
						yield* sql`UPDATE sessions SET provider = 'opencode' WHERE id = 's1'`;
						break;
					case "account":
						yield* sql`UPDATE sessions SET provider = 'other' WHERE id = 's1'`;
						break;
					case "limit-account":
						yield* sql`UPDATE sessions SET limit_recovery = json_set(limit_recovery, '$.instanceId', 'other') WHERE id = 's1'`;
						break;
				}
				const before = yield* store.readAllBySession("s1");
				yield* continuation.sweepDueContinuations(10).pipe(
					Effect.provideService(Usage, {
						readings: Stream.empty,
						latest: () => Effect.succeed(undefined),
						turnEnded: () => Effect.void,
						refresh: () =>
							Effect.gen(function* () {
								probes++;
								switch (scenario) {
									case "cancel-during-probe":
										yield* continuation.cancelContinuation("s1");
										break;
									case "dismiss-during-probe":
										yield* continuation.dismissCutOff("s1");
										break;
									case "turn-during-probe":
										yield* newerTurn;
										break;
									case "busy-during-probe":
										yield* sql`UPDATE sessions SET status = 'busy' WHERE id = 's1'`;
										break;
									case "account-during-probe":
										yield* sql`UPDATE sessions SET provider = 'other' WHERE id = 's1'`;
										break;
									case "rescheduled-during-probe":
										yield* commit([
											canonicalEvent("session.resume_scheduled", "s1", {
												instanceId: "claude",
												at: 20,
											}),
										]);
										break;
								}
								return scenario === "unavailable"
									? [
											usageReading("claude", {
												status: "unavailable",
												reason: "Not logged in",
											}),
										]
									: scenario === "available"
										? [usageReading("claude", { status: "available" })]
										: [usageReading("claude")];
							}).pipe(Effect.orDie),
						pickFailover: () => Effect.succeed(undefined),
					}),
				);
				const resumes = scenario === "available" || scenario === "unknown";
				const probed =
					resumes ||
					scenario === "unavailable" ||
					scenario.endsWith("during-probe");
				expect(probes).toBe(probed ? 1 : 0);
				expect(dispatches).toBe(resumes ? 1 : 0);
				const recovery = (yield* read.listSessionInfos())[0]?.limitRecovery;
				if (scenario === "future" || scenario === "rescheduled-during-probe")
					expect(recovery?.scheduledAt).toBe(scenario === "future" ? 11 : 20);
				else expect(recovery?.scheduledAt).toBeUndefined();
				const events = (yield* store.readAllBySession("s1")).slice(
					before.length,
				);
				if (
					scenario === "future" ||
					scenario === "cancelled" ||
					scenario === "answered"
				)
					expect(events).toEqual([]);
				else if (resumes)
					expect(events.map((event) => [event.type, event.data])).toEqual([
						["session.resumed", { reason: "reset", instanceId: "claude" }],
					]);
				else if (scenario !== "rescheduled-during-probe")
					expect(
						events.filter((event) => event.type === "session.resume_cancelled"),
					).toHaveLength(1);
				if (resumes) {
					yield* continuation.sweepDueContinuations(10);
					expect(dispatches).toBe(1);
				}
			}).pipe(
				Effect.provideService(ConfigTag, config),
				Effect.provideService(Usage, {
					readings: Stream.empty,
					latest: () => Effect.succeed(undefined),
					turnEnded: () => Effect.void,
					refresh: () => Effect.succeed([usageReading("claude")]),
					pickFailover: () => Effect.succeed(undefined),
				}),
				Effect.provideService(ProviderTurnServiceTag, {
					holdUserTurnsForAccountSwitch: () => Effect.void,
					prepareTurnSession: (input) => Effect.succeed(input.sessionId),
					sendTurn: () =>
						Effect.sync(() => {
							dispatches++;
						}),
					interruptTurn: () => Effect.void,
				}),
				withSwitchServices,
				Effect.provide(makeOverridesStateLive()),
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
	});
}

for (const scenario of [
	"switch-first",
	"off",
	"no-target",
	"unavailable",
	"defect",
	"stale-during-probe",
	"turn-during-pick",
	"turn-during-probe",
	"reply-during-probe",
	"auto-turn",
	"assistant-after-auto",
	"new-user",
	"user-after-auto",
	"reset-after-auto",
] as const) {
	it(`limit policy: ${scenario}`, async () => {
		const configDir = mkdtempSync(join(tmpdir(), "conduit-limit-policy-"));
		writeFileSync(
			join(configDir, "daemon.json"),
			JSON.stringify({
				pid: process.pid,
				port: 0,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				projects: [],
				instances: [
					{
						id: "target",
						name: "Target",
						driver: "claude",
						port: 0,
						managed: false,
					},
				],
				usageLimits: {
					autoSwitch: scenario !== "off",
					autoResume: true,
					warnAt: 80,
					order: ["target"],
				},
			}),
		);
		const picked: string[] = [];
		const probed: string[] = [];
		const dispatched: string[] = [];
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const {
						commit,
						sql,
						store,
						read,
						continuation: initial,
					} = yield* seed();
					yield* initial.cancelContinuation("s1");
					const newerTurn = commit([
						canonicalEvent("message.created", "s1", {
							sessionId: "s1",
							messageId: "u2",
							role: "user",
						}),
					]).pipe(
						Effect.andThen(
							sql`UPDATE sessions SET status = 'busy' WHERE id = 's1'`,
						),
					);
					if (
						[
							"auto-turn",
							"assistant-after-auto",
							"new-user",
							"user-after-auto",
							"reset-after-auto",
						].includes(scenario)
					) {
						yield* commit([
							canonicalEvent(
								"session.resumed",
								"s1",
								{
									instanceId: "claude",
									reason: "auto-switch",
								},
								{ createdAt: 1000 },
							),
						]);
						if (scenario === "new-user" || scenario === "assistant-after-auto")
							yield* commit([
								canonicalEvent(
									"message.created",
									"s1",
									{
										sessionId: "s1",
										messageId: "u2",
										role: scenario === "new-user" ? "user" : "assistant",
									},
									{ createdAt: 1000 },
								),
							]);
						if (
							scenario === "user-after-auto" ||
							scenario === "reset-after-auto"
						)
							yield* commit([
								canonicalEvent(
									"session.resumed",
									"s1",
									{
										instanceId: "claude",
										reason: scenario === "user-after-auto" ? "user" : "reset",
									},
									{ createdAt: 1000 },
								),
							]);
						yield* commit([
							canonicalEvent("session.usage_limited", "s1", {
								instanceId: "claude",
								rateLimitType: "seven_day",
								resetsAt: 5,
								cutOffMessageId: scenario === "new-user" ? "u2" : "u1",
							}),
						]);
					}
					// A fresh owner must derive the once-per-turn rule from persisted events.
					const continuation = yield* makeContinuation;
					yield* commit([
						canonicalEvent("session.created", "barrier", {
							sessionId: "barrier",
							title: "Barrier",
							provider: "target",
						}),
						canonicalEvent("message.created", "barrier", {
							sessionId: "barrier",
							messageId: "b1",
							role: "user",
						}),
						canonicalEvent("session.usage_limited", "barrier", {
							instanceId: "target",
							rateLimitType: "seven_day",
							resetsAt: 900,
							cutOffMessageId: "b1",
						}),
					]);
					const before = (yield* store.readAllBySession("s1")).length;
					yield* Effect.forkScoped(
						continuation.runLimitPolicies.pipe(
							Effect.provideService(Usage, {
								pickFailover: (excluding) =>
									Effect.gen(function* () {
										picked.push(excluding);
										if (
											excluding === "claude" &&
											scenario === "turn-during-pick"
										)
											yield* newerTurn;
										return excluding === "claude" && scenario !== "no-target"
											? "target"
											: undefined;
									}).pipe(Effect.orDie),
								readings: Stream.empty,
								latest: () => Effect.succeed(undefined),
								turnEnded: () => Effect.void,
								refresh: (accountIds) =>
									Effect.gen(function* () {
										const instanceId = accountIds?.[0] ?? "claude";
										probed.push(instanceId);
										if (scenario === "defect")
											return yield* Effect.die("Probe defect");
										if (
											scenario === "turn-during-probe" ||
											scenario === "reply-during-probe"
										)
											yield* newerTurn;
										if (scenario === "reply-during-probe")
											yield* commit([
												canonicalEvent("message.created", "s1", {
													sessionId: "s1",
													messageId: "a2",
													role: "assistant",
												}),
											]);
										if (scenario === "stale-during-probe")
											yield* commit([
												canonicalEvent("session.provider_changed", "s1", {
													sessionId: "s1",
													oldProvider: "claude",
													newProvider: "target",
													reason: "user",
												}),
												canonicalEvent("session.usage_limited", "s1", {
													instanceId: "target",
													rateLimitType: "seven_day",
													resetsAt: 5,
													cutOffMessageId: "u1",
												}),
											]);
										return scenario === "unavailable"
											? [
													usageReading(instanceId, {
														status: "unavailable",
														reason: "Not logged in",
													}),
												]
											: [usageReading(instanceId)];
									}).pipe(Effect.orDie),
							}),
						),
					);
					yield* continuation.queueLimitPolicy("s1");
					yield* continuation.queueLimitPolicy("barrier");
					// The later row's schedule proves the earlier policy has finished,
					// including paths that intentionally make no switch or dispatch.
					yield* read.listSessionInfos().pipe(
						Effect.repeat({
							schedule: Schedule.spaced("5 millis"),
							until: (rows) =>
								rows.find((row) => row.id === "barrier")?.limitRecovery
									?.scheduledAt === 900,
						}),
						Effect.timeout("2 seconds"),
					);
					const switched = [
						"switch-first",
						"new-user",
						"user-after-auto",
						"reset-after-auto",
					].includes(scenario);
					const skipped = ["off", "auto-turn", "assistant-after-auto"].includes(
						scenario,
					);
					expect(picked).toEqual(
						scenario === "off"
							? []
							: skipped
								? ["target"]
								: ["claude", "target"],
					);
					expect(probed).toEqual(
						skipped ||
							scenario === "no-target" ||
							scenario === "turn-during-pick"
							? []
							: ["target"],
					);
					expect(dispatched).toEqual(switched ? ["s1"] : []);
					const session = (yield* read.listSessionInfos()).find(
						(row) => row.id === "s1",
					);
					expect((yield* read.getSession("s1"))?.provider).toBe(
						switched || scenario === "stale-during-probe" ? "target" : "claude",
					);
					expect(session?.limitRecovery?.scheduledAt).toBe(
						switched ||
							scenario === "turn-during-pick" ||
							scenario === "turn-during-probe" ||
							scenario === "reply-during-probe"
							? undefined
							: 5,
					);
					expect(session?.limitRecovery?.continued).toBe(
						scenario === "reply-during-probe" ? undefined : switched,
					);
					const events = (yield* store.readAllBySession("s1")).slice(before);
					expect(
						events
							.filter((event) => event.type === "session.resumed")
							.map((event) => event.data),
					).toEqual(
						switched
							? [
									{
										instanceId: "target",
										reason: "auto-switch",
										from: "claude",
									},
								]
							: [],
					);
					if (switched) {
						expect(events.map((event) => event.type)).toEqual([
							"session.provider_changed",
							"session.resumed",
						]);
						expect(session?.resumes?.at(-1)).toMatchObject({
							instanceId: "target",
							reason: "auto-switch",
						});
					}
				}).pipe(
					Effect.scoped,
					Effect.provideService(ConfigTag, { ...config, configDir }),
					Effect.provideService(ProviderTurnServiceTag, {
						holdUserTurnsForAccountSwitch: () => Effect.void,
						prepareTurnSession: (input) => Effect.succeed(input.sessionId),
						sendTurn: (input) =>
							Effect.sync(() => {
								dispatched.push(input.sessionId);
							}),
						interruptTurn: () => Effect.void,
					}),
					withSwitchServices,
					Effect.provide(makeOverridesStateLive()),
					Effect.provide(
						makePersistenceEffectLayer(":memory:", "test-project"),
					),
				),
			);
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	});
}

it("a cancelled invalid due row does not prevent another due row from resuming", async () => {
	const dispatched: string[] = [];
	await Effect.runPromise(
		Effect.gen(function* () {
			const { commit, sql, read, continuation } = yield* seed();
			yield* sql`UPDATE sessions SET status = 'busy' WHERE id = 's1'`;
			yield* commit([
				canonicalEvent("session.created", "s2", {
					sessionId: "s2",
					title: "Another cut-off",
					provider: "claude",
				}),
				canonicalEvent("message.created", "s2", {
					sessionId: "s2",
					messageId: "u2",
					role: "user",
				}),
				canonicalEvent("session.usage_limited", "s2", {
					instanceId: "claude",
					rateLimitType: "seven_day",
					cutOffMessageId: "u2",
				}),
				canonicalEvent("session.resume_scheduled", "s2", {
					instanceId: "claude",
					at: 10,
				}),
			]);
			yield* continuation.sweepDueContinuations(10);
			expect(dispatched).toEqual(["s2"]);
			expect(
				(yield* read.listSessionInfos()).every(
					(session) => session.limitRecovery?.scheduledAt === undefined,
				),
			).toBe(true);
		}).pipe(
			Effect.provideService(ConfigTag, config),
			Effect.provideService(Usage, {
				readings: Stream.empty,
				latest: () => Effect.succeed(undefined),
				turnEnded: () => Effect.void,
				refresh: () => Effect.succeed([usageReading("claude")]),
				pickFailover: () => Effect.succeed(undefined),
			}),
			Effect.provideService(ProviderTurnServiceTag, {
				holdUserTurnsForAccountSwitch: () => Effect.void,
				prepareTurnSession: (input) => Effect.succeed(input.sessionId),
				sendTurn: (input) =>
					Effect.sync(() => {
						dispatched.push(input.sessionId);
					}),
				interruptTurn: () => Effect.void,
			}),
			withSwitchServices,
			Effect.provide(makeOverridesStateLive()),
			Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
		),
	);
});

for (const freshReset of [42, undefined]) {
	it(`Limited re-arms three times using ${freshReset === undefined ? "a five-minute fallback" : "the fresh reset"}, then cancels`, async () => {
		let probes = 0;
		await Effect.runPromise(
			Effect.gen(function* () {
				const { store, read, continuation } = yield* seed();
				expect((yield* read.listSessionInfos())[0]?.limitRecovery?.rearms).toBe(
					0,
				);
				let now = 10;
				for (let rearms = 1; rearms <= 3; rearms++) {
					yield* continuation.sweepDueContinuations(now);
					const scheduledAt =
						freshReset === undefined ? now + 300 : freshReset * rearms;
					expect(
						(yield* read.listSessionInfos())[0]?.limitRecovery,
					).toMatchObject({
						cutOffMessageId: "u1",
						continued: false,
						rearms,
						scheduledAt,
					});
					now = scheduledAt;
				}
				yield* continuation.sweepDueContinuations(now);
				const recovery = (yield* read.listSessionInfos())[0]?.limitRecovery;
				expect(recovery).toMatchObject({
					cutOffMessageId: "u1",
					rearms: 3,
					continued: false,
				});
				expect(recovery?.scheduledAt).toBeUndefined();
				expect(
					(yield* store.readAllBySession("s1"))
						.map((event) => event.type)
						.slice(4),
				).toEqual([
					"session.resume_scheduled",
					"session.resume_scheduled",
					"session.resume_scheduled",
					"session.resume_cancelled",
				]);
				yield* continuation.sweepDueContinuations(now + 1000);
				expect(probes).toBe(4);
			}).pipe(
				Effect.provideService(ConfigTag, config),
				Effect.provideService(Usage, {
					readings: Stream.empty,
					latest: () => Effect.succeed(undefined),
					turnEnded: () => Effect.void,
					refresh: () =>
						Effect.sync(() => {
							probes++;
							return [
								usageReading("claude", {
									status: "limited",
									windows: [
										{
											kind: "seven_day",
											utilization: 100,
											...(freshReset === undefined
												? {}
												: {
														// Each fresh probe sees another future reset, not an expired one.
														resetsAt: new Date(
															freshReset * probes * 1000,
														).toISOString(),
													}),
										},
									],
								}),
							];
						}),
					pickFailover: () => Effect.succeed(undefined),
				}),
				Effect.provideService(ProviderTurnServiceTag, {
					holdUserTurnsForAccountSwitch: () => Effect.void,
					prepareTurnSession: (input) => Effect.succeed(input.sessionId),
					sendTurn: () => Effect.die("Limited must never dispatch"),
					interruptTurn: () => Effect.void,
				}),
				withSwitchServices,
				Effect.provide(makeOverridesStateLive()),
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
	});
}
