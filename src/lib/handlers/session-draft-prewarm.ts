import { Effect } from "effect";
import { PROVIDER_DRIVERS } from "../contracts/provider-instance.js";
import type { PreWarmDraft } from "../contracts/ws-rpc.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import { DraftPreWarmTag } from "../domain/relay/Services/draft-prewarm.js";
import {
	buildSessionLaunchInput,
	resolveLaunchFolders,
} from "../domain/relay/Services/provider-turn-dispatch.js";
import {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
} from "../domain/relay/Services/services.js";
import { getDefaultAgent } from "../domain/relay/Services/session-overrides-state.js";
import { SessionWorkspaceTag } from "../domain/relay/Services/session-workspace.js";
import {
	resolveSessionCreation,
	resolveSessionCreationAccount,
} from "./session.js";

export const resolveDraftLaunchInput = (
	creation: Effect.Success<ReturnType<typeof resolveSessionCreation>>,
	worktreePath?: string,
) =>
	Effect.gen(function* () {
		const workspace = yield* SessionWorkspaceTag;
		const config = yield* ConfigTag;
		const state =
			worktreePath === undefined
				? null
				: yield* workspace.preview(creation.account, worktreePath, config.slug);
		const folders = yield* resolveLaunchFolders(state);
		const call =
			yield* (yield* OrchestrationEngineTag).resolveCallContextEffect({
				sessionId: "",
				account: creation.account,
				workspaceRoot: folders.workspaceRoot,
				extraFolders: folders.extraFolders,
				prepareShellEnv: true,
				requireRoutableAccount: true,
			});
		return {
			...buildSessionLaunchInput(
				creation.account,
				creation.pick,
				creation.permissionMode,
				folders,
				yield* getDefaultAgent(),
			),
			...(call ? { projectId: call.projectId, shellEnv: call.shellEnv } : {}),
		};
	});

/** Hints must never turn a catalog, filesystem or provider failure into a UI error. */
export const preWarmDraft = (request: typeof PreWarmDraft.payloadSchema.Type) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		yield* Effect.gen(function* () {
			if (request.worktreeBase !== undefined) return;
			const drafts = yield* DraftPreWarmTag;
			const config = yield* ConfigTag;
			yield* drafts.warm(
				request.originId,
				request.draftId,
				config.slug,
				Effect.gen(function* () {
					const account = yield* resolveSessionCreationAccount(request);
					if (PROVIDER_DRIVERS[account.driver].supportsNativeResume) {
						const creation = yield* resolveSessionCreation({
							...request,
							account,
						});
						const launch = yield* resolveDraftLaunchInput(
							creation,
							request.worktreePath,
						);
						return {
							...launch,
							providerState: {},
						};
					} else if (PROVIDER_DRIVERS[account.driver].runsOpenCodeServer) {
						const directory = request.worktreePath ?? config.projectDir;
						const instances = yield* OpenCodeInstancesTag;
						yield* Effect.scoped(
							Effect.gen(function* () {
								const client = yield* instances.borrow(
									account.id,
									config.projectDir,
								);
								yield* resolveSessionCreation(
									{ ...request, account },
									{ startIfStopped: false },
								);
								if (directory !== config.projectDir)
									yield* drafts.warmDirectory(account.id, client, directory);
							}),
						);
					}
					return undefined;
				}),
			);
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.sync(() => log.debug(`Draft pre-warm failed: ${String(cause)}`)),
			),
		);
	});
