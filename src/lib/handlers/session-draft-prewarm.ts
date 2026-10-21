import { Effect } from "effect";
import { PROVIDER_DRIVERS } from "../contracts/provider-instance.js";
import type { PreWarmDraft } from "../contracts/ws-rpc.js";
import { OpenCodeInstancesTag } from "../domain/daemon/Services/opencode-instances-service.js";
import { DraftPreWarmTag } from "../domain/relay/Services/draft-prewarm.js";
import {
	buildSessionLaunchInput,
	resolveLaunchFolders,
} from "../domain/relay/Services/provider-turn-dispatch.js";
import { ConfigTag, LoggerTag } from "../domain/relay/Services/services.js";
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
		const state =
			worktreePath === undefined
				? null
				: yield* workspace.preview(creation.account, worktreePath);
		const folders = yield* resolveLaunchFolders(state);
		return buildSessionLaunchInput(
			creation.account,
			creation.pick,
			creation.permissionMode,
			folders,
			yield* getDefaultAgent(),
		);
	});

/** Hints must never turn a catalog, filesystem or provider failure into a UI error. */
export const preWarmDraft = (request: typeof PreWarmDraft.payloadSchema.Type) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		yield* Effect.gen(function* () {
			if (request.worktreeBase !== undefined) return;
			const account = yield* resolveSessionCreationAccount(request);
			const drafts = yield* DraftPreWarmTag;
			if (PROVIDER_DRIVERS[account.driver].supportsNativeResume) {
				const creation = yield* resolveSessionCreation({ ...request, account });
				const launch = yield* resolveDraftLaunchInput(
					creation,
					request.worktreePath,
				);
				yield* drafts.warm(request.originId, request.draftId, {
					...launch,
					providerState: {},
				});
			} else if (PROVIDER_DRIVERS[account.driver].runsOpenCodeServer) {
				const config = yield* ConfigTag;
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
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.sync(() => log.debug(`Draft pre-warm failed: ${String(cause)}`)),
			),
		);
	});
