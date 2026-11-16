import { randomUUID } from "node:crypto";
import { Effect, PubSub, Result } from "effect";
import { SqlClient } from "effect/sql";
import { accountRefFromSelection } from "../account-directory.js";
import type { Account, AccountRef } from "../contracts/account.js";
import type { AccountId } from "../contracts/provider-instance.js";
import { getProviderDriver } from "../contracts/provider-instance.js";
import { WorkspaceMoveError } from "../contracts/session-workspace.js";
import { DeleteNeedsConfirm } from "../contracts/ws-rpc.js";
import { saveGlobalSettings } from "../daemon/global-settings.js";
import { AccountDirectory } from "../domain/daemon/Services/account-directory.js";
import {
	DaemonEvent,
	DaemonEventBusTag,
} from "../domain/daemon/Services/daemon-pubsub.js";
import { SessionActivityTag } from "../domain/daemon/Services/session-activity.js";
import { InputDraftsTag } from "../domain/project-services/Services/input-drafts.js";
import { loadModelCatalog } from "../domain/project-services/Services/model-catalog.js";
import {
	ProjectSettingsTag,
	publishGlobalProjectSetting,
	refreshGlobalDefaults,
} from "../domain/project-services/Services/project-settings.js";
import {
	ConfigTag,
	LoggerTag,
	PollerManagerTag,
} from "../domain/project-services/Services/services.js";
import { forkSession } from "../domain/project-services/Services/session-command.js";
import type { CreateSessionOptions } from "../domain/project-services/Services/session-manager-service.js";
import {
	projectSessionManager,
	SessionManagerServiceTag,
} from "../domain/project-services/Services/session-manager-service.js";
import { clearSession as clearEffectOverrideSession } from "../domain/project-services/Services/session-overrides-state.js";
import { SessionWorkspaceTag } from "../domain/project-services/Services/session-workspace.js";
import {
	cleanupSessionWorktrees,
	prepareSessionWorktreeDeletion,
} from "../domain/project-services/Services/session-worktree-deletion.js";
import * as Failure from "../effect/failure-classification.js";
import { makeCommitAndSignal } from "../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../persistence/effect/event-store-effect.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import { loadLedger } from "../persistence/effect/run-ledger-arm.js";
import { canonicalEvent } from "../persistence/events.js";
import { messageRowsToHistory } from "../persistence/session-history-adapter.js";
import { closeConfirm } from "../provider/run-ledger/run-ledger-decider.js";
import {
	PickRequired,
	resolveTurnSettings,
} from "../provider/turn-settings.js";
import { CurrentEventDelivery } from "../server/event-delivery.js";
import type { SessionPermissionMode } from "../shared-types.js";
import { GlobalSettingsSaveError } from "./model.js";

interface ViewSessionPayload {
	readonly sessionId: string;
}

export interface NewSessionPayload {
	readonly title?: string | undefined;
	readonly instanceId?: AccountId | undefined;
	readonly providerId?: string | undefined;
	readonly permissionMode: SessionPermissionMode;
	readonly model?:
		| {
				readonly modelId: string;
				readonly providerId: string;
				readonly variant?: string | undefined;
				readonly contextWindow?: string | undefined;
		  }
		| undefined;
}

/** Resolve the composer's pick once for both draft warming and creation. */
export const resolveSessionCreationAccount = (
	input: NewSessionPayload & {
		readonly accountRef?: AccountRef | undefined;
		readonly account?: Account | undefined;
	},
) =>
	Effect.gen(function* () {
		const accounts = yield* AccountDirectory;
		return (
			input.account ??
			(yield* accounts.resolve(
				input.accountRef ??
					accountRefFromSelection({
						instanceId: input.instanceId,
						providerId: input.providerId,
						model:
							input.model === undefined
								? undefined
								: { providerID: input.model.providerId },
					}),
			))
		);
	});

export const resolveSessionCreation = (
	input: Parameters<typeof resolveSessionCreationAccount>[0],
	options: { readonly startIfStopped?: boolean } = { startIfStopped: true },
) =>
	Effect.gen(function* () {
		const account = yield* resolveSessionCreationAccount(input);
		const { model, permissionMode } = input;
		if (
			permissionMode == null ||
			!model?.modelId.trim() ||
			!model.providerId.trim()
		)
			return yield* new PickRequired();
		const catalog = yield* loadModelCatalog(
			account.driver,
			account.id,
			options,
		);
		const resolved = resolveTurnSettings(
			{
				harness: account.driver,
				model,
				effort: model.variant ?? "",
				contextWindow: model.contextWindow ?? "",
			},
			catalog,
		);
		if (Result.isFailure(resolved)) return yield* resolved.failure;
		return { account, pick: resolved.success, permissionMode };
	});

interface DeleteSessionPayload {
	readonly sessionId: string;
	readonly removeWorktrees?: boolean;
}

interface ForkSessionPayload {
	readonly sessionId?: string;
	readonly messageId?: string;
	readonly instanceId?: string;
}

const shouldStartOpenCodePoller = (sessionId: string) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;

		const rowResult = yield* Effect.result(readQuery.getSession(sessionId));
		if (rowResult._tag === "Failure") return true;

		const row = rowResult.success;
		return !row || getProviderDriver(row.provider)?.runsOpenCodeServer === true;
	});

const switchClientToSession = (
	clientId: string,
	sessionId: string,
	options?: { skipPollerSeed?: boolean },
) =>
	Effect.gen(function* () {
		if (!sessionId) return;

		const pollerManager = yield* PollerManagerTag;

		(yield* SessionActivityTag).selectSession(
			(yield* ConfigTag).slug,
			clientId,
			sessionId,
			yield* CurrentEventDelivery,
		);

		const canUseOpenCodePoller = yield* shouldStartOpenCodePoller(sessionId);
		if (
			canUseOpenCodePoller &&
			!options?.skipPollerSeed &&
			!pollerManager.isPolling(sessionId)
		) {
			const workspace = yield* Effect.serviceOption(SessionWorkspaceTag);
			const start = Effect.sync(() => pollerManager.startPolling(sessionId));
			yield* workspace._tag === "Some"
				? workspace.value.withLaunch(sessionId, start)
				: start;
		}
	});

export const viewSessionForClient = ({
	clientId,
	sessionId,
}: {
	readonly clientId: string;
	readonly sessionId: string;
}) =>
	Effect.gen(function* () {
		const log = yield* LoggerTag;

		const id = sessionId;
		if (!id) return;

		yield* switchClientToSession(clientId, id);

		// No read state here: a switch also fires on restore, reload and
		// reconnect. The browser reports a user's sidebar pick through
		// session.mark_seen instead (ADR-0004, Scope; conduit-test-hk9m.3).

		log.info(`client=${clientId} Viewing: ${id}`);
	});

export const handleViewSession = (
	clientId: string,
	payload: ViewSessionPayload,
) =>
	viewSessionForClient({
		clientId,
		sessionId: payload.sessionId,
	});

let draftWorkspaceFailureInjected = false;

export const createSessionForClient = <E = never>({
	clientId,
	title,
	instanceId,
	providerId,
	accountRef,
	account: resolvedAccount,
	model,
	permissionMode,
	directory,
	initializeWorkspace,
	sessionId,
	resolvedCreation,
	draftChange,
	draftId,
}: {
	readonly clientId: string;
	readonly title?: string;
	readonly instanceId?: AccountId;
	readonly providerId?: string;
	readonly accountRef?: AccountRef;
	readonly account?: Account;
	readonly sessionId?: string;
	readonly directory?: string;
	readonly draftChange?: CreateSessionOptions["draftChange"];
	readonly draftId?: string;
	readonly resolvedCreation?: Effect.Success<
		ReturnType<typeof resolveSessionCreation>
	>;
	readonly permissionMode: SessionPermissionMode;
	readonly model?: {
		readonly modelId: string;
		readonly providerId: string;
		readonly variant?: string | undefined;
		readonly contextWindow?: string | undefined;
	};
	readonly initializeWorkspace?: (sessionId: string) => Effect.Effect<void, E>;
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* projectSessionManager;
		const log = yield* LoggerTag;
		const { account, pick } =
			resolvedCreation ??
			(yield* resolveSessionCreation({
				instanceId,
				providerId,
				accountRef,
				account: resolvedAccount,
				model,
				permissionMode,
			}));
		const create = sessionManagerService.createSession(title, {
			account,
			pick,
			permissionMode,
			...(directory === undefined ? {} : { directory }),
			...(draftChange === undefined ? {} : { draftChange }),
			...(sessionId === undefined ? {} : { sessionId }),
		});

		return yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				// Protect the id handoff for workspace initialization, then allow
				// discovery and Git checks to be interrupted with rollback installed.
				const session = yield* initializeWorkspace || draftId !== undefined
					? create
					: restore(create);
				return yield* restore(
					Effect.gen(function* () {
						if (initializeWorkspace) yield* initializeWorkspace(session.id);
						// One-shot failure after real workspace setup and session.created.
						if (
							initializeWorkspace &&
							draftId !== undefined &&
							process.env["NODE_ENV"] === "test" &&
							!draftWorkspaceFailureInjected &&
							process.env["CONDUIT_TEST_DRAFT_WORKSPACE_FAILURE"] === draftId
						) {
							draftWorkspaceFailureInjected = true;
							yield* Effect.logError("Test Draft workspace setup failure");
							return yield* new WorkspaceMoveError({
								path: directory ?? session.directory,
								reason: "missing",
							});
						}
						yield* switchClientToSession(clientId, session.id, {
							skipPollerSeed: true,
						});
						if (model?.variant !== undefined) {
							yield* Effect.gen(function* () {
								const config = yield* ConfigTag;
								const { model: pickModel, effort } = pick;
								yield* Effect.try({
									try: () =>
										saveGlobalSettings(
											{
												defaultVariants: {
													[`${pickModel.providerId}/${pickModel.modelId}`]:
														effort,
												},
											},
											config.configDir,
										),
									catch: (cause) => new GlobalSettingsSaveError({ cause }),
								});
								const projectSettings =
									yield* Effect.serviceOption(ProjectSettingsTag);
								if (projectSettings._tag === "Some") {
									yield* publishGlobalProjectSetting("defaultModel").pipe(
										Effect.provideService(
											ProjectSettingsTag,
											projectSettings.value,
										),
									);
								} else {
									yield* refreshGlobalDefaults;
								}
							}).pipe(
								Effect.catchCause((cause) =>
									Effect.sync(() =>
										log.warn(
											`client=${clientId} session=${session.id} Failed to remember effort preference`,
											cause,
										),
									),
								),
							);
						}
						log.info(`client=${clientId} Created: ${session.id}`);
						return session;
					}),
				).pipe(
					Effect.onError(() =>
						initializeWorkspace || draftId !== undefined
							? Effect.gen(function* () {
									if (draftId !== undefined) {
										const drafts = yield* InputDraftsTag;
										yield* drafts
											.demote({ draft: draftId }, session.id)
											.pipe(Effect.orDie);
									}
									yield* sessionManagerService
										.deleteSession(session.id)
										.pipe(Effect.orDie);
								})
							: Effect.void,
					),
				);
			}),
		);
	});

export const handleNewSession = (
	clientId: string,
	payload: NewSessionPayload,
) =>
	createSessionForClient({
		clientId,
		permissionMode: payload.permissionMode,
		...(payload.title != null ? { title: payload.title } : {}),
		...(payload.instanceId != null ? { instanceId: payload.instanceId } : {}),
		...(payload.providerId != null ? { providerId: payload.providerId } : {}),
		...(payload.model === undefined ? {} : { model: payload.model }),
	}).pipe(Effect.asVoid);

export const handleSwitchSession = (
	clientId: string,
	payload: ViewSessionPayload,
) => handleViewSession(clientId, payload);

export const deleteSessionForClient = ({
	clientId,
	sessionId,
	removeWorktrees,
	confirm,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly removeWorktrees?: boolean;
	/** The snapshot entry the delete ask showed. */
	readonly confirm?: number;
}) =>
	Effect.gen(function* () {
		// 8.4 (2870-2899): a delete ends the session's background work, so with tasks live or unknown
		// it needs a confirm of the latest snapshot. The row goes away, so the browser asks before it
		// sends rather than the gate holding the step; the refusal carries the entry to confirm.
		const ledger = yield* loadLedger(sessionId);
		const snapshotEntry =
			ledger === undefined ? undefined : closeConfirm(ledger.state, confirm);
		if (snapshotEntry !== undefined)
			return yield* new DeleteNeedsConfirm({ snapshotEntry });
		// Test seam: widens the gap between this check and the delete's close.
		if (process.env["NODE_ENV"] === "test")
			yield* Effect.sleep(
				Number(process.env["CONDUIT_TEST_DELETE_CHECK_DELAY_MS"] ?? 0),
			);
		const workspace = yield* Effect.serviceOption(SessionWorkspaceTag);
		const deletion = Effect.gen(function* () {
			const sessionManagerService = yield* projectSessionManager;
			const log = yield* LoggerTag;

			const id = sessionId;
			if (!id) return [];
			const inspection = yield* prepareSessionWorktreeDeletion(id).pipe(
				Effect.map((plan) => ({ plan, warnings: [] as string[] })),
				Effect.catchCause((cause) =>
					Effect.succeed({
						plan: undefined,
						warnings: [
							`Worktrees kept because inspection failed: ${Failure.renderCause(cause).slice(0, 2_000)}`,
						],
					}),
				),
			);

			const closeCommandId = randomUUID();
			const didDelete = yield* sessionManagerService.deleteSession(id, {
				closeCommandId,
				...(confirm === undefined ? {} : { confirmed: confirm }),
			});
			if (!didDelete) {
				// 8.4 2880: a snapshot after the check above held the close, so the session stays.
				// Gap (2870-2899 give the gate no cancel): the delete withdraws its close and asks again.
				const sql = yield* SqlClient.SqlClient;
				const [held] = yield* sql<{ held: number }>`
					SELECT 1 AS held FROM provider_command_outbox
					WHERE command_id = ${closeCommandId} AND status = 'held'`;
				if (held === undefined) return [];
				const store = yield* EventStoreEffectTag;
				yield* (yield* makeCommitAndSignal).write((project) =>
					Effect.gen(function* () {
						yield* project(
							yield* store.appendBatch([
								canonicalEvent("escalation.dismissed", id, {
									commandId: closeCommandId,
								}),
							]),
						);
					}),
				);
				const latest = yield* loadLedger(id);
				const snapshotEntry =
					latest === undefined
						? undefined
						: closeConfirm(latest.state, confirm);
				if (snapshotEntry !== undefined)
					return yield* new DeleteNeedsConfirm({ snapshotEntry });
				return [];
			}

			log.info(`client=${clientId} Deleted: ${id}`);
			const warnings = inspection.warnings;
			if (
				inspection.plan?.worktrees.length &&
				(removeWorktrees ?? inspection.plan.removeWorktrees)
			) {
				warnings.push(
					...(yield* cleanupSessionWorktrees(id, inspection.plan).pipe(
						Effect.catchCause((cause) =>
							Effect.succeed([
								`Worktree cleanup failed: ${Failure.renderCause(cause).slice(0, 2_000)}`,
							]),
						),
					)),
				);
			}
			for (const warning of warnings)
				log.warn("Session deleted with worktree cleanup warning", {
					operation: "worktree.remove",
					sessionId: id,
					warning,
				});
			return warnings;
		});
		// Deletion cascades to descendants and checks every session sharing its checkouts.
		return yield* workspace._tag === "Some"
			? workspace.value.withProjectLaunch(deletion)
			: deletion;
	});

export const handleDeleteSession = (
	clientId: string,
	payload: DeleteSessionPayload,
) =>
	deleteSessionForClient({
		clientId,
		sessionId: payload.sessionId,
		...(payload.removeWorktrees === undefined
			? {}
			: { removeWorktrees: payload.removeWorktrees }),
	}).pipe(Effect.asVoid);

export const renameSessionForClient = ({
	clientId,
	sessionId,
	title,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly title: string;
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* projectSessionManager;
		const log = yield* LoggerTag;

		const id = sessionId;
		if (id && title) {
			yield* sessionManagerService.renameSession(id, title);
			log.info(`client=${clientId} Renamed: ${id} → ${title}`);
		}
	});

export const setSessionSettledForClient = ({
	clientId,
	sessionId,
	settled,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly settled: boolean;
}) =>
	Effect.gen(function* () {
		const service = yield* projectSessionManager;
		const log = yield* LoggerTag;
		if (yield* service.setSessionSettled(sessionId, { settled })) {
			const bus = yield* Effect.serviceOption(DaemonEventBusTag);
			if (bus._tag === "Some")
				yield* PubSub.publish(bus.value, DaemonEvent.DaemonSessionsChanged());
			log.info(`client=${clientId} Set settled=${settled}: ${sessionId}`);
		}
	});

export const setSessionArchivedForClient = ({
	clientId,
	sessionId,
	archived,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly archived: boolean;
}) =>
	Effect.gen(function* () {
		const service = yield* projectSessionManager;
		const log = yield* LoggerTag;
		if (
			yield* service.setSessionArchived(
				sessionId,
				archived ? { archived: true } : { archived: false },
			)
		) {
			const bus = yield* Effect.serviceOption(DaemonEventBusTag);
			if (bus._tag === "Some")
				yield* PubSub.publish(bus.value, DaemonEvent.DaemonSessionsChanged());
			log.info(`client=${clientId} Set archived=${archived}: ${sessionId}`);
		}
	});

export const setSessionPinnedForClient = ({
	clientId,
	sessionId,
	pinned,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly pinned: boolean;
}) =>
	Effect.gen(function* () {
		const service = yield* projectSessionManager;
		const log = yield* LoggerTag;
		if (yield* service.setSessionPinned(sessionId, pinned)) {
			log.info(`client=${clientId} Set pinned=${pinned}: ${sessionId}`);
		}
	});

export const setSessionAutoSettleForClient = ({
	clientId,
	sessionId,
	disabled,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly disabled: boolean;
}) =>
	Effect.gen(function* () {
		const service = yield* projectSessionManager;
		const log = yield* LoggerTag;
		if (yield* service.setSessionAutoSettleDisabled(sessionId, disabled)) {
			const bus = yield* Effect.serviceOption(DaemonEventBusTag);
			if (bus._tag === "Some")
				yield* PubSub.publish(bus.value, DaemonEvent.DaemonSessionsChanged());
			log.info(
				`client=${clientId} Set auto-settle disabled=${disabled}: ${sessionId}`,
			);
		}
	});

export const setSessionJevForClient = ({
	clientId,
	sessionId,
	jev,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly jev: "on" | "off" | null;
}) =>
	Effect.gen(function* () {
		const service = yield* projectSessionManager;
		const log = yield* LoggerTag;
		if (yield* service.setSessionJev(sessionId, jev)) {
			const bus = yield* Effect.serviceOption(DaemonEventBusTag);
			if (bus._tag === "Some")
				yield* PubSub.publish(bus.value, DaemonEvent.DaemonSessionsChanged());
			log.info(`client=${clientId} Set Jev=${jev ?? "default"}: ${sessionId}`);
		}
	});

export const setSessionDiffBaseForClient = ({
	clientId,
	sessionId,
	base,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly base: string | null;
}) =>
	Effect.gen(function* () {
		const service = yield* projectSessionManager;
		const log = yield* LoggerTag;
		if (yield* service.setSessionDiffBase(sessionId, base)) {
			const bus = yield* Effect.serviceOption(DaemonEventBusTag);
			if (bus._tag === "Some")
				yield* PubSub.publish(bus.value, DaemonEvent.DaemonSessionsChanged());
			log.info(
				`client=${clientId} Set diff base=${base ?? "launch"}: ${sessionId}`,
			);
		}
	});

export const snoozeSessionForClient = ({
	clientId,
	sessionId,
	until,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly until: number | null;
}) =>
	Effect.gen(function* () {
		const service = yield* projectSessionManager;
		const log = yield* LoggerTag;
		if (yield* service.snoozeSession(sessionId, until)) {
			log.info(`client=${clientId} Snoozed: ${sessionId}`);
		}
	});

export const unsnoozeSessionForClient = ({
	clientId,
	sessionId,
}: {
	readonly clientId: string;
	readonly sessionId: string;
}) =>
	Effect.gen(function* () {
		const service = yield* projectSessionManager;
		const log = yield* LoggerTag;
		if (yield* service.unsnoozeSession(sessionId)) {
			log.info(`client=${clientId} Unsnoozed: ${sessionId}`);
		}
	});

export const markSessionUnreadForClient = ({
	clientId,
	sessionId,
}: {
	readonly clientId: string;
	readonly sessionId: string;
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* projectSessionManager;
		const log = yield* LoggerTag;

		if (sessionId) {
			yield* sessionManagerService.markSessionUnread(sessionId);
			log.info(`client=${clientId} Marked unread: ${sessionId}`);
		}
	});

export const markSessionSeenForClient = ({
	clientId,
	sessionId,
	upTo,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly upTo: number;
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* projectSessionManager;
		const log = yield* LoggerTag;

		// A failed save leaves the row unread; the typed error goes back to the
		// caller and nothing retries it (conduit-test-hk9m.6).
		const changed = yield* sessionManagerService
			.markSessionSeen(sessionId, upTo)
			.pipe(
				Effect.tapError((error) =>
					Effect.sync(() =>
						log.warn(
							`client=${clientId} Mark seen failed: ${sessionId} up to ${upTo}`,
							error,
						),
					),
				),
			);
		if (changed) {
			log.info(`client=${clientId} Marked seen: ${sessionId} up to ${upTo}`);
		}
	});

export const markSessionReadForClient = ({
	clientId,
	sessionId,
}: {
	readonly clientId: string;
	readonly sessionId: string;
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* projectSessionManager;
		const log = yield* LoggerTag;

		if (sessionId) {
			yield* sessionManagerService.markSessionRead(sessionId);
			log.info(`client=${clientId} Marked read: ${sessionId}`);
		}
	});

export const loadMoreHistoryForSession = ({
	sessionId,
	before,
}: {
	readonly sessionId: string;
	readonly before?: string;
}) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const page = yield* readQuery.readSessionTranscriptPage(sessionId, {
			...(before ? { before } : {}),
			limit: 50,
			previewTools: true,
		});
		const { messages } = messageRowsToHistory(page.messages, {
			pageSize: page.messages.length,
		});
		return {
			sessionId,
			messages,
			hasMore: page.hasMore,
			...(page.cursor === undefined ? {} : { cursor: page.cursor }),
		};
	});

export const forkSessionForClient = ({
	clientId,
	sessionId: requestedSessionId,
	messageId,
	instanceId,
	targetProjectSlug,
	forkId,
}: {
	readonly clientId: string;
	readonly sessionId?: string;
	readonly messageId?: string;
	readonly instanceId?: string;
	readonly targetProjectSlug?: string;
	/** The fork's id, when its worktree was made first (82tn.54). */
	readonly forkId?: string;
}) =>
	Effect.gen(function* () {
		const managers = yield* SessionManagerServiceTag;
		const ownSlug = (yield* ConfigTag).slug;
		const target =
			targetProjectSlug === undefined || targetProjectSlug === ownSlug
				? undefined
				: targetProjectSlug;
		const sessionManagerService = managers.forProject(target ?? ownSlug);

		const sessionId =
			requestedSessionId ||
			(yield* SessionActivityTag).selectedSession(ownSlug, clientId) ||
			"";
		if (!sessionId) return undefined;
		const log = yield* LoggerTag;

		// Through the seam: forking upstream and forgetting to record the forked
		// session locally is the same parity gap as creating one and forgetting.
		const forked = yield* forkSession(sessionId, {
			...(messageId === undefined ? {} : { messageId }),
			...(instanceId === undefined ? {} : { instanceId }),
			...(target === undefined ? {} : { into: yield* managers.parts(target) }),
			...(forkId === undefined ? {} : { sessionId: forkId }),
		});

		yield* sessionManagerService.holdSession(forked.id);
		yield* clearEffectOverrideSession(sessionId);

		// The forking tab gets the lineage in its response; other tabs read it
		// off the family row.
		const sessions = yield* sessionManagerService.listSessions();
		const persistedFork = sessions.find((s) => s.id === forked.id);
		const forkMessageId = persistedFork?.forkMessageId ?? forked.forkMessageId;
		const forkPointTimestamp =
			persistedFork?.forkPointTimestamp ??
			("forkPointTimestamp" in forked &&
			typeof forked.forkPointTimestamp === "number"
				? forked.forkPointTimestamp
				: undefined);

		log.info(
			`client=${clientId} Forked: ${sessionId} → ${forked.id}${messageId ? ` at ${messageId}` : ""}`,
		);

		return {
			id: forked.id,
			forkedFrom: sessionId,
			projectSlug: target ?? ownSlug,
			...(forkMessageId && { forkMessageId }),
			...(forkPointTimestamp != null && { forkPointTimestamp }),
		};
	});

/** Fork a session at a specific message point (ticket 5.3). */
export const handleForkSession = (
	clientId: string,
	payload: ForkSessionPayload,
) =>
	forkSessionForClient({
		clientId,
		...(payload.sessionId != null ? { sessionId: payload.sessionId } : {}),
		...(payload.messageId != null ? { messageId: payload.messageId } : {}),
		...(payload.instanceId != null ? { instanceId: payload.instanceId } : {}),
	}).pipe(Effect.asVoid);
