// Failure modes: cached usage wins over a fresh reading; a full account sends;
// unknown usage refuses; sign-in or busy refusals disappear; another session
// resumes; a Resume during the refresh duplicates a turn or reports a refusal.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import type { UsageReading } from "../../../src/lib/contracts/limit-recovery.js";
import { AccountDirectoryStateLive } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { Usage } from "../../../src/lib/domain/daemon/Services/usage.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { AlertsLive } from "../../../src/lib/domain/relay/Services/alerts.js";
import {
	ContinuationTag,
	makeContinuation,
} from "../../../src/lib/domain/relay/Services/continuation.js";
import { InputDraftsLive } from "../../../src/lib/domain/relay/Services/input-drafts.js";
import { ProviderTurnServiceTag } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import {
	SessionInboxLive,
	SessionInboxTag,
} from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";
import { usageReading } from "../../helpers/usage.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "conduit-usage-reset-continue-"));
	vi.stubEnv("HOME", root);
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "launch"));
	vi.stubEnv("CONDUIT_CONFIG_DIR", join(root, "config"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

const reset = 10_000;
const request = {
	instanceId: "claude",
	expectedInstanceId: "claude",
	reason: "user",
} as const;

const fixture = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	const store = yield* EventStoreEffectTag;
	const read = yield* ReadQueryEffectTag;
	const cached = usageReading("claude", {
		status: "limited",
		readAt: 2_000,
		windows: [
			{
				kind: "seven_day",
				utilization: 100,
				resetsAt: new Date(reset).toISOString(),
			},
		],
	});
	let reading: UsageReading = cached;
	let beforeRefresh: Effect.Effect<void> = Effect.void;
	let usageChecks = 0;
	const usage: Usage["Service"] = {
		readings: Stream.empty,
		latest: () => Effect.succeed(cached),
		refresh: () =>
			Effect.gen(function* () {
				usageChecks += 1;
				yield* beforeRefresh;
				return [reading];
			}),
		turnEnded: () => Effect.void,
		pickFailover: () => Effect.succeed(undefined),
	};
	const dispatches: { sessionId: string; text: string }[] = [];
	const turns: ProviderTurnServiceTag["Service"] = {
		holdUserTurnsForAccountSwitch: () => Effect.void,
		prepareTurnSession: (input) => Effect.succeed(input.sessionId),
		turnFences: () => ({ stopping: false, switching: false }),
		fenceLifts: Effect.succeed(Stream.never),
		beginStop: () => Effect.succeed(Effect.void),
		sendTurn: (input) =>
			Effect.gen(function* () {
				dispatches.push({ sessionId: input.sessionId, text: input.text });
				yield* commit([
					...(input.events ?? []),
					canonicalEvent("session.status", input.sessionId, {
						sessionId: input.sessionId,
						status: "busy",
					}),
				]);
			}).pipe(Effect.orDie),
	};
	yield* TestClock.setTime(1_000);
	for (const sessionId of ["s1", "s2"])
		yield* commit([
			canonicalEvent("session.created", sessionId, {
				sessionId,
				title: "Cut off",
				provider: "claude",
			}),
			canonicalEvent("message.created", sessionId, {
				sessionId,
				messageId: `user-${sessionId}`,
				role: "user",
			}),
			canonicalEvent(
				"session.usage_limited",
				sessionId,
				{
					instanceId: "claude",
					rateLimitType: "seven_day",
					resetsAt: reset / 1_000,
					cutOffMessageId: `user-${sessionId}`,
				},
				{ provider: "claude", createdAt: 1_000 },
			),
		]);
	yield* TestClock.setTime(2_000);
	const continuation = yield* makeContinuation;
	const context = yield* Layer.build(SessionInboxLive).pipe(
		Effect.provide(InputDraftsLive),
		Effect.provideService(ContinuationTag, continuation),
		Effect.provideService(Usage, usage),
		Effect.provideService(ProviderTurnServiceTag, turns),
	);
	return {
		commit,
		store,
		read,
		dispatches,
		continue: continuation
			.requestContinuation("s1", request)
			.pipe(
				Effect.provideService(Usage, usage),
				Effect.provideService(ProviderTurnServiceTag, turns),
				Effect.provideService(
					SessionInboxTag,
					Context.get(context, SessionInboxTag),
				),
			),
		setReading: (next: UsageReading) => {
			reading = next;
		},
		pauseRefresh: (pause: Effect.Effect<void>) => {
			beforeRefresh = pause;
		},
		artifact: (name: string) =>
			Effect.gen(function* () {
				const events = [];
				for (const sessionId of ["s1", "s2"])
					for (const event of yield* store.readAllBySession(sessionId))
						events.push({
							sessionId,
							type: event.type,
							payload: Object.fromEntries(
								Object.entries(event.data).filter(
									([key]) => !["sessionId", "messageId", "at"].includes(key),
								),
							),
						});
				const artifact = `${JSON.stringify({ events, usageChecks }, null, "\t")}\n`;
				mkdirSync("test-results/usage-reset", { recursive: true });
				writeFileSync(`test-results/usage-reset/${name}.json`, artifact);
				yield* Effect.tryPromise(() =>
					expect(artifact).toMatchFileSnapshot(`./golden/${name}.json`),
				);
			}),
	};
});

const withFixture = <A, E, R>(
	use: (value: Effect.Success<typeof fixture>) => Effect.Effect<A, E, R>,
) => {
	const registry = new ProviderRegistry([]);
	return Effect.flatMap(fixture, use).pipe(
		Effect.provideService(ProviderRegistryTag, registry),
		Effect.provideService(
			OrchestrationEngineTag,
			new OrchestrationEngine({ registry }),
		),
		Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
		Effect.provideService(LoggerTag, makeMockLogger()),
		Effect.provideService(AgentServiceTag, {
			getActiveAgent: () => Effect.succeed(undefined),
			listAgents: () => Effect.die("Resume does not discover agents"),
			switchAgent: () => Effect.die("Resume does not switch agents"),
		}),
		Effect.provide(AlertsLive),
		Effect.provideService(ConfigTag, {
			httpServer: createServer(),
			projectDir: root,
			slug: "usage-reset-continue",
			configDir: join(root, "config"),
			persistenceDbPath: ":memory:",
			publishGlobalSetting: () => Effect.void,
		}),
		Effect.provide(
			AccountDirectoryStateLive(
				accountsStateFromInstances(
					[{ id: "claude", name: "Claude", driver: "claude", configDir: root }],
					configuredClaudeConfigDir(join(root, "launch")),
				),
			),
		),
		Effect.provide(makeOverridesStateLive()),
		Effect.provide(
			Layer.merge(
				makePersistenceEffectLayer(
					":memory:",
					"usage-reset-continue",
					undefined,
					SessionEventBusLive,
				),
				SessionEventBusLive,
			),
		),
	);
};

it.effect(
	"refuses a full account, then resumes only the named session from a fresh free reading",
	() =>
		withFixture((value) =>
			Effect.gen(function* () {
				const before = yield* value.store.readAllBySession("s1");
				const result = yield* value.continue.pipe(Effect.result);
				expect(result).toMatchObject({
					_tag: "Failure",
					failure: {
						_tag: "AccountStillLimited",
						label: "weekly limit",
						until: reset,
					},
				});
				if (result._tag === "Failure")
					expect(result.failure.message).toBe(
						`Claude still shows the weekly limit until ${new Date(reset).toUTCString()}.`,
					);
				expect(yield* value.store.readAllBySession("s1")).toEqual(before);
				expect(value.dispatches).toEqual([]);
				yield* value.artifact("usage-reset-refused");
				value.setReading(
					usageReading("claude", { status: "available", readAt: 2_001 }),
				);
				yield* value.continue;
				expect(value.dispatches).toEqual([{ sessionId: "s1", text: "" }]);
				const sessions = yield* value.read.listSessionInfos({
					projectIds: ["usage-reset-continue"],
				});
				expect(
					sessions.find((session) => session.id === "s1")?.resumes,
				).toMatchObject([{ instanceId: "claude", reason: "user" }]);
				expect(
					sessions.find((session) => session.id === "s2")?.resumes,
				).toEqual([]);
				yield* value.artifact("usage-reset-user");
			}),
		),
);

it.effect("continues when the fresh Usage Reading is unknown", () =>
	withFixture((value) =>
		Effect.gen(function* () {
			value.setReading(
				usageReading("claude", { status: "unknown", readAt: 2_001 }),
			);
			yield* value.continue;
			expect(value.dispatches).toEqual([{ sessionId: "s1", text: "" }]);
			yield* value.artifact("usage-reset-unknown");
		}),
	),
);

it.effect("keeps the sign-in refusal for a signed-out account", () =>
	withFixture((value) =>
		Effect.gen(function* () {
			value.setReading(
				usageReading("claude", {
					status: "unavailable",
					reason: "Not logged in",
				}),
			);
			const before = yield* value.store.readAllBySession("s1");
			expect(yield* value.continue.pipe(Effect.result)).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "AccountUnavailable", reason: "Not logged in" },
			});
			expect(value.dispatches).toEqual([]);
			expect(yield* value.store.readAllBySession("s1")).toEqual(before);
		}),
	),
);

it.effect("keeps the busy refusal without sending or changing recovery", () =>
	withFixture((value) =>
		Effect.gen(function* () {
			yield* value.commit([
				canonicalEvent("session.status", "s1", {
					sessionId: "s1",
					status: "busy",
				}),
			]);
			const before = yield* value.store.readAllBySession("s1");
			expect(yield* value.continue.pipe(Effect.result)).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "SessionBusy", sessionId: "s1" },
			});
			expect(value.dispatches).toEqual([]);
			expect(yield* value.store.readAllBySession("s1")).toEqual(before);
		}),
	),
);

it.effect(
	"silently ignores a Resume that already happened while refreshing",
	() =>
		withFixture((value) =>
			Effect.gen(function* () {
				const refreshing = yield* Deferred.make<void>();
				const ready = yield* Deferred.make<void>();
				value.pauseRefresh(
					Deferred.succeed(refreshing, undefined).pipe(
						Effect.andThen(Deferred.await(ready)),
					),
				);
				const pending = yield* value.continue.pipe(Effect.forkChild);
				yield* Deferred.await(refreshing);
				yield* value.commit([
					canonicalEvent(
						"session.resumed",
						"s1",
						{ instanceId: "claude", reason: "reset" },
						{ provider: "claude" },
					),
					canonicalEvent("session.status", "s1", {
						sessionId: "s1",
						status: "busy",
					}),
				]);
				yield* Deferred.succeed(ready, undefined);
				yield* Fiber.join(pending);
				yield* value.continue;
				expect(value.dispatches).toEqual([]);
				expect(
					(yield* value.store.readAllBySession("s1")).filter(
						(event) => event.type === "session.resumed",
					),
				).toHaveLength(1);
			}),
		),
);
