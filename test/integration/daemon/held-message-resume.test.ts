// Failure modes: a full Usage Reading sends; an unknown reading holds or probes;
// a held-only Resume is recorded as cancellation, loses its divider or sends a
// continuation turn; advances overtake Held Messages; cancellation re-arms or
// drains after reconstruction before the user sends something new.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Context, Effect, Layer, Queue, Schedule, Stream } from "effect";
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
	root = mkdtempSync(join(tmpdir(), "conduit-held-message-resume-"));
	vi.stubEnv("HOME", root);
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "launch"));
	vi.stubEnv("CONDUIT_CONFIG_DIR", join(root, "config"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

const heldMessageFixture = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	const store = yield* EventStoreEffectTag;
	const read = yield* ReadQueryEffectTag;
	const sent = yield* Queue.unbounded<string>();
	const dispatches: string[] = [];
	let reading: UsageReading = usageReading("claude", {
		status: "limited",
		readAt: 1_000,
		windows: [
			{
				kind: "five_hour",
				utilization: 100,
				resetsAt: new Date(10_000).toISOString(),
			},
		],
	});
	let usageChecks = 0;
	const usage: Usage["Service"] = {
		readings: Stream.empty,
		latest: () => Effect.sync(() => reading),
		refresh: () =>
			Effect.sync(() => {
				usageChecks += 1;
				return [reading];
			}),
		turnEnded: () => Effect.void,
		pickFailover: () => Effect.succeed(undefined),
	};
	const turns: ProviderTurnServiceTag["Service"] = {
		holdUserTurnsForAccountSwitch: () => Effect.void,
		prepareTurnSession: (input) => Effect.succeed(input.sessionId),
		turnFences: () => ({ stopping: false, switching: false }),
		fenceLifts: Effect.succeed(Stream.never),
		beginStop: () => Effect.succeed(Effect.void),
		sendTurn: (input) =>
			Effect.gen(function* () {
				dispatches.push(input.text);
				yield* commit([
					...(input.events ?? []),
					canonicalEvent("message.created", input.sessionId, {
						sessionId: input.sessionId,
						messageId: input.commandId,
						inputId: input.commandId,
						role: "user",
					}),
					canonicalEvent("session.status", input.sessionId, {
						sessionId: input.sessionId,
						status: "busy",
					}),
				]);
				yield* Queue.offer(sent, input.text);
			}).pipe(Effect.orDie),
	};
	const makeInbox = Effect.gen(function* () {
		const continuation = yield* makeContinuation;
		const context = yield* Layer.build(SessionInboxLive).pipe(
			Effect.provide(InputDraftsLive),
			Effect.provideService(ContinuationTag, continuation),
		);
		return { inbox: Context.get(context, SessionInboxTag), continuation };
	}).pipe(
		Effect.provideService(Usage, usage),
		Effect.provideService(ProviderTurnServiceTag, turns),
	);
	yield* TestClock.setTime(1_000);
	yield* commit([
		canonicalEvent("session.created", "s1", {
			sessionId: "s1",
			title: "Held Messages",
			provider: "claude",
		}),
	]);
	return {
		commit,
		store,
		read,
		makeInbox,
		usage,
		turns,
		dispatches,
		next: Queue.take(sent),
		setReading: (next: UsageReading) => {
			reading = next;
		},
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
		artifact: (name: string) =>
			Effect.gen(function* () {
				const events = yield* store.readAllBySession("s1");
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
											"parentID",
											"at",
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

const withHeldMessages = <A, E, R>(
	use: (
		fixture: Effect.Success<typeof heldMessageFixture>,
	) => Effect.Effect<A, E, R>,
) => {
	const registry = new ProviderRegistry([]);
	return Effect.flatMap(heldMessageFixture, use).pipe(
		Effect.provideService(OpenCodeAPITag, makeMockOpenCodeAPI()),
		Effect.provideService(LoggerTag, makeMockLogger()),
		Effect.provideService(
			OrchestrationEngineTag,
			new OrchestrationEngine({ registry }),
		),
		Effect.provideService(ProviderRegistryTag, registry),
		Effect.provideService(AgentServiceTag, {
			getActiveAgent: () => Effect.succeed(undefined),
			listAgents: () => Effect.die("Held Messages do not discover agents"),
			switchAgent: () => Effect.die("Held Messages do not switch agents"),
		}),
		Effect.provide(AlertsLive),
		Effect.provideService(ConfigTag, {
			httpServer: createServer(),
			projectDir: root,
			slug: "held-message-resume",
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
					"held-message-resume",
					undefined,
					SessionEventBusLive,
				),
				SessionEventBusLive,
			),
		),
	);
};

for (const reason of ["reset", "user"] as const) {
	it.effect(
		`records a held-only ${reason} Resume and sends Held Messages in order`,
		() =>
			withHeldMessages((fixture) =>
				Effect.gen(function* () {
					const { inbox, continuation } = yield* fixture.makeInbox;
					yield* inbox.start;
					for (const inputId of ["first", "second"])
						expect(
							yield* inbox.submit({
								clientId: "c1",
								sessionId: "s1",
								inputId,
								delivery: "queue",
								request: { text: inputId },
							}),
						).toEqual({ handedOff: false });
					expect(fixture.dispatches).toEqual([]);
					expect(
						(yield* fixture.read.listSessionInfos({
							projectIds: ["held-message-resume"],
						}))[0]?.limitRecovery,
					).toMatchObject({ scheduledAt: 10 });
					expect((yield* fixture.read.readInboxState("s1"))?.paused).toBe(true);
					if (reason === "reset") {
						yield* TestClock.setTime(10_000);
						yield* continuation.sweepDueContinuations(10);
					} else {
						fixture.setReading(usageReading("claude", { status: "unknown" }));
						yield* continuation.requestContinuation("s1", {
							instanceId: "claude",
							expectedInstanceId: "claude",
							reason: "user",
						});
					}
					expect(yield* fixture.next).toBe("first");
					expect(fixture.dispatches).toEqual(["first"]);
					yield* fixture.finish("first");
					expect(yield* fixture.next).toBe("second");
					yield* fixture.finish("second");
					expect(fixture.dispatches).toEqual(["first", "second"]);
					const session = (yield* fixture.read.listSessionInfos({
						projectIds: ["held-message-resume"],
					}))[0];
					expect(session?.limitRecovery).toBeNull();
					expect(session?.resumes).toMatchObject([
						{ instanceId: "claude", reason },
					]);
					expect(
						(yield* fixture.read.readPendingInputs("s1", {
							through: Number.MAX_SAFE_INTEGER,
						})).rows,
					).toEqual([]);
					yield* fixture.artifact(`held-only-${reason}`);
				}).pipe(
					Effect.provideService(Usage, fixture.usage),
					Effect.provideService(ProviderTurnServiceTag, fixture.turns),
				),
			),
	);
}

it.effect("sends immediately when the Usage Reading cannot tell", () =>
	withHeldMessages((fixture) =>
		Effect.gen(function* () {
			fixture.setReading(usageReading("claude", { status: "unknown" }));
			const { inbox } = yield* fixture.makeInbox;
			yield* inbox.start;
			expect(
				yield* inbox.submit({
					clientId: "c1",
					sessionId: "s1",
					inputId: "immediate",
					delivery: "queue",
					request: { text: "immediate" },
				}),
			).toEqual({ handedOff: true });
			expect(yield* fixture.next).toBe("immediate");
			yield* fixture.finish("immediate");
			expect(fixture.dispatches).toEqual(["immediate"]);
			expect(
				(yield* fixture.read.listSessionInfos({
					projectIds: ["held-message-resume"],
				}))[0]?.limitRecovery,
			).toBeNull();
			yield* fixture.artifact("held-only-unknown");
		}),
	),
);

it.effect(
	"keeps a held-only schedule cancelled across advances and reconstruction until a new send",
	() =>
		withHeldMessages((fixture) =>
			Effect.gen(function* () {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const { inbox, continuation } = yield* fixture.makeInbox;
						yield* inbox.start;
						yield* inbox.submit({
							clientId: "c1",
							sessionId: "s1",
							inputId: "first",
							delivery: "queue",
							request: { text: "first" },
						});
						yield* continuation.cancelContinuation("s1");
					}),
				);
				const { inbox, continuation } = yield* fixture.makeInbox;
				yield* inbox.start;
				yield* TestClock.setTime(10_000);
				yield* continuation.sweepDueContinuations(10);
				yield* fixture.commit([
					canonicalEvent("session.status", "s1", {
						sessionId: "s1",
						status: "idle",
					}),
				]);
				yield* Effect.yieldNow.pipe(Effect.repeat(Schedule.recurs(10)));
				expect(fixture.dispatches).toEqual([]);
				expect(
					(yield* fixture.read.listSessionInfos({
						projectIds: ["held-message-resume"],
					}))[0]?.limitRecovery?.scheduledAt,
				).toBeUndefined();
				expect(
					(yield* fixture.store.readAllBySession("s1")).filter(
						(event) => event.type === "session.resume_scheduled",
					),
				).toHaveLength(1);
				yield* inbox.submit({
					clientId: "c1",
					sessionId: "s1",
					inputId: "second",
					delivery: "queue",
					request: { text: "second" },
				});
				// An explicit send keeps its existing priority over a paused queue.
				expect(yield* fixture.next).toBe("second");
				yield* fixture.finish("second");
				expect(yield* fixture.next).toBe("first");
				yield* fixture.finish("first");
				expect(fixture.dispatches).toEqual(["second", "first"]);
				yield* fixture.artifact("held-only-cancelled");
			}).pipe(
				Effect.provideService(Usage, fixture.usage),
				Effect.provideService(ProviderTurnServiceTag, fixture.turns),
			),
		),
);
