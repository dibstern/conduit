/** Claude daemon launch composition; live SDK state belongs to the runner payload. */
import { join } from "node:path";
import { Context, Effect, Layer, Option, type Scope } from "effect";
import { accountsStateFromConfig } from "../../account-directory.js";
import { defaultDaemonConfig } from "../../daemon/config-persistence.js";
import { makeAccountResourceScopesLive } from "../../domain/daemon/Layers/account-resource-scopes-layer.js";
import { AccountDirectory } from "../../domain/daemon/Services/account-directory.js";
import { AccountResourceScopesTag } from "../../domain/daemon/Services/account-resource-scopes.js";
import { ProviderInstanceFailure } from "../errors.js";
import { ClaudeBoundaryError } from "../event-sink-errors.js";
import {
	makeRunnerProviderInstance,
	type RunnerProviderInstance,
	type RunnerProviderInstanceDeps,
} from "../runner/runner-provider-instance.js";
import {
	ClaudeAccountScopes,
	makeClaudeAccountScopes,
} from "./claude-account-scopes.js";
import type { ClaudeCapabilitiesService } from "./claude-capabilities-service.js";
import { makeProcessClaudeSessionRunner } from "./claude-process-session-runner.js";
import { makeClaudeRunnerDriver } from "./claude-runner-driver.js";
import type { ClaudeProviderInstanceDeps } from "./claude-runner-payload.js";
import { captureClaudeLaunchLogin } from "./claude-sdk-env.js";

export type { ClaudeOneShotQueryFactory } from "../../domain/daemon/Services/claude-one-shot.js";
export { RunnerProviderInstance as ClaudeProviderRuntime } from "../runner/runner-provider-instance.js";
export {
	type ClaudeProviderInstanceDeps,
	type ClaudeProviderRuntimeState,
	type ClaudeSessionRunnerDeps,
	makeClaudeSessionRunner,
} from "./claude-runner-payload.js";

export class ClaudeProviderRuntimeTag extends Context.Service<
	ClaudeProviderRuntimeTag,
	RunnerProviderInstance
>()("ClaudeProviderRuntime") {}

export const makeClaudeProviderRuntime = (
	deps: ClaudeProviderInstanceDeps,
): Effect.Effect<RunnerProviderInstance, never, Scope.Scope> =>
	Effect.gen(function* () {
		const directory = yield* Effect.serviceOption(AccountDirectory);
		const accounts = Option.isSome(directory)
			? directory.value.snapshot
			: (deps.accounts ??
				Effect.sync(() =>
					accountsStateFromConfig(
						defaultDaemonConfig(),
						captureClaudeLaunchLogin(process.env),
					),
				));
		const shared = yield* Effect.serviceOption(ClaudeAccountScopes);
		const sharedOwner = yield* Effect.serviceOption(AccountResourceScopesTag);
		const owner = Option.isSome(sharedOwner)
			? sharedOwner.value
			: Context.get(
					yield* Layer.build(makeAccountResourceScopesLive()),
					AccountResourceScopesTag,
				);
		const accountScopes = Option.isSome(shared)
			? shared.value
			: yield* makeClaudeAccountScopes({
					accounts,
					...(Option.isNone(directory)
						? { trustAdmission: true as const }
						: {}),
					...(deps.daemonConfigDir !== undefined
						? {
								cacheDir: join(
									deps.daemonConfigDir,
									"cache",
									"claude-capabilities",
								),
							}
						: {}),
					...(deps.capabilitiesService
						? { capabilitiesService: deps.capabilitiesService }
						: {}),
				}).pipe(Effect.provideService(AccountResourceScopesTag, owner));
		const capabilitiesService: ClaudeCapabilitiesService =
			deps.capabilitiesService ?? {
				get: (workspaceRoot, options) => {
					const call = options?.call;
					return call
						? accountScopes.use(call.account, ({ account, capabilities }) =>
								capabilities.get(workspaceRoot, {
									...options,
									call: { ...call, account },
								}),
							)
						: Effect.fail(
								new ClaudeBoundaryError({
									operation: "probeCapabilities",
									cause: new Error(
										"Claude capabilities require an admitted call",
									),
								}),
							);
				},
			};
		const driver = makeClaudeRunnerDriver(deps, accountScopes);
		const accountResources: NonNullable<
			RunnerProviderInstanceDeps["accountResources"]
		> = {
			use: (account, work) =>
				accountScopes
					.use(account, (resource) => work(resource.account))
					.pipe(
						Effect.mapError((cause) =>
							cause instanceof ClaudeBoundaryError
								? new ProviderInstanceFailure({
										providerId: "claude",
										operation: "accountScope",
										cause,
									})
								: cause,
						),
					),
		};
		return yield* makeRunnerProviderInstance(
			{
				...deps,
				accounts,
				accountResources,
				...(deps.ensureClaudeSubagentSession
					? { ensureChildSession: deps.ensureClaudeSubagentSession }
					: {}),
				...(deps.readClaudeSubagentTranscript
					? { readSubagentTranscript: deps.readClaudeSubagentTranscript }
					: {}),
			},
			driver,
			(emit) =>
				(deps.runnerFactory ?? makeProcessClaudeSessionRunner)(
					{ ...deps, accounts, capabilitiesService, accountResources },
					emit,
				),
		);
	});

export const ClaudeProviderRuntimeLive = (
	deps: ClaudeProviderInstanceDeps,
): Layer.Layer<ClaudeProviderRuntimeTag, never, Scope.Scope> =>
	Layer.effect(ClaudeProviderRuntimeTag, makeClaudeProviderRuntime(deps));
