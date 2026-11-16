// src/lib/provider/orchestration-wiring.ts
// Project orchestration borrows the daemon adapters and resolves ProviderCalls
// from project-owned workspace, account and shell environment state.

import { Effect, Option, Schema } from "effect";
import { AccountUnroutable } from "../contracts/limit-recovery.js";
import { SessionWorkspaceSchema } from "../contracts/session-workspace.js";
import { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import { ProjectContext } from "../domain/daemon/Services/project-context.js";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import { OrchestrationEngineTag } from "../domain/project-services/Services/services.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { effectiveSessionFolders } from "../session/session-workspace.js";
import { ProviderInstanceFailure } from "./errors.js";
import { OpenCodeProviderInstance } from "./opencode-provider-instance.js";
import type {
	OrchestrationEngine,
	ProviderCallRequest,
} from "./orchestration-engine.js";
import type {
	ProviderCommandInteractionSinkFactory,
	ProviderCommandStoreFailure,
} from "./orchestration-side-effect-reactor.js";
import {
	type ProviderRegistry,
	ProviderRegistryTag,
} from "./provider-registry.js";
import type { ProviderSessionBindingReadModel } from "./provider-session-binding-read-model.js";
import type { ProviderCall } from "./types.js";

export interface OrchestrationLayer {
	readonly engine: OrchestrationEngine;
	readonly registry: ProviderRegistry;
	readonly openCodeInstance: OpenCodeProviderInstance;
	/**
	 * Deterministic quiescence seam: drain committed-but-unexecuted provider
	 * side effects through the reactor (crash recovery / test flush). Same-process
	 * dispatch already awaits its own execution.
	 */
	drainSideEffects(
		makeInteractions?: ProviderCommandInteractionSinkFactory,
	): Effect.Effect<void, ProviderCommandStoreFailure>;
}

export const makeProviderCallContextResolver = (options: {
	readonly projectId?: string;
	readonly workspaceRoot?: string;
	readonly extraFolders?: readonly string[];
	readonly shellEnv: (
		directory: string,
	) => import("../contracts/project-shell-env.js").ProjectShellEnvSnapshot;
	readonly prepareShellEnv?: (directory: string) => Promise<boolean>;
	readonly sessionWorkspace: Pick<
		import("../domain/project-services/Services/session-workspace.js").SessionWorkspace,
		"get"
	>;
	readonly sessionBindingReadModel: ProviderSessionBindingReadModel;
}) =>
	Effect.gen(function* () {
		const accountDirectory = yield* AccountDirectory;
		const { sessionWorkspace, sessionBindingReadModel } = options;
		const read = yield* ReadQueryEffectTag;
		const projectContexts = yield* Effect.serviceOption(ProjectContext);
		const projectRoot = options.workspaceRoot ?? process.cwd();
		const getShellEnv = options.shellEnv;
		const prepareEnvironment = options.prepareShellEnv;
		return (
			request: ProviderCallRequest,
		): Effect.Effect<ProviderCall, ProviderInstanceFailure> =>
			Effect.gen(function* () {
				const ambient = yield* Effect.serviceOption(PersistenceProjectTag);
				const projectId =
					request.projectId ??
					(Option.isSome(ambient)
						? ambient.value.projectId
						: options.projectId);
				const project = Option.isSome(projectContexts)
					? yield* (
							request.projectId
								? projectContexts.value.forProject(request.projectId)
								: request.sessionId
									? projectContexts.value.forSession(request.sessionId)
									: projectContexts.value.forProject(projectId ?? "")
						).pipe(
							Effect.catchTag("ProjectNotFound", (cause) =>
								// Cleanup retains admitted folders when its project has been removed.
								// Launches still require a registered project and current environment.
								request.projectId &&
								request.workspaceRoot &&
								request.extraFolders &&
								!request.requireRoutableAccount
									? Effect.succeed({
											projectId: request.projectId,
											mainFolder: request.workspaceRoot,
											extraFolders: request.extraFolders,
											shellEnv: Object.freeze({}),
											shellConfig: undefined,
										})
									: Effect.fail(cause),
							),
						)
					: undefined;
				const mainFolder = project?.mainFolder ?? projectRoot;
				const currentAccount = yield* accountDirectory
					.resolve({
						_tag: "Id",
						id:
							request.account?.id ??
							request.providerId ??
							(yield* sessionBindingReadModel.getProviderForSession(
								request.sessionId,
							)) ??
							"opencode",
					})
					.pipe(
						Effect.catchTag("AccountUnroutable", (cause) =>
							request.account && !request.requireRoutableAccount
								? Effect.succeed({ ...request.account, env: undefined })
								: Effect.fail(cause),
						),
					);
				const matches =
					!request.account ||
					(currentAccount.id === request.account.id &&
						currentAccount.driver === request.account.driver);
				if (request.account && request.requireRoutableAccount && !matches)
					return yield* Effect.fail(
						new AccountUnroutable({
							ref: { _tag: "Id", id: request.account.id },
						}),
					);
				const account = request.account
					? {
							...request.account,
							env: matches ? currentAccount.env : undefined,
						}
					: currentAccount;
				const session = request.sessionId
					? yield* read.getSession(request.sessionId)
					: undefined;
				const workspaceRoot =
					request.workspaceRoot ??
					(session
						? yield* sessionWorkspace.get(
								request.sessionId,
								undefined,
								mainFolder,
							)
						: mainFolder);
				const workspace = session?.workspace
					? yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(SessionWorkspaceSchema),
						)(session.workspace)
					: null;
				const extraFolders =
					request.extraFolders ??
					effectiveSessionFolders(
						[
							mainFolder,
							...(project?.extraFolders ?? options.extraFolders ?? []),
						],
						workspace,
					)
						.map(({ directory }) => directory)
						.filter((directory) => directory !== workspaceRoot);
				if (!project && request.prepareShellEnv && prepareEnvironment) {
					yield* Effect.tryPromise(() =>
						prepareEnvironment(workspaceRoot),
					).pipe(
						Effect.timeoutOption("10 seconds"),
						Effect.catch(() => Effect.void),
					);
				}
				const environmentProject =
					project && Option.isSome(projectContexts)
						? workspaceRoot !== project.mainFolder || request.prepareShellEnv
							? yield* projectContexts.value.forProject(project.projectId, {
									directory: workspaceRoot,
									prepareShellEnv: request.prepareShellEnv === true,
								})
							: project
						: undefined;
				const environment = environmentProject
					? {
							env: environmentProject.shellEnv,
							declared: environmentProject.shellConfig,
						}
					: getShellEnv(workspaceRoot);
				const owner = project?.projectId ?? projectId;
				if (!owner)
					return yield* Effect.fail(
						new ProviderInstanceFailure({
							providerId: account.driver,
							operation: "resolveCallContext",
							cause: "A provider call requires its owning project",
						}),
					);
				return Object.freeze({
					projectId: owner,
					sessionId: request.sessionId,
					account,
					workspaceRoot,
					extraFolders: Object.freeze([...extraFolders]),
					shellEnv: Object.freeze({ ...environment.env }),
					shellConfig: environment.declared,
				});
			}).pipe(
				Effect.mapError((cause) =>
					cause instanceof ProviderInstanceFailure
						? cause
						: new ProviderInstanceFailure({
								providerId:
									request.account?.driver ?? request.providerId ?? "unknown",
								operation: "resolveCallContext",
								cause,
							}),
				),
			);
	});

export const getOrchestrationLayer = Effect.gen(function* () {
	const engine = yield* OrchestrationEngineTag;
	const registry = yield* ProviderRegistryTag;
	const openCodeInstance = yield* registry.getInstanceEffect("opencode");
	if (!(openCodeInstance instanceof OpenCodeProviderInstance)) {
		return yield* Effect.die(
			new Error("opencode provider is not an OpenCodeProviderInstance"),
		);
	}
	const view: OrchestrationLayer = {
		engine,
		registry,
		openCodeInstance,
		drainSideEffects: (makeInteractions) =>
			engine.drainSideEffects(makeInteractions),
	};
	return view;
});
