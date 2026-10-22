// Failure modes: a slow fork blocks unrelated folder reads; a fork inherits a
// parent's workspace before its move finishes; or a child launches before its
// workspace inheritance or Ask override finishes. Nested parent/child locks
// must also complete.

import { tmpdir } from "node:os";
import { Effect, Fiber } from "effect";
import { expect, it, vi } from "vitest";
import { AccountDirectory } from "../../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { SessionWorkspaceLive } from "../../../../src/lib/domain/relay/Layers/session-workspace-layer.js";
import { AlertsLive } from "../../../../src/lib/domain/relay/Services/alerts.js";
import { resolveSessionFolders } from "../../../../src/lib/domain/relay/Services/provider-turn-dispatch.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
} from "../../../../src/lib/domain/relay/Services/services.js";
import { forkSession } from "../../../../src/lib/domain/relay/Services/session-command.js";
import {
	getPermissionMode,
	makeOverridesStateLive,
	OverridesStateTag,
	setDefaultPermissionMode,
} from "../../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { sessionPickEvents } from "../../../../src/lib/domain/relay/Services/session-pick.js";
import { SessionWorkspaceTag } from "../../../../src/lib/domain/relay/Services/session-workspace.js";
import type {
	Message,
	SessionDetail,
} from "../../../../src/lib/instance/sdk-types.js";
import { makeCommitAndSignal } from "../../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../../src/lib/persistence/events.js";
import { OrchestrationEngine } from "../../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../../src/lib/provider/provider-registry.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeOpenCodeInstancesStub,
} from "../../../helpers/mock-factories.js";
import { partialFake } from "../../../helpers/partial-fake.js";

const projectDir = tmpdir();

const barrier = () => {
	let release = () => {};
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
};

const withWorkspace = <A, E, R>(
	use: (api: ReturnType<typeof makeMockOpenCodeAPI>) => Effect.Effect<A, E, R>,
) => {
	const api = makeMockOpenCodeAPI();
	return Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		for (const sessionId of ["parent", "unrelated"])
			yield* commit([
				canonicalEvent("session.created", sessionId, {
					sessionId,
					title: sessionId,
					provider: "opencode",
				}),
				...sessionPickEvents(sessionId, {
					harness: "opencode",
					model: { providerId: "openai", modelId: "gpt-5" },
					effort: "high",
					contextWindow: "",
				}),
			]);
		return yield* use(api);
	}).pipe(
		Effect.provide(SessionWorkspaceLive),
		Effect.provide(AlertsLive),
		Effect.provideService(OpenCodeAPITag, api),
		Effect.provideService(
			OrchestrationEngineTag,
			new OrchestrationEngine({ registry: new ProviderRegistry() }),
		),
		Effect.provideService(
			OpenCodeInstancesTag,
			makeOpenCodeInstancesStub({ opencode: api }),
		),
		Effect.provideService(OpenCodeModelServiceTag, {
			listProviders: () =>
				Effect.succeed({
					providers: [
						{
							id: "openai",
							name: "OpenAI",
							models: [{ id: "gpt-5", name: "GPT-5", variants: { high: {} } }],
						},
					],
					defaults: {},
					connected: ["openai"],
				}),
			cachedProviders: () => Effect.succeedNone,
			persistDefaultModel: () => Effect.void,
		}),
		Effect.provideService(AccountDirectory, makeMockAccountDirectory()),
		Effect.provideService(ConfigTag, makeMockConfig({ projectDir })),
		Effect.provideService(LoggerTag, makeMockLogger()),
		Effect.provide(makeOverridesStateLive()),
		Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
		Effect.scoped,
	);
};

it("resolves an unrelated session's folders while a native fork is in flight", async () => {
	await Effect.runPromise(
		withWorkspace((api) =>
			Effect.gen(function* () {
				const entered = barrier();
				const release = barrier();
				api.session.fork = vi.fn(async () => {
					entered.release();
					await release.wait;
					return partialFake<SessionDetail>({
						id: "fork-child",
						title: "Fork",
					});
				});
				const fork = yield* forkSession("parent").pipe(Effect.forkChild);
				yield* Effect.promise(() => entered.wait);
				const folders = yield* resolveSessionFolders({
					id: "unrelated",
					workspace: null,
				}).pipe(
					Effect.timeoutOption("1 second"),
					Effect.ensuring(Effect.sync(release.release)),
				);
				expect(folders).toMatchObject({
					_tag: "Some",
					value: { workspaceRoot: projectDir },
				});
				expect((yield* Fiber.join(fork)).id).toBe("fork-child");
			}),
		),
	);
});

it("sets a Side Thread's Ask mode before releasing the child's launch lock", async () => {
	await Effect.runPromise(
		withWorkspace((api) =>
			Effect.gen(function* () {
				const overrides = yield* OverridesStateTag;
				yield* setDefaultPermissionMode("acceptEdits");
				api.session.messages = vi.fn(async () => [
					partialFake<Message>({ id: "cut", time: { created: 1 } }),
				]);
				let modeOnRelease: string | undefined;
				const child = yield* forkSession("parent", {
					messageId: "cut",
					side: { title: "Question", inputId: "side-input" },
				}).pipe(
					Effect.updateService(SessionWorkspaceTag, (workspace) => ({
						...workspace,
						withLaunch: (sessionId, effect) =>
							workspace.withLaunch(
								sessionId,
								effect.pipe(
									Effect.tap(() =>
										sessionId === "parent"
											? Effect.void
											: getPermissionMode(sessionId).pipe(
													Effect.provideService(OverridesStateTag, overrides),
													Effect.tap((mode) =>
														Effect.sync(() => {
															modeOnRelease = mode;
														}),
													),
												),
									),
								),
							),
					})),
				);
				expect(yield* getPermissionMode(child.id)).toBe("ask");
				expect(modeOnRelease).toBe("ask");
			}),
		),
	);
});

it("holds the new child's launch lock until workspace inheritance finishes", async () => {
	await Effect.runPromise(
		withWorkspace(() =>
			Effect.gen(function* () {
				const workspace = yield* SessionWorkspaceTag;
				const entered = barrier();
				const release = barrier();
				let childId = "";
				const fork = yield* forkSession("parent").pipe(
					Effect.updateService(SessionWorkspaceTag, (current) => ({
						...current,
						inherit: (id, parentId, options) =>
							Effect.gen(function* () {
								childId = id;
								entered.release();
								yield* Effect.promise(() => release.wait);
								return yield* current.inherit(id, parentId, options);
							}),
					})),
					Effect.forkChild,
				);
				yield* Effect.promise(() => entered.wait);
				let readStarted = false;
				const read = yield* workspace
					.withLaunch(
						childId,
						Effect.sync(() => {
							readStarted = true;
						}),
					)
					.pipe(
						Effect.timeoutOption("50 millis"),
						Effect.ensuring(Effect.sync(release.release)),
					);
				expect(childId).not.toBe("");
				expect(read._tag).toBe("None");
				expect(readStarted).toBe(false);
				expect((yield* Fiber.join(fork)).id).toBe(childId);
			}),
		),
	);
});

it("waits for an in-flight parent move before starting its native fork", async () => {
	await Effect.runPromise(
		withWorkspace((api) =>
			Effect.gen(function* () {
				const workspace = yield* SessionWorkspaceTag;
				const entered = barrier();
				const release = barrier();
				const moved = yield* workspace
					.withLaunch(
						"parent",
						Effect.gen(function* () {
							entered.release();
							yield* Effect.promise(() => release.wait);
						}),
					)
					.pipe(Effect.forkChild);
				yield* Effect.promise(() => entered.wait);
				const fork = yield* forkSession("parent").pipe(Effect.forkChild);
				yield* Effect.sleep("50 millis");
				expect(api.session.fork).not.toHaveBeenCalled();
				release.release();
				yield* Fiber.join(moved);
				expect((yield* Fiber.join(fork)).id).toBe("ses_forked");
			}),
		),
	);
});
