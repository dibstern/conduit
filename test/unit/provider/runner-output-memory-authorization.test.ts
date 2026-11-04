import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import {
	getPermissionMode,
	makeOverridesStateLive,
	setPermissionMode,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";
import { makeRunnerAuthority } from "../../../src/lib/provider/runner/runner-authority.js";
import { runnerSinkId } from "../../../src/lib/provider/runner/runner-protocol.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstanceDeps,
} from "../../../src/lib/provider/runner/runner-provider-instance.js";
import {
	makeSendScopes,
	type SendScope,
} from "../../../src/lib/provider/runner/send-scope.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionRunner,
} from "../../../src/lib/provider/runner/session-runner.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";

// Failure modes: output resumes after revocation, or an asynchronous service
// lookup resumes after revocation and mutates sink/session state.
const accepted: TurnResult = {
	status: "accepted",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
};
const fixture = (deps: Partial<RunnerProviderInstanceDeps> = {}) =>
	Effect.gen(function* () {
		const configDir = configuredClaudeConfigDir("/tmp/output-authorization");
		const sendScopes = yield* makeSendScopes();
		function execute(
			command: Extract<SessionCommand, { type: "send-turn" }>,
			send: SendScope,
		): Effect.Effect<TurnResult, SessionFailure>;
		function execute(
			command: Exclude<SessionCommand, { type: "send-turn" }>,
			send?: SendScope,
		): Effect.Effect<void, SessionFailure>;
		function execute(
			command: SessionCommand,
			send: SendScope,
		): Effect.Effect<TurnResult | undefined, SessionFailure>;
		function execute(
			command: SessionCommand,
			send?: SendScope,
		): Effect.Effect<TurnResult | undefined, SessionFailure> {
			return Effect.sync(() => {
				if (command.type !== "send-turn") return undefined;
				if (send) sendScopes.dispatch(send, "runner");
				return accepted;
			});
		}
		return yield* makeRunnerProviderInstance(
			{
				accounts: Effect.succeed(accountsStateFromInstances([], configDir)),
				...deps,
			},
			{
				driverKind: "claude",
				discoverEffect: () => Effect.die("Unexpected discovery"),
				generateTextEffect: () => Effect.die("Unexpected generation"),
				prepareTurnEffect: (input) =>
					Effect.succeed({
						input: {
							...input,
							configDir,
							folderSource: "account",
							facts: { _tag: "Claude" as const },
						},
					}),
			},
			() =>
				Effect.succeed({
					sendScopes,
					hasLiveProcessEffect: () => Effect.succeed(false),
					executeEffect: execute,
				} satisfies SessionRunner),
		);
	});

describe("runner output memory authorization", () => {
	it.effect("permission override checks the grant at its memory mutation", () =>
		Effect.gen(function* () {
			const authority = yield* makeRunnerAuthority();
			const grant = (yield* authority.adopt(
				[{ runnerId: "runner", sessionId: "s" }],
				"live",
			)).grants.get("runner");
			if (!grant) return yield* Effect.die("Missing adopted grant");
			const entered = yield* Deferred.make<void>();
			const resume = yield* Deferred.make<void>();
			const output = yield* authority
				.guarded(
					grant,
					{ kind: "output" },
					Effect.gen(function* () {
						yield* Deferred.succeed(entered, undefined);
						yield* Deferred.await(resume);
						yield* setPermissionMode("s", "plan");
					}),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			yield* authority.revoke(grant, "superseded");
			yield* Deferred.succeed(resume, undefined);
			yield* Fiber.join(output);
			expect(yield* getPermissionMode("s")).toBe("ask");
		}).pipe(Effect.provide(makeOverridesStateLive())),
	);
	it.effect(
		"drops a delayed permission-mode output before updating the override or timeout",
		() =>
			Effect.gen(function* () {
				const changes: string[] = [];
				const sink = createRelayEventSink({
					sessionId: "s",
					resetTimeout: () => {
						changes.push("timeout");
					},
					applyReportedPermissionMode: () =>
						Effect.sync(() => {
							changes.push("mode");
						}),
				});
				const authority = yield* makeRunnerAuthority();
				const grant = (yield* authority.adopt(
					[{ runnerId: "runner", sessionId: "s" }],
					"live",
				)).grants.get("runner");
				if (!grant) return yield* Effect.die("Missing adopted grant");
				const entered = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				const output = yield* authority
					.guarded(
						grant,
						{ kind: "output" },
						Effect.gen(function* () {
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(resume);
							yield* sink.push({
								eventId: "mode",
								sessionId: "s",
								type: "session.permission_mode_changed",
								data: { sessionId: "s", mode: "plan" },
								providerId: "claude",
								providerRefs: {},
								rawSource: { kind: "claude.sdk" },
								createdAt: 1,
							});
						}),
					)
					.pipe(Effect.forkChild);
				yield* Deferred.await(entered);
				yield* authority.revoke(grant, "superseded");
				yield* Deferred.succeed(resume, undefined);
				yield* Fiber.join(output);
				expect(changes).toEqual([]);
			}),
	);
	it.effect(
		"does not register a permission waiter after its persistence resumes stale",
		() =>
			Effect.gen(function* () {
				let registered = 0;
				const entered = yield* Deferred.make<void>();
				const resume = yield* Deferred.make<void>();
				const sink = createRelayEventSink({
					sessionId: "s",
					persist: {
						persistEvent: () =>
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(resume)),
							),
					},
					pendingInteractions: {
						beginPermissionRequest: () =>
							Effect.sync(() => {
								registered++;
								return { awaitResponse: Effect.succeed({ decision: "once" }) };
							}),
						resolvePermissionRequest: () => Effect.succeed(true),
						beginQuestionRequest: () =>
							Effect.succeed({ awaitAnswers: Effect.succeed({}) }),
						resolveQuestionRequest: () => Effect.succeed(true),
					},
				});
				const authority = yield* makeRunnerAuthority();
				const grant = (yield* authority.adopt(
					[{ runnerId: "runner", sessionId: "s" }],
					"live",
				)).grants.get("runner");
				if (!grant) return yield* Effect.die("Missing adopted grant");
				const output = yield* authority
					.guarded(
						grant,
						{ kind: "output" },
						sink.requestPermission({
							requestId: "permission",
							toolName: "Bash",
							toolInput: { command: "pwd" },
							sessionId: "s",
							turnId: "turn",
							providerItemId: "tool",
						}),
					)
					.pipe(Effect.exit, Effect.forkChild);
				yield* Deferred.await(entered);
				yield* authority.revoke(grant, "superseded");
				yield* Deferred.succeed(resume, undefined);
				yield* Fiber.join(output);
				expect(registered).toBe(0);
			}),
	);
	it.effect("rechecks authorization after resolving a subagent service", () =>
		Effect.gen(function* () {
			let changed = false;
			const resolving = yield* Deferred.make<void>();
			const resume = yield* Deferred.make<void>();
			const provider = yield* fixture({
				recoveryForSession: () =>
					Deferred.succeed(resolving, undefined).pipe(
						Effect.andThen(Deferred.await(resume)),
						Effect.as(undefined),
					),
				ensureChildSession: () =>
					Effect.sync(() => {
						changed = true;
					}),
			});
			yield* provider.sendTurnEffect({
				sessionId: "s",
				inputId: "input",
				prompt: "Hello",
				history: [],
				providerState: {},
				workspaceRoot: "/tmp",
				extraFolders: [],
				eventSink: createRelayEventSink({ sessionId: "s" }),
				abortSignal: new AbortController().signal,
			});
			const authority = yield* makeRunnerAuthority();
			const grant = (yield* authority.adopt(
				[{ runnerId: "runner", sessionId: "s" }],
				"live",
			)).grants.get("runner");
			if (!grant) return yield* Effect.die("Missing adopted grant");
			const output = yield* authority
				.guarded(
					grant,
					{ kind: "output" },
					provider.handleOutputEffect({
						type: "ensure-subagent-session",
						sinkId: runnerSinkId("input"),
						input: {
							childSessionId: "child",
							parentSessionId: "s",
							providerSessionId: "native-child",
							title: "Child",
						},
					}),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(resolving);
			yield* authority.revoke(grant, "superseded");
			yield* Deferred.succeed(resume, undefined);
			yield* Fiber.join(output);
			expect(changed).toBe(false);
		}),
	);
});
