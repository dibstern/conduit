// Failure modes: future or cancelled rows fire; a dismissed/answered cut-off,
// newer user turn, busy/retrying/processing session, changed driver or account
// reaches quota; a cancel, Dismiss, new turn or changed schedule during the probe
// loses to resume; one bad row prevents other due rows from being swept;
// Available/Unknown fails to resume; Unavailable resumes; Limited uses a stale
// reset, omits the five-minute fallback, counts the initial schedule as a re-arm,
// or re-arms more than three times. Replaying the sweep must not dispatch twice.
import { createServer } from "node:http";
import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { QuotaCheckTag } from "../../../../src/lib/domain/daemon/Services/quota-check.js";
import { OpenCodeAPITag } from "../../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../../../../src/lib/domain/relay/Services/agent-service.js";
import { AlertsLive } from "../../../../src/lib/domain/relay/Services/alerts.js";
import { makeContinuation } from "../../../../src/lib/domain/relay/Services/continuation.js";
import { ProviderTurnServiceTag } from "../../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../../src/lib/domain/relay/Services/services.js";
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

// An account switch needs these; the sweep only resumes the limited account.
const withSwitchServices = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
	const registry = new ProviderRegistry();
	return effect.pipe(
		Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
		Effect.provideService(LoggerTag, makeMockLogger()),
		Effect.provideService(
			OrchestrationEngineTag,
			new OrchestrationEngine({ registry }),
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
					Effect.provideService(QuotaCheckTag, {
						check: () =>
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
									? { _tag: "Unavailable" as const, reason: "Not logged in" }
									: scenario === "available"
										? { _tag: "Available" as const }
										: { _tag: "Unknown" as const };
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
				Effect.provideService(QuotaCheckTag, {
					check: () => Effect.succeed({ _tag: "Unknown" }),
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
				Effect.provide(makePersistenceEffectLayer(":memory:")),
			),
		);
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
			Effect.provideService(QuotaCheckTag, {
				check: () => Effect.succeed({ _tag: "Unknown" }),
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
			Effect.provide(makePersistenceEffectLayer(":memory:")),
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
					const scheduledAt = freshReset ?? now + 300;
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
				Effect.provideService(QuotaCheckTag, {
					check: () =>
						Effect.sync(() => {
							probes++;
							return {
								_tag: "Limited" as const,
								rateLimitType: "seven_day",
								...(freshReset === undefined ? {} : { resetsAt: freshReset }),
							};
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
				Effect.provide(makePersistenceEffectLayer(":memory:")),
			),
		);
	});
}
