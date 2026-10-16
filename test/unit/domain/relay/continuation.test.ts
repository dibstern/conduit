// Failure modes: a driver mismatch reaches the quota probe; stale selection
// loses to busy/quota; a busy session probes or appends; a fresh refusal writes
// recovery/events; a session moves or starts a turn while the probe is pending.
// All refusals must leave the event stream untouched and never dispatch a turn.
// Account-routing failures: a legacy binding selects the wrong receipt/login;
// prewarm rereads stale or invalid disk config; an unknown account is ignored;
// revalidation re-resolves an account instead of keeping the admitted snapshot.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	accountsStateFromConfig,
	accountsStateFromInstances,
} from "../../../../src/lib/account-directory.js";
import type { Account } from "../../../../src/lib/contracts/account.js";
import { defaultDaemonConfig } from "../../../../src/lib/daemon/config-persistence.js";
import {
	AccountDirectory,
	makeAccountDirectory,
} from "../../../../src/lib/domain/daemon/Services/account-directory.js";
import { Usage } from "../../../../src/lib/domain/daemon/Services/usage.js";
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
import { SessionInboxTag } from "../../../../src/lib/domain/relay/Services/session-inbox.js";
import { makeOverridesStateLive } from "../../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { preWarmSession } from "../../../../src/lib/handlers/session-prewarm.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import {
	nativeThreadKey,
	ProviderStateEffectTag,
} from "../../../../src/lib/persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import { OrchestrationEngine } from "../../../../src/lib/provider/orchestration-engine.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../../src/lib/provider/provider-registry.js";
import type { PreWarmSessionInput } from "../../../../src/lib/provider/types.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../../helpers/mock-factories.js";
import { usageReading } from "../../../helpers/usage.js";

let isolatedRoot: string;
beforeEach(() => {
	isolatedRoot = mkdtempSync(join(tmpdir(), "conduit-continuation-"));
	vi.stubEnv("HOME", isolatedRoot);
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(isolatedRoot, "inherited-login"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(isolatedRoot, { recursive: true, force: true });
});

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
			expect(
				(yield* read.listSessionInfos({ projectIds: ["test-project"] }))[0]
					?.limitRecovery,
			).toEqual({
				...signal,
				rearms: 0,
				continued: false,
			});
			yield* continuation.dismissCutOff("s1");
			yield* continuation.dismissCutOff("s1");
			yield* continuation.dismissCutOff("missing");
			expect(
				(yield* read.listSessionInfos({ projectIds: ["test-project"] }))[0]
					?.limitRecovery,
			).toEqual({
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
				(yield* read.listSessionInfos({ projectIds: ["test-project"] }))[0]
					?.limitRecovery?.cutOffMessageId,
			).toBe("u1");
			yield* commit([
				canonicalEvent("message.created", "s1", {
					sessionId: "s1",
					messageId: "a2",
					role: "assistant",
				}),
			]);
			expect(
				(yield* read.listSessionInfos({ projectIds: ["test-project"] }))[0]
					?.limitRecovery,
			).toBeNull();
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
			expect(
				(yield* read.listSessionInfos({ projectIds: ["test-project"] }))[0]
					?.limitRecovery,
			).toBeNull();
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
		),
	);
});

for (const scenario of [
	{
		name: "unknown target before quota",
		instanceId: "unknown-account",
		result: "AccountUnroutable",
		probes: 0,
	},
	{
		name: "keeps the selected account snapshot through quota revalidation",
		duringProbe: "account",
		result: "Right",
		probes: 1,
	},
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
		result: "StaleSwitch",
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
		const dispatchedAccounts: Account[] = [];
		const admittedSessions: string[] = [];
		const admission = Effect.unsafeMakeSemaphore(1);
		const launchLogin = configuredClaudeConfigDir(
			join(isolatedRoot, "launch-login"),
		);
		let accountState = accountsStateFromConfig(
			defaultDaemonConfig(),
			launchLogin,
		);
		const registry = new ProviderRegistry();
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
						instanceId:
							"instanceId" in scenario ? scenario.instanceId : "claude",
						reason: "user",
						expectedInstanceId:
							"expected" in scenario ? scenario.expected : "claude",
					})
					.pipe(
						Effect.provideService(Usage, {
							readings: Stream.empty,
							latest: () => Effect.succeed(undefined),
							turnEnded: () => Effect.void,
							refresh: () =>
								Effect.gen(function* () {
									probes++;
									if ("duringProbe" in scenario) {
										if (scenario.duringProbe === "provider")
											yield* sql`UPDATE sessions SET provider = 'other' WHERE id = 's1'`;
										else if (scenario.duringProbe === "busy")
											yield* sql`UPDATE sessions SET status = 'busy' WHERE id = 's1'`;
										else
											accountState = accountsStateFromInstances(
												[
													{
														id: "claude",
														name: "Claude",
														driver: "claude",
														configDir: join(isolatedRoot, "changed-login"),
													},
												],
												launchLogin,
											);
									}
									return "quota" in scenario && scenario.quota === "Unavailable"
										? [
												usageReading("claude", {
													status: "unavailable",
													reason: "Not logged in",
												}),
											]
										: "quota" in scenario && scenario.quota === "Limited"
											? [
													usageReading("claude", {
														status: "limited",
														windows: [{ kind: "seven_day", utilization: 100 }],
													}),
												]
											: [usageReading("claude")];
								}).pipe(Effect.orDie),
							pickFailover: () => Effect.succeed(undefined),
						}),
						Effect.either,
					);
				expect(result._tag).toBe(
					scenario.result === "Right" ? "Right" : "Left",
				);
				if (result._tag === "Left")
					expect(result.left._tag).toBe(scenario.result);
				expect(probes).toBe(scenario.probes);
				expect(dispatches).toBe(scenario.result === "Right" ? 1 : 0);
				if (scenario.result === "Right") {
					expect(admittedSessions).toEqual(["s1"]);
					expect(dispatchedAccounts).toHaveLength(1);
					expect(dispatchedAccounts[0]).toMatchObject({
						id: "claude",
						folder: launchLogin,
					});
				} else {
					expect(admittedSessions).toEqual([]);
					expect(yield* store.readAllBySession("s1")).toEqual(before);
				}
			}).pipe(
				Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
				Effect.provideService(LoggerTag, makeMockLogger()),
				Effect.provideService(
					OrchestrationEngineTag,
					new OrchestrationEngine({ registry }),
				),
				Effect.provideService(ProviderRegistryTag, registry),
				Effect.provideService(
					AccountDirectory,
					makeAccountDirectory(Effect.sync(() => accountState)),
				),
				Effect.provideService(AgentServiceTag, {
					getActiveAgent: () => Effect.succeed(undefined),
					listAgents: () => Effect.die("A refusal must not discover agents"),
					switchAgent: () => Effect.die("A refusal must not change agents"),
				}),
				Effect.provide(AlertsLive),
				Effect.provideService(ConfigTag, {
					httpServer: createServer(),
					projectDir: isolatedRoot,
					slug: "gate-test",
					configDir: isolatedRoot,
					persistenceDbPath: ":memory:",
					publishGlobalSetting: () => Effect.void,
				}),
				Effect.provideService(ProviderTurnServiceTag, {
					holdUserTurnsForAccountSwitch: () => Effect.void,
					prepareTurnSession: (input) => Effect.succeed(input.sessionId),
					sendTurn: (input) =>
						Effect.sync(() => {
							dispatches++;
							if (input.account) dispatchedAccounts.push(input.account);
						}),
					interruptTurn: () => Effect.void,
				}),
				Effect.provideService(SessionInboxTag, {
					withSession: (sessionId, effect) =>
						admission.withPermits(1)(
							Effect.sync(() => admittedSessions.push(sessionId)).pipe(
								Effect.zipRight(effect),
							),
						),
					start: Effect.void,
					submit: () => Effect.die("This fixture only admits continuations"),
					cancel: () => Effect.die("This fixture only admits continuations"),
					sendNow: () => Effect.die("This fixture only admits continuations"),
				}),
				Effect.provide(makeOverridesStateLive()),
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
	});
}

for (const boundId of ["claude-sdk", "unknown-account", "opencode"] as const) {
	it(`prewarm routes the stored ${boundId} binding through the account directory`, async () => {
		writeFileSync(join(isolatedRoot, "daemon.json"), "not valid JSON");
		const folder = configuredClaudeConfigDir(
			join(isolatedRoot, "personal-login"),
		);
		const accounts = makeAccountDirectory(
			Effect.succeed(
				accountsStateFromInstances(
					[
						{
							id: "personal",
							name: "Personal",
							driver: "claude",
							configDir: folder.path,
						},
						{ id: "opencode", name: "OpenCode", driver: "opencode" },
					],
					configuredClaudeConfigDir(join(isolatedRoot, "launch-login")),
				),
			),
		);
		const warmed: PreWarmSessionInput[] = [];
		const registry = new ProviderRegistry([
			{
				providerId: "claude",
				steering: false,
				discoverEffect: () => Effect.die("Prewarm must not discover"),
				sendTurnEffect: () => Effect.die("Prewarm must not send a turn"),
				preWarmSessionEffect: (input) =>
					Effect.sync(() => {
						warmed.push(input);
					}),
				interruptTurnEffect: () => Effect.void,
				resolvePermissionEffect: () => Effect.void,
				resolveQuestionEffect: () => Effect.void,
				endSessionEffect: () => Effect.void,
				shutdownEffect: () => Effect.void,
			},
		]);
		const engine = new OrchestrationEngine({ registry });
		await Effect.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const read = yield* ReadQueryEffectTag;
				const state = yield* ProviderStateEffectTag;
				yield* commit([
					canonicalEvent("session.created", "s1", {
						sessionId: "s1",
						title: "Warm",
						provider: boundId,
					}),
				]);
				yield* state.saveUpdates("s1", [
					{
						key: nativeThreadKey("personal"),
						value: JSON.stringify({
							configDir: folder,
							resumeSessionId: "personal-native",
							firstSequence: 1,
							deliveredThrough: 1,
						}),
					},
				]);
				engine.bindSession("s1", boundId);
				const result = yield* preWarmSession("s1").pipe(Effect.either);
				if (boundId === "unknown-account") {
					expect(result._tag).toBe("Left");
					if (result._tag === "Left") {
						expect(result.left._tag).toBe("AccountUnroutable");
						expect(result.left.message).toContain(boundId);
					}
					expect(warmed).toEqual([]);
				} else if (boundId === "opencode") {
					expect(result._tag).toBe("Right");
					expect(warmed).toEqual([]);
				} else {
					expect(result._tag).toBe("Right");
					expect(warmed).toHaveLength(1);
					expect(warmed[0]).toMatchObject({
						instanceId: "personal",
						configDir: folder,
						resumeSessionId: "personal-native",
					});
				}
				expect((yield* read.getSession("s1"))?.provider).toBe(boundId);
			}).pipe(
				Effect.provideService(AccountDirectory, accounts),
				Effect.provideService(LoggerTag, makeMockLogger()),
				Effect.provide(AlertsLive),
				Effect.provideService(ProviderRegistryTag, registry),
				Effect.provideService(OrchestrationEngineTag, engine),
				Effect.provideService(AgentServiceTag, {
					getActiveAgent: () => Effect.succeed(undefined),
					listAgents: () => Effect.die("Prewarm must not discover agents"),
					switchAgent: () => Effect.die("Prewarm must not change agents"),
				}),
				Effect.provideService(ConfigTag, {
					httpServer: createServer(),
					projectDir: isolatedRoot,
					slug: "prewarm-test",
					configDir: isolatedRoot,
					persistenceDbPath: ":memory:",
					publishGlobalSetting: () => Effect.void,
				}),
				Effect.provide(makeOverridesStateLive()),
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);
	});
}
