// Failure modes: pre-limit or stale readings resume early; Auto-resume off
// probes or resumes early; repeated limits lose the time-only guard after a
// reply; failed reads retry each sweep; projects duplicate one account's read;
// racing Resumes dispatch twice, cancel the winner, or report a refusal.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Fiber,
	Layer,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import { LimitRecoverySchema } from "../../../src/lib/contracts/limit-recovery.js";
import { AccountDirectoryStateLive } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import {
	makeUsage,
	Usage,
} from "../../../src/lib/domain/daemon/Services/usage.js";
import { PersistenceProjectTag } from "../../../src/lib/domain/persistence/Services/persistence-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { AgentServiceTag } from "../../../src/lib/domain/relay/Services/agent-service.js";
import { AlertsLive } from "../../../src/lib/domain/relay/Services/alerts.js";
import { makeContinuation } from "../../../src/lib/domain/relay/Services/continuation.js";
import { ProviderTurnServiceTag } from "../../../src/lib/domain/relay/Services/provider-turn-service.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { SessionInboxTag } from "../../../src/lib/domain/relay/Services/session-inbox.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import type { UsageRead } from "../../../src/lib/provider/usage-reader.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
} from "../../helpers/mock-factories.js";

const start = 1_000;
const reset = (start + 3_600_000) / 1000;
let root: string;
let now: number;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "conduit-usage-reset-sweep-"));
	now = start;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.stubEnv("HOME", root);
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "launch"));
	vi.stubEnv("CONDUIT_CONFIG_DIR", join(root, "config"));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

const at = (time: number) =>
	Effect.gen(function* () {
		now = time;
		yield* TestClock.setTime(time);
	});

const sweepFixture = Effect.gen(function* () {
	yield* at(start);
	let usageChecks = 0;
	let result: UsageRead = { status: "available", windows: [] };
	let fails = false;
	let blocked: Deferred.Deferred<void> | undefined;
	const checking = yield* Deferred.make<void>();
	const usage = yield* makeUsage({
		accounts: Effect.succeed([{ id: "claude", harness: "claude" }]),
		readers: {
			codex: {
				read: () => Effect.succeed({ status: "unavailable", windows: [] }),
			},
			cursor: {
				read: () => Effect.succeed({ status: "unavailable", windows: [] }),
			},
			claude: {
				read: () =>
					Effect.gen(function* () {
						usageChecks += 1;
						yield* Deferred.succeed(checking, undefined);
						if (blocked) yield* Deferred.await(blocked);
						if (fails)
							return yield* Effect.fail(
								new Error("Scripted Usage read failed"),
							);
						return result;
					}),
			},
		},
	});
	const project = (
		projectId = "usage-reset-sweep",
		sessionId = "s1",
		options: {
			readonly scheduled?: boolean;
			readonly scheduledAt?: number;
			readonly heldOnly?: boolean;
			readonly resetsAt?: number | null;
			readonly rateLimitType?: string;
		} = {},
	) =>
		Effect.gen(function* () {
			const store = yield* makeEventStoreEffect.pipe(
				Effect.provideService(PersistenceProjectTag, { projectId }),
			);
			return yield* Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const read = yield* ReadQueryEffectTag;
				const continuation = yield* makeContinuation;
				const sends: string[] = [];
				let limitedAgain = false;
				const resetsAt =
					options.resetsAt === null ? undefined : (options.resetsAt ?? reset);
				const scheduledAt = options.scheduledAt ?? resetsAt;
				const limit = () =>
					canonicalEvent("session.usage_limited", sessionId, {
						instanceId: "claude",
						rateLimitType: options.rateLimitType ?? "five_hour",
						cutOffMessageId: `${sessionId}-user`,
						...(resetsAt === undefined ? {} : { resetsAt }),
					});
				const turns: ProviderTurnServiceTag["Service"] = {
					holdUserTurnsForAccountSwitch: () => Effect.void,
					prepareTurnSession: (input) => Effect.succeed(input.sessionId),
					turnFences: () => ({ stopping: false, switching: false }),
					fenceLifts: Effect.succeed(Stream.never),
					beginStop: () => Effect.succeed(Effect.void),
					sendTurn: (input) =>
						Effect.gen(function* () {
							expect(input.text).toBe("");
							expect(input.continuation?.cutOffMessageId).toBe(
								`${sessionId}-user`,
							);
							sends.push(sessionId);
							yield* commit([
								canonicalEvent("session.status", sessionId, {
									sessionId,
									status: "busy",
								}),
								canonicalEvent("message.created", sessionId, {
									sessionId,
									messageId: `${sessionId}-assistant-${sends.length}`,
									parentID: `${sessionId}-user`,
									role: "assistant",
								}),
								...(limitedAgain
									? [limit()]
									: [
											canonicalEvent("turn.completed", sessionId, {
												messageId: `${sessionId}-assistant-${sends.length}`,
											}),
										]),
								canonicalEvent("session.status", sessionId, {
									sessionId,
									status: "idle",
								}),
							]);
						}).pipe(Effect.orDie),
				};
				yield* commit([
					canonicalEvent("session.created", sessionId, {
						sessionId,
						title: "Usage reset sweep",
						provider: "claude",
					}),
					canonicalEvent("message.created", sessionId, {
						sessionId,
						messageId: `${sessionId}-user`,
						role: "user",
					}),
					limit(),
					...(options.heldOnly
						? [
								canonicalEvent("session.cut_off_dismissed", sessionId, {
									cutOffMessageId: `${sessionId}-user`,
								}),
							]
						: []),
					...(options.scheduled === false || scheduledAt === undefined
						? []
						: [
								canonicalEvent("session.resume_scheduled", sessionId, {
									instanceId: "claude",
									at: scheduledAt,
									by: "policy",
								}),
							]),
				]);
				return {
					store,
					sessionId,
					continuation,
					sends,
					read,
					commit,
					cutOffAgain: () => {
						limitedAgain = true;
					},
					sweep: () =>
						continuation
							.sweepDueContinuations()
							.pipe(
								Effect.provideService(Usage, usage),
								Effect.provideService(ProviderTurnServiceTag, turns),
							),
					resume: () =>
						continuation
							.requestContinuation(sessionId, {
								instanceId: "claude",
								expectedInstanceId: "claude",
								reason: "user",
							})
							.pipe(
								Effect.provideService(Usage, usage),
								Effect.provideService(ProviderTurnServiceTag, turns),
							),
					policy: continuation.runLimitPolicies.pipe(
						Effect.provideService(Usage, usage),
						Effect.provideService(ProviderTurnServiceTag, turns),
					),
					session: read.getSession(sessionId),
					recovery: read
						.getSession(sessionId)
						.pipe(
							Effect.map((row) =>
								row?.limit_recovery == null
									? null
									: Schema.decodeUnknownSync(
											Schema.fromJsonString(LimitRecoverySchema),
										)(row.limit_recovery),
							),
						),
				};
			}).pipe(Effect.provideService(EventStoreEffectTag, store));
		});
	return {
		project,
		usage,
		checking,
		checks: () => usageChecks,
		fail: () => {
			fails = true;
		},
		setResult: (next: UsageRead) => {
			result = next;
		},
		block: (gate: Deferred.Deferred<void>) => {
			blocked = gate;
		},
		artifact: (
			name: string,
			projects: readonly Effect.Success<ReturnType<typeof project>>[],
		) =>
			Effect.gen(function* () {
				const events = (yield* Effect.forEach(projects, (project) =>
					project.store.readAllBySession(project.sessionId),
				)).flat();
				const artifact = `${JSON.stringify(
					{
						events: events.map((event) => ({
							type: event.type,
							payload: Object.fromEntries(
								Object.entries(event.data).filter(
									([key]) =>
										![
											"sessionId",
											"inputId",
											"messageId",
											"cutOffMessageId",
											"parentID",
											"at",
											"resetsAt",
										].includes(key),
								),
							),
						})),
						usageChecks,
					},
					null,
					"\t",
				)}\n`;
				mkdirSync("test-results/usage-reset", { recursive: true });
				writeFileSync(`test-results/usage-reset/${name}.json`, artifact);
				yield* Effect.tryPromise(() =>
					expect(artifact).toMatchFileSnapshot(`./golden/${name}.json`),
				);
			}),
	};
});

const withSweep = <A, E, R>(
	use: (fixture: Effect.Success<typeof sweepFixture>) => Effect.Effect<A, E, R>,
	autoResume = true,
) => {
	const registry = new ProviderRegistry([]);
	const permit = Semaphore.makeUnsafe(1);
	return Effect.flatMap(sweepFixture, use).pipe(
		Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
		Effect.provideService(LoggerTag, makeMockLogger()),
		Effect.provideService(
			OrchestrationEngineTag,
			new OrchestrationEngine({ registry }),
		),
		Effect.provideService(ProviderRegistryTag, registry),
		Effect.provideService(AgentServiceTag, {
			getActiveAgent: () => Effect.succeed(undefined),
			listAgents: () => Effect.die("The sweep never discovers agents"),
			switchAgent: () => Effect.die("The sweep never switches agents"),
		}),
		Effect.provideService(SessionInboxTag, {
			steerDeclined: () => Effect.void,
			withSession: (_sessionId, admission) => permit.withPermits(1)(admission),
			start: Effect.void,
			submit: () => Effect.die("This fixture only sends continuations"),
			cancel: () => Effect.die("This fixture only sends continuations"),
			sendNow: () => Effect.die("This fixture only sends continuations"),
		}),
		Effect.provide(AlertsLive),
		Effect.provideService(ConfigTag, {
			httpServer: createServer(),
			projectDir: root,
			slug: "usage-reset-sweep",
			configDir: join(root, "config"),
			persistenceDbPath: ":memory:",
			publishGlobalSetting: () => Effect.void,
		}),
		Effect.provide(
			DaemonConfigRefLive(
				makeDaemonConfigFromOptions({
					usageLimits: { autoResume, autoSwitch: false, warnAt: 80, order: [] },
				}),
			),
		),
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
					"usage-reset-sweep",
					undefined,
					SessionEventBusLive,
				),
				SessionEventBusLive,
			),
		),
	);
};

it.effect(
	"resumes early with a fresh free Usage Reading, sends the continuation and records its divider",
	() =>
		withSweep((fixture) =>
			Effect.gen(function* () {
				const project = yield* fixture.project();
				yield* at(start + 1000);
				yield* project.sweep();
				expect(project.sends).toEqual(["s1"]);
				expect((yield* project.session)?.resumes).toContain('"reason":"reset"');
				expect(yield* project.recovery).toBeNull();
				expect(fixture.checks()).toBe(1);
				yield* fixture.artifact("sweep-fresh-free", [project]);
			}),
		),
);

it.effect("does not resume from a cached pre-limit Usage Reading", () =>
	withSweep((fixture) =>
		Effect.gen(function* () {
			yield* fixture.usage.refresh({ accountIds: ["claude"], maxAge: 0 });
			yield* at(start + 1000);
			const project = yield* fixture.project();
			yield* at(start + 2000);
			yield* project.sweep();
			expect(project.sends).toEqual([]);
			expect((yield* project.recovery)?.continued).toBe(false);
			expect(fixture.checks()).toBe(1);
			yield* fixture.artifact("sweep-pre-limit", [project]);
		}),
	),
);

it.effect(
	"with Auto-resume off makes no background read and resumes only on time",
	() =>
		withSweep(
			(fixture) =>
				Effect.gen(function* () {
					const project = yield* fixture.project();
					yield* at(start + 1000);
					yield* project.sweep();
					expect(project.sends).toEqual([]);
					expect(fixture.checks()).toBe(0);
					yield* at(reset * 1000);
					yield* project.sweep();
					expect(project.sends).toEqual(["s1"]);
					expect(fixture.checks()).toBe(0);
					yield* fixture.artifact("sweep-auto-resume-off", [project]);
				}),
			false,
		),
);

it.effect(
	"resumes a due held-only Limit Recovery with Auto-resume on when Usage is unknown",
	() =>
		withSweep((fixture) =>
			Effect.gen(function* () {
				const scheduledAt = (start + 1000) / 1000;
				const project = yield* fixture.project(undefined, undefined, {
					heldOnly: true,
					resetsAt: null,
					scheduledAt,
				});
				fixture.setResult({ status: "unknown", windows: [] });
				expect(yield* project.recovery).not.toHaveProperty("cutOffMessageId");
				expect(yield* project.recovery).not.toHaveProperty("resetsAt");
				yield* at(scheduledAt * 1000);
				yield* project.sweep();
				expect(yield* project.recovery).toBeNull();
				expect((yield* project.session)?.resumes).toContain('"reason":"reset"');
				expect(project.sends).toEqual([]);
				expect(fixture.checks()).toBe(1);
				yield* fixture.artifact("sweep-held-only-due-unknown", [project]);
			}),
		),
);

it.effect("leaves a not-yet-due busy Limit Recovery untouched", () =>
	withSweep((fixture) =>
		Effect.gen(function* () {
			const project = yield* fixture.project();
			yield* project.commit([
				canonicalEvent("session.status", "s1", {
					sessionId: "s1",
					status: "busy",
				}),
			]);
			const before = yield* project.session;
			const events = yield* project.store.readAllBySession("s1");
			yield* at(start + 1000);
			yield* project.sweep();
			expect(yield* project.session).toEqual(before);
			expect(yield* project.store.readAllBySession("s1")).toEqual(events);
			expect(project.sends).toEqual([]);
			expect(fixture.checks()).toBe(0);
			yield* fixture.artifact("sweep-early-busy", [project]);
		}),
	),
);

it.effect(
	"marks a repeated early limit time-only and waits on the next sweep",
	() =>
		withSweep((fixture) =>
			Effect.gen(function* () {
				const project = yield* fixture.project();
				project.cutOffAgain();
				yield* at(start + 1000);
				yield* project.sweep();
				expect((yield* project.recovery)?.timeOnly).toBe(true);
				yield* Effect.forkScoped(project.policy);
				yield* project.continuation.queueLimitPolicy("s1");
				yield* project.recovery.pipe(
					Effect.repeat({
						until: (recovery) => recovery?.scheduledAt === reset,
					}),
				);
				const beforeSweep = yield* project.store.readAllBySession("s1");
				yield* at(start + 302_000);
				yield* project.sweep();
				expect(yield* project.store.readAllBySession("s1")).toEqual(
					beforeSweep,
				);
				expect(project.sends).toEqual(["s1"]);
				expect(yield* project.recovery).toMatchObject({
					timeOnly: true,
					continued: false,
					scheduledAt: reset,
					auto: true,
					rearms: 0,
				});
				expect(fixture.checks()).toBe(2);
				yield* fixture.artifact("sweep-time-only", [project]);
			}),
		),
);

it.effect("does not retry a failed Usage read within five minutes", () =>
	withSweep((fixture) =>
		Effect.gen(function* () {
			const project = yield* fixture.project();
			fixture.fail();
			yield* at(start + 1000);
			yield* project.sweep();
			yield* at(start + 31_000);
			yield* project.sweep();
			yield* at(start + 300_999);
			yield* project.sweep();
			expect(fixture.checks()).toBe(1);
			expect(project.sends).toEqual([]);
			yield* fixture.artifact("sweep-failed-check", [project]);
			yield* at(start + 301_000);
			yield* project.sweep();
			expect(fixture.checks()).toBe(2);
		}),
	),
);

it.effect(
	"shares one in-flight Usage read across two projects on one account",
	() =>
		withSweep((fixture) =>
			Effect.gen(function* () {
				const first = yield* fixture.project();
				const second = yield* fixture.project("second-project", "s2");
				const gate = yield* Deferred.make<void>();
				fixture.block(gate);
				yield* at(start + 1000);
				const pending = yield* Effect.forkChild(
					Effect.all([first.sweep(), second.sweep()], {
						concurrency: "unbounded",
					}),
				);
				yield* Deferred.await(fixture.checking);
				expect(fixture.checks()).toBe(1);
				yield* Deferred.succeed(gate, undefined);
				yield* Fiber.join(pending);
				expect(first.sends).toEqual(["s1"]);
				expect(second.sends).toEqual(["s2"]);
				expect(fixture.checks()).toBe(1);
				yield* fixture.artifact("sweep-shared-account", [first, second]);
			}),
		),
);

it.effect("re-arms for a later Account Limit reset with by sweep", () =>
	withSweep((fixture) =>
		Effect.gen(function* () {
			const project = yield* fixture.project();
			fixture.setResult({
				status: "limited",
				windows: [
					{
						kind: "five_hour",
						utilization: 100,
						resetsAt: new Date((reset + 600) * 1000).toISOString(),
					},
				],
			});
			yield* at(start + 1000);
			yield* project.sweep();
			yield* project.sweep();
			expect(project.sends).toEqual([]);
			expect(yield* project.recovery).toMatchObject({
				scheduledAt: reset + 600,
				rearms: 1,
			});
			expect(
				(yield* project.store.readAllBySession("s1")).at(-1)?.data,
			).toEqual({ instanceId: "claude", at: reset + 600, by: "sweep" });
		}),
	),
);

it.effect(
	"leaves a Limit Recovery with no known time alone when Usage cannot tell",
	() =>
		withSweep((fixture) =>
			Effect.gen(function* () {
				const project = yield* fixture.project(undefined, undefined, {
					resetsAt: null,
				});
				fixture.fail();
				const before = yield* project.store.readAllBySession("s1");
				yield* at(start + 1000);
				yield* project.sweep();
				expect(yield* project.store.readAllBySession("s1")).toEqual(before);
				expect(project.sends).toEqual([]);
			}),
		),
);

for (const rival of ["sweep", "strip button"] as const) {
	it.effect(
		`a Resume racing the ${rival} silently sends one continuation`,
		() =>
			withSweep((fixture) =>
				Effect.gen(function* () {
					const project = yield* fixture.project();
					const gate = yield* Deferred.make<void>();
					fixture.block(gate);
					yield* at(start + 1000);
					const pending = yield* Effect.forkChild(project.sweep());
					yield* Deferred.await(fixture.checking);
					const other = yield* Effect.forkChild(
						rival === "sweep" ? project.sweep() : project.resume(),
					);
					yield* TestClock.adjust("1 millis");
					yield* Deferred.succeed(gate, undefined);
					yield* Fiber.join(pending);
					yield* Fiber.join(other);
					yield* project.resume();
					expect(project.sends).toEqual(["s1"]);
					expect(
						(yield* project.store.readAllBySession("s1")).filter(
							(event) => event.type === "session.resumed",
						),
					).toHaveLength(1);
				}),
			),
	);
}

it.effect("a strip Resume racing a sweep that waits still reports busy", () =>
	withSweep((fixture) =>
		Effect.gen(function* () {
			const project = yield* fixture.project();
			fixture.setResult({
				status: "limited",
				windows: [
					{
						kind: "five_hour",
						utilization: 100,
						resetsAt: new Date(reset * 1000).toISOString(),
					},
				],
			});
			const gate = yield* Deferred.make<void>();
			fixture.block(gate);
			yield* at(start + 1000);
			const sweep = yield* Effect.forkChild(project.sweep());
			yield* Deferred.await(fixture.checking);
			const resume = yield* Effect.forkChild(
				project.resume().pipe(Effect.result),
			);
			yield* TestClock.adjust("1 millis");
			yield* Deferred.succeed(gate, undefined);
			yield* Fiber.join(sweep);
			expect(yield* Fiber.join(resume)).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "SessionBusy" },
			});
			expect(project.sends).toEqual([]);
			expect(
				(yield* project.store.readAllBySession("s1")).filter(
					(event) => event.type === "session.resumed",
				),
			).toEqual([]);
		}),
	),
);

it.effect(
	"a racing strip Resume is quiet when the winner hits the limit again",
	() =>
		withSweep((fixture) =>
			Effect.gen(function* () {
				const project = yield* fixture.project();
				project.cutOffAgain();
				const gate = yield* Deferred.make<void>();
				fixture.block(gate);
				yield* at(start + 1000);
				const sweep = yield* Effect.forkChild(project.sweep());
				yield* Deferred.await(fixture.checking);
				const resume = yield* Effect.forkChild(project.resume());
				yield* TestClock.adjust("1 millis");
				yield* Deferred.succeed(gate, undefined);
				yield* Fiber.join(sweep);
				yield* Fiber.join(resume);
				expect(project.sends).toEqual(["s1"]);
				expect((yield* project.recovery)?.timeOnly).toBe(true);
				expect(
					(yield* project.store.readAllBySession("s1")).filter(
						(event) => event.type === "session.resumed",
					),
				).toHaveLength(1);
			}),
		),
);

it.effect(
	"the limit policy resumes without a reported reset when Account Limit says go",
	() =>
		withSweep((fixture) =>
			Effect.gen(function* () {
				const project = yield* fixture.project(undefined, undefined, {
					resetsAt: null,
				});
				yield* at(start + 1000);
				yield* fixture.usage.refresh({ accountIds: ["claude"], maxAge: 0 });
				yield* Effect.forkScoped(project.policy);
				yield* project.continuation.queueLimitPolicy("s1");
				yield* project.store.readAllBySession("s1").pipe(
					Effect.repeat({
						until: (events) =>
							events.some((event) => event.type === "turn.completed"),
					}),
				);
				expect(project.sends).toEqual(["s1"]);
				expect(fixture.checks()).toBe(1);
			}),
		),
);

it.effect(
	"the limit policy schedules the Account Limit reset from a post-limit Usage Reading",
	() =>
		withSweep((fixture) =>
			Effect.gen(function* () {
				const project = yield* fixture.project(undefined, undefined, {
					scheduled: false,
				});
				fixture.setResult({
					status: "limited",
					windows: [
						{
							kind: "five_hour",
							utilization: 100,
							resetsAt: new Date((reset + 600) * 1000).toISOString(),
						},
					],
				});
				yield* at(start + 1000);
				yield* fixture.usage.refresh({ accountIds: ["claude"], maxAge: 0 });
				yield* Effect.forkScoped(project.policy);
				yield* project.continuation.queueLimitPolicy("s1");
				const recovery = yield* project.recovery.pipe(
					Effect.repeat({
						until: (recovery) => recovery?.scheduledAt !== undefined,
					}),
				);
				expect(recovery).toMatchObject({
					scheduledAt: reset + 600,
					auto: true,
					rearms: 0,
				});
				expect(project.sends).toEqual([]);
				expect(
					(yield* project.store.readAllBySession("s1")).at(-1)?.data,
				).toEqual({ instanceId: "claude", at: reset + 600, by: "policy" });
			}),
		),
);

for (const scenario of [
	"different limit",
	"reset passed",
	"on-time Resume",
] as const) {
	it.effect(
		`does not mark a new Limit Recovery time-only after ${scenario}`,
		() =>
			withSweep((fixture) =>
				Effect.gen(function* () {
					const project = yield* fixture.project();
					yield* at(
						scenario === "on-time Resume" ? reset * 1000 : start + 1000,
					);
					yield* project.sweep();
					if (scenario === "reset passed") yield* at(reset * 1000);
					yield* project.commit([
						canonicalEvent("session.usage_limited", "s1", {
							instanceId: "claude",
							rateLimitType:
								scenario === "different limit" ? "seven_day" : "five_hour",
							resetsAt: reset + 600,
							cutOffMessageId: "s1-user",
						}),
					]);
					expect((yield* project.recovery)?.timeOnly).toBeUndefined();
				}),
			),
	);
}

it.effect("a time-only Limit Recovery still permits a user Resume", () =>
	withSweep((fixture) =>
		Effect.gen(function* () {
			const project = yield* fixture.project();
			project.cutOffAgain();
			yield* at(start + 1000);
			yield* project.sweep();
			expect((yield* project.recovery)?.timeOnly).toBe(true);
			yield* project.resume();
			expect(project.sends).toEqual(["s1", "s1"]);
			expect(
				(yield* project.store.readAllBySession("s1"))
					.filter((event) => event.type === "session.resumed")
					.map((event) => event.data.reason),
			).toEqual(["reset", "user"]);
		}),
	),
);
