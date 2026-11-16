import { Context, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { formatErrorDetail } from "../../../errors.js";
import { realWorkspacePath } from "../../../git/worktrees.js";
import type { CommitAndSignalProject } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreError } from "../../../persistence/effect/event-store-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { ClaudeProviderInstance } from "../../../provider/claude/claude-provider-instance.js";
import { OpenCodeProviderInstance } from "../../../provider/opencode-provider-instance.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import { publishProviderRelayMessage } from "../../../provider/turn-done-publisher.js";
import type { PushNotificationSender } from "../../../server/push.js";
import type { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { ProviderAdapters } from "../../daemon/Services/provider-adapters.js";
import { SessionActivityTag } from "../../daemon/Services/session-activity.js";
import { Usage } from "../../daemon/Services/usage.js";
import { AlertLedgerLive, AlertLedgerTag } from "../Services/alert-ledger.js";
import { AlertsTag } from "../Services/alerts.js";
import { makeMessageSurfacing } from "../Services/message-surfacing.js";
import {
	makeEffectOpenCodeRuntimeIngress,
	OpenCodeHistoryReconcileTag,
	OpenCodeProcessLinkTag,
	OpenCodeRuntimeIngressTag,
} from "../Services/opencode-runtime-ingress-service.js";
import {
	PendingInteractionServiceLive,
	PendingInteractionServiceTag,
} from "../Services/pending-interaction-service.js";
import { makeProviderRuntimeIngestionLive } from "../Services/provider-runtime-ingestion-service.js";
import {
	AgentLivenessTag,
	ConfigTag,
	LoggerTag,
	type OrchestrationEngineTag,
	SessionRetriesTag,
} from "../Services/services.js";
import { loadServerSessionPick } from "../Services/session-pick.js";
import {
	makeSessionOpenCodeClient,
	SessionWorkspaceTag,
} from "../Services/session-workspace.js";

/**
 * One project's ingestion side (82tn.16): pending interactions, the alert
 * ledger and provider runtime ingestion. The daemon builds it once per project
 * generation; a relay outside the registry builds its own.
 */
export const makeProjectIngestionLive = (
	push: Effect.Effect<Option.Option<Pick<PushNotificationSender, "sendToAll">>>,
) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const ledger = yield* AlertLedgerTag;
			const alerts = yield* AlertsTag;
			const sql = yield* SqlClient.SqlClient;
			const log = yield* LoggerTag;
			const { slug } = yield* ConfigTag;
			const workspace = yield* SessionWorkspaceTag;
			const activity = yield* SessionActivityTag;
			const warnMove = (sessionId: string, path: string, reason: string) =>
				Effect.sync(() =>
					log.warn("Invalid agent workspace move", { sessionId, path, reason }),
				);
			return makeProviderRuntimeIngestionLive({
				pendingInteractions: yield* PendingInteractionServiceTag,
				usage: yield* Usage,
				workspaceChanged: (event) =>
					Effect.gen(function* () {
						const { path, source } = event.data;
						if (source === "start") {
							const recorded = yield* workspace.get(event.sessionId);
							const current = yield* realWorkspacePath(recorded).pipe(
								Effect.orElseSucceed(() => recorded),
							);
							// The common case needs no history query, git discovery or cache refresh.
							if (current === path) return;
							if (
								(yield* workspace.claudeWorktreeState(event.sessionId))
									.pendingUserMove
							)
								return;
						}
						const target = yield* workspace.resolve(
							event.sessionId,
							path,
							"agent",
						);
						return (project: CommitAndSignalProject) =>
							Effect.gen(function* () {
								// A user can move while resolution is in flight. Recheck intent under
								// the commit permit before recording the declaration.
								const state = yield* workspace.claudeWorktreeState(
									event.sessionId,
								);
								if (
									state.pendingUserMove &&
									target.path !== state.requestedPath
								)
									return;
								yield* workspace.record(event.sessionId, target, "agent", {
									project,
								});
							}).pipe(
								Effect.catchTag("WorkspaceMoveError", (error) =>
									warnMove(event.sessionId, path, error.reason),
								),
								Effect.mapError(
									(cause) =>
										new EventStoreError({
											operation: "workspace.changed",
											cause,
										}),
								),
							);
					}).pipe(
						Effect.catchTag("WorkspaceMoveError", (error) =>
							Effect.as(
								warnMove(event.sessionId, event.data.path, error.reason),
								undefined,
							),
						),
						Effect.mapError(
							(cause) =>
								new EventStoreError({ operation: "workspace.changed", cause }),
						),
					),
				relayPublisher: {
					publish: (msg) =>
						Effect.gen(function* () {
							const pushManager = Option.getOrUndefined(yield* push);
							// A browser on the daemon socket counts as a viewer (82tn.16).
							yield* publishProviderRelayMessage(msg, {
								isViewed: activity.hasViewers,
								log,
								slug,
								...(pushManager ? { pushManager } : {}),
								activityOf: (sessionId) =>
									activity.background.activityOf(sessionId, {
										approvals: 0,
										questions: 0,
									}),
							});
						}).pipe(
							Effect.provideService(SqlClient.SqlClient, sql),
							Effect.provideService(AlertLedgerTag, ledger),
							Effect.provideService(AlertsTag, alerts),
						),
				},
				compactions: activity.compactions,
				retries: activity.retries,
				goals: activity.goals,
				surfacing: yield* makeMessageSurfacing,
			});
		}),
	).pipe(
		Layer.provideMerge(
			Layer.merge(PendingInteractionServiceLive, AlertLedgerLive),
		),
	);

/** Reads a session's messages from the OpenCode instance that owns it. */
export const makeReadOpenCodeMessages = Effect.map(
	makeSessionOpenCodeClient,
	(sessionClient) =>
		(
			sessionId: string,
			instanceId?: string,
			signal?: AbortSignal,
			directory?: string,
		) =>
			Effect.gen(function* () {
				const client = yield* sessionClient(sessionId, instanceId, directory);
				if (Option.isNone(client))
					return yield* Effect.fail(
						new Error(`Session ${sessionId} has no OpenCode instance`),
					);
				return yield* Effect.tryPromise({
					try: () =>
						client.value.session.messages(
							sessionId,
							signal === undefined ? undefined : { signal },
						),
					catch: (cause) => cause,
				});
			}).pipe(Effect.scoped),
);

/**
 * One project's OpenCode ingress, with the history ports its sends and detail
 * reads use. Built with the project, so the ports work before any relay starts;
 * closed with the project's scope, not a relay's.
 */
export const makeProjectOpenCodeIngressLive = Layer.effectContext(
	Effect.gen(function* () {
		const log = yield* LoggerTag;
		const readQuery = yield* ReadQueryEffectTag;
		const { registry } = yield* ProviderAdapters;
		const pickContext = yield* Effect.context<
			AccountDirectory | ConfigTag | LoggerTag | OrchestrationEngineTag
		>();
		const ingress = yield* makeEffectOpenCodeRuntimeIngress(
			log.child("opencode-runtime-ingress"),
			yield* makeReadOpenCodeMessages,
			(sessionId, messageId, compaction) => {
				const instance = registry.getInstance("opencode");
				return instance instanceof OpenCodeProviderInstance
					? instance.inputIdForUserEcho(sessionId, messageId, compaction)
					: undefined;
			},
			(instanceId, parentId) =>
				Effect.gen(function* () {
					const parent = parentId
						? yield* readQuery.getSession(parentId)
						: undefined;
					return yield* loadServerSessionPick("opencode", instanceId, parent, {
						startIfStopped: false,
					});
				}).pipe(
					Effect.provide(pickContext),
					Effect.catch((cause) =>
						Effect.sync(() => {
							log.warn("Could not resolve native OpenCode session pick", {
								instanceId,
								parentId,
								cause: formatErrorDetail(cause),
							});
							return undefined;
						}),
					),
				),
		);
		yield* Effect.addFinalizer(() => Effect.sync(() => ingress.shutdown()));
		return Context.make(OpenCodeRuntimeIngressTag, ingress).pipe(
			Context.add(OpenCodeHistoryReconcileTag, ingress),
			Context.add(OpenCodeProcessLinkTag, ingress),
		);
	}),
).pipe(
	Layer.provide(
		Layer.effect(
			SessionRetriesTag,
			Effect.map(SessionActivityTag, (activity) => activity.retries.retryingOf),
		),
	),
);

/** Whether a session's Claude process is live. */
export const AgentLivenessLive = Layer.effect(
	AgentLivenessTag,
	Effect.map(
		ProviderRegistryTag,
		(registry) => (sessionId: string) =>
			Effect.suspend(() => {
				const instance = registry.getInstance("claude");
				return instance instanceof ClaudeProviderInstance
					? instance.hasLiveProcessEffect(sessionId)
					: Effect.succeed(false);
			}),
	),
);
