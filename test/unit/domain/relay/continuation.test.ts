// Failure modes: a driver mismatch reaches the quota probe; stale selection
// loses to busy/quota; a busy session probes or appends; a fresh refusal writes
// recovery/events; a session moves or starts a turn while the probe is pending.
// All refusals must leave the event stream untouched and never dispatch a turn.
import { createServer } from "node:http";
import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { QuotaCheckTag } from "../../../../src/lib/domain/daemon/Services/quota-check.js";
import { makeContinuation } from "../../../../src/lib/domain/relay/Services/continuation.js";
import { ProviderTurnServiceTag } from "../../../../src/lib/domain/relay/Services/provider-turn-service.js";
import { ConfigTag } from "../../../../src/lib/domain/relay/Services/services.js";
import { makeOverridesStateLive } from "../../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";

// Failure modes and agreed seams are recorded in the account-switch report.
it("records one limit per user turn, closes only the cut-off on Dismiss, and clears recovery on a reply", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const commit = yield* makeCommitAndSignal;
			const store = yield* EventStoreEffectTag;
			const read = yield* ReadQueryEffectTag;
			const continuation = yield* makeContinuation;
			yield* commit([
				canonicalEvent("session.created", "s1", {
					sessionId: "s1",
					title: "Limited",
					provider: "account-1",
				}),
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "u1",
					role: "user",
				}),
			]);
			const signal = {
				instanceId: "account-1",
				rateLimitType: "seven_day",
				resetsAt: 1791234000,
				cutOffMessageId: "u1",
			};
			yield* Effect.all(
				[
					continuation.intakeLimit(
						canonicalEvent("session.usage_limited", "s1", signal, {
							provider: "claude",
						}),
					),
					continuation.intakeLimit(
						canonicalEvent("session.usage_limited", "s1", signal, {
							provider: "claude",
						}),
					),
				],
				{ concurrency: 2 },
			);
			const limits = () =>
				store
					.readAllBySession("s1")
					.pipe(
						Effect.map((events) =>
							events.filter((event) => event.type === "session.usage_limited"),
						),
					);
			expect(yield* limits()).toHaveLength(1);
			expect((yield* read.listSessionInfos())[0]?.limitRecovery).toEqual({
				...signal,
				rearms: 0,
				continued: false,
			});
			yield* continuation.dismissCutOff("s1");
			yield* continuation.dismissCutOff("s1");
			yield* continuation.dismissCutOff("missing");
			expect((yield* read.listSessionInfos())[0]?.limitRecovery).toEqual({
				instanceId: "account-1",
				rateLimitType: "seven_day",
				resetsAt: 1791234000,
				rearms: 0,
				continued: false,
			});
			expect(
				(yield* store.readAllBySession("s1")).filter(
					(event) => event.type === "session.cut_off_dismissed",
				),
			).toHaveLength(1);
			// A stale repeat after Dismiss must not re-open the cut-off.
			yield* continuation.intakeLimit(
				canonicalEvent("session.usage_limited", "s1", signal, {
					provider: "claude",
				}),
			);
			expect(yield* limits()).toHaveLength(1);
			// The same limit tuple is a new limit once a newer user turn exists.
			yield* commit([
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "u2",
					role: "user",
				}),
			]);
			yield* continuation.intakeLimit(
				canonicalEvent("session.usage_limited", "s1", signal, {
					provider: "claude",
				}),
			);
			yield* continuation.intakeLimit(
				canonicalEvent("session.usage_limited", "s1", signal, {
					provider: "claude",
				}),
			);
			expect(yield* limits()).toHaveLength(2);
			expect(
				(yield* read.listSessionInfos())[0]?.limitRecovery?.cutOffMessageId,
			).toBe("u1");
			yield* commit([
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "a2",
					role: "assistant",
				}),
			]);
			expect((yield* read.listSessionInfos())[0]?.limitRecovery).toBeNull();
			// A dismissed cut-off still leaves the strip until the session replies.
			yield* commit([
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "u3",
					role: "user",
				}),
			]);
			yield* continuation.intakeLimit(
				canonicalEvent(
					"session.usage_limited",
					"s1",
					{ ...signal, cutOffMessageId: "u3" },
					{ provider: "claude" },
				),
			);
			yield* continuation.dismissCutOff("s1");
			yield* commit([
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "a3",
					role: "assistant",
				}),
			]);
			expect((yield* read.listSessionInfos())[0]?.limitRecovery).toBeNull();
		}).pipe(Effect.provide(makePersistenceEffectLayer(":memory:"))),
	);
});

for (const scenario of [
	{
		name: "driver before stale/busy/quota",
		provider: "opencode",
		expected: "wrong",
		busy: true,
		result: "DriverMismatch",
		probes: 0,
	},
	{
		name: "stale before busy/quota",
		expected: "wrong",
		busy: true,
		result: "StaleSwitch",
		probes: 0,
	},
	{ name: "busy before quota", busy: true, result: "SessionBusy", probes: 0 },
	{
		name: "fresh limited quota",
		quota: "Limited",
		result: "AccountUnavailable",
		probes: 1,
	},
	{
		name: "unavailable account",
		quota: "Unavailable",
		result: "AccountUnavailable",
		probes: 1,
	},
	{
		name: "driver changed during probe",
		duringProbe: "provider",
		result: "DriverMismatch",
		probes: 1,
	},
	{
		name: "turn started during probe",
		duringProbe: "busy",
		result: "SessionBusy",
		probes: 1,
	},
] as const) {
	it(`continuation gate: ${scenario.name}`, async () => {
		let probes = 0;
		let dispatches = 0;
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const commit = yield* makeCommitAndSignal;
				const store = yield* EventStoreEffectTag;
				const continuation = yield* makeContinuation;
				yield* commit([
					canonicalEvent("session.created", "s1", {
						sessionId: "s1",
						title: "Cut off",
						provider: "provider" in scenario ? scenario.provider : "claude",
					}),
					canonicalEvent("session.usage_limited", "s1", {
						instanceId: "claude",
						rateLimitType: "seven_day",
						cutOffMessageId: "u1",
					}),
				]);
				if ("busy" in scenario && scenario.busy)
					yield* sql`UPDATE sessions SET status = 'busy' WHERE id = 's1'`;
				const before = yield* store.readAllBySession("s1");
				const result = yield* continuation
					.requestContinuation("s1", {
						instanceId: "claude",
						reason: "user",
						expectedInstanceId:
							"expected" in scenario ? scenario.expected : "claude",
					})
					.pipe(
						Effect.provideService(QuotaCheckTag, {
							check: () =>
								Effect.gen(function* () {
									probes++;
									if ("duringProbe" in scenario) {
										if (scenario.duringProbe === "provider")
											yield* sql`UPDATE sessions SET provider = 'other' WHERE id = 's1'`;
										else
											yield* sql`UPDATE sessions SET status = 'busy' WHERE id = 's1'`;
									}
									return "quota" in scenario && scenario.quota === "Unavailable"
										? { _tag: "Unavailable" as const, reason: "Not logged in" }
										: "quota" in scenario && scenario.quota === "Limited"
											? { _tag: "Limited" as const, rateLimitType: "seven_day" }
											: { _tag: "Unknown" as const };
								}).pipe(Effect.orDie),
							pickFailover: () => Effect.succeed(undefined),
						}),
						Effect.either,
					);
				expect(result._tag).toBe("Left");
				if (result._tag === "Left")
					expect(result.left._tag).toBe(scenario.result);
				expect(probes).toBe(scenario.probes);
				expect(dispatches).toBe(0);
				expect(yield* store.readAllBySession("s1")).toEqual(before);
			}).pipe(
				Effect.provideService(ConfigTag, {
					httpServer: createServer(),
					projectDir: "/tmp",
					slug: "gate-test",
					configDir: "/tmp/conduit-eon2-no-config",
					persistenceDbPath: ":memory:",
					publishGlobalSetting: () => Effect.void,
				}),
				Effect.provideService(ProviderTurnServiceTag, {
					prepareTurnSession: (input) => Effect.succeed(input.sessionId),
					sendTurn: () =>
						Effect.sync(() => {
							dispatches++;
						}),
					interruptTurn: () => Effect.void,
				}),
				Effect.provide(makeOverridesStateLive()),
				Effect.provide(makePersistenceEffectLayer(":memory:")),
			),
		);
	});
}
