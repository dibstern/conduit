import { Cause, Effect, Either, Ref } from "effect";
import type { ProviderInstanceId } from "../contracts/provider-instance.js";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../daemon/config-persistence.js";
import {
	ConfigTag,
	LoggerTag,
	PollerManagerTag,
	WebSocketHandlerTag,
} from "../domain/relay/Services/services.js";
import { forkSession } from "../domain/relay/Services/session-command.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import {
	selectSessionContextWindow,
	selectSessionModel,
	selectSessionVariant,
} from "../domain/relay/Services/session-model-settings.js";
import {
	clearSession as clearEffectOverrideSession,
	OverridesStateTag,
} from "../domain/relay/Services/session-overrides-state.js";
import { SessionWorkspaceTag } from "../domain/relay/Services/session-workspace.js";
import {
	cleanupSessionWorktrees,
	prepareSessionWorktreeDeletion,
} from "../domain/relay/Services/session-worktree-deletion.js";
import { ReadQueryEffectTag } from "../persistence/effect/read-query-effect.js";
import {
	messageRowsToHistory,
	newestRowsWithin,
	PAGE_FRAME_BUDGET,
} from "../persistence/session-history-adapter.js";
import {
	harnessForModelProvider,
	resolveTurnSettings,
} from "../provider/turn-settings.js";
import {
	loadModelCatalog,
	savedVariantFor,
	switchVariantForSession,
} from "./model.js";
import { getSessionInputDraft } from "./prompt.js";

interface ViewSessionPayload {
	readonly sessionId: string;
}

interface NewSessionPayload {
	readonly title?: string;
	readonly instanceId?: ProviderInstanceId;
	readonly providerId?: string;
}

interface DeleteSessionPayload {
	readonly sessionId: string;
	readonly removeWorktrees?: boolean;
}

interface ForkSessionPayload {
	readonly sessionId?: string;
	readonly messageId?: string;
}

const shouldStartOpenCodePoller = (sessionId: string) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;

		const rowResult = yield* Effect.either(readQuery.getSession(sessionId));
		if (rowResult._tag === "Left") return true;

		const row = rowResult.right;
		return !row || row.provider === "opencode";
	});

const switchClientToSession = (
	clientId: string,
	sessionId: string,
	options?: { skipPollerSeed?: boolean },
) =>
	Effect.gen(function* () {
		if (!sessionId) return;

		const wsHandler = yield* WebSocketHandlerTag;
		const pollerManager = yield* PollerManagerTag;

		wsHandler.setClientSession(clientId, sessionId);

		const canUseOpenCodePoller = yield* shouldStartOpenCodePoller(sessionId);
		if (
			canUseOpenCodePoller &&
			!options?.skipPollerSeed &&
			!pollerManager.isPolling(sessionId)
		) {
			pollerManager.startPolling(sessionId);
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
		if (!id) return { draft: "" };

		yield* switchClientToSession(clientId, id);

		// No read state here: a switch also fires on restore, reload and
		// reconnect. The browser reports a user's sidebar pick through
		// session.mark_seen instead (ADR-0004, Scope; conduit-test-hk9m.3).

		log.info(`client=${clientId} Viewing: ${id}`);
		return { draft: getSessionInputDraft(id) };
	});

export const handleViewSession = (
	clientId: string,
	payload: ViewSessionPayload,
) =>
	viewSessionForClient({
		clientId,
		sessionId: payload.sessionId,
	});

export const createSessionForClient = <E = never>({
	clientId,
	title,
	instanceId,
	providerId,
	model,
	initializeWorkspace,
	sessionId,
}: {
	readonly clientId: string;
	readonly title?: string;
	readonly instanceId?: ProviderInstanceId;
	readonly providerId?: string;
	readonly sessionId?: string;
	readonly model?: {
		readonly modelId: string;
		readonly providerId: string;
		readonly variant?: string | undefined;
	};
	readonly initializeWorkspace?: (sessionId: string) => Effect.Effect<void, E>;
}) =>
	Effect.gen(function* () {
		const sessionManagerService = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;
		// Validate before creating either a durable row or an upstream session.
		const picked = model
			? yield* Effect.gen(function* () {
					const config = yield* ConfigTag;
					const defaults = yield* Ref.get(yield* OverridesStateTag);
					const requestedProvider = providerId?.trim();
					const instanceHarness =
						instanceId === undefined
							? undefined
							: resolveProviderRoutingDriver(
									loadDaemonConfig(config.configDir),
									instanceId,
								);
					// Match the creator's existing explicit-instance / provider / default order.
					const harness =
						(instanceHarness === undefined
							? undefined
							: harnessForModelProvider(instanceHarness)) ??
						(requestedProvider &&
						requestedProvider !== "claude-sdk" &&
						harnessForModelProvider(requestedProvider) === "opencode"
							? "opencode"
							: harnessForModelProvider(
									defaults.defaultModel?.providerID ?? "claude",
								));
					const catalog = yield* loadModelCatalog(
						harness,
						instanceId ?? harness,
					);
					const resolved = resolveTurnSettings(
						{ harness, model, effort: model.variant ?? "", contextWindow: "" },
						catalog,
					);
					if (Either.isLeft(resolved)) return yield* resolved.left;
					const inherited = resolveTurnSettings(
						{
							...resolved.right,
							contextWindow:
								resolved.right.contextWindow || defaults.defaultContextWindow,
						},
						catalog,
					);
					const settings = Either.isRight(inherited)
						? inherited.right
						: resolved.right;
					return {
						settings,
						catalog,
						contextWindowOverride:
							resolved.right.contextWindow !== "" || Either.isLeft(inherited)
								? settings.contextWindow
								: undefined,
					};
				})
			: undefined;

		const create =
			instanceId != null || providerId != null || sessionId != null
				? sessionManagerService.createSession(title, {
						...(instanceId != null ? { instanceId } : {}),
						...(providerId != null ? { providerId } : {}),
						...(sessionId != null ? { sessionId } : {}),
					})
				: sessionManagerService.createSession(title);
		return yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				// Protect the id handoff for workspace initialization, then allow
				// discovery and Git checks to be interrupted with rollback installed.
				const session = yield* initializeWorkspace ? create : restore(create);
				return yield* restore(
					Effect.gen(function* () {
						if (initializeWorkspace) yield* initializeWorkspace(session.id);
						if (model && picked) {
							const override = {
								providerID: picked.settings.model.providerId,
								modelID: picked.settings.model.modelId,
							};
							yield* selectSessionModel(session.id, override);
							if (picked.contextWindowOverride !== undefined) {
								yield* selectSessionContextWindow(
									session.id,
									picked.contextWindowOverride,
								);
							}
							if (model.variant !== undefined) {
								yield* switchVariantForSession(
									{
										clientId,
										sessionId: session.id,
										variant: picked.settings.effort,
									},
									picked.catalog,
								);
							} else {
								const { variant: saved } = yield* savedVariantFor(
									override,
									picked.catalog,
								);
								yield* selectSessionVariant(session.id, saved);
							}
						}
						yield* switchClientToSession(clientId, session.id, {
							skipPollerSeed: true,
						});
						log.info(`client=${clientId} Created: ${session.id}`);
						return session;
					}),
				).pipe(
					Effect.onError(() =>
						initializeWorkspace
							? sessionManagerService
									.deleteSession(session.id)
									.pipe(Effect.orDie)
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
		...(payload.title != null ? { title: payload.title } : {}),
		...(payload.instanceId != null ? { instanceId: payload.instanceId } : {}),
		...(payload.providerId != null ? { providerId: payload.providerId } : {}),
	}).pipe(Effect.asVoid);

export const handleSwitchSession = (
	clientId: string,
	payload: ViewSessionPayload,
) => handleViewSession(clientId, payload);

export const deleteSessionForClient = ({
	clientId,
	sessionId,
	removeWorktrees,
}: {
	readonly clientId: string;
	readonly sessionId: string;
	readonly removeWorktrees?: boolean;
}) =>
	Effect.gen(function* () {
		const workspace = yield* Effect.serviceOption(SessionWorkspaceTag);
		const deletion = Effect.gen(function* () {
			const sessionManagerService = yield* SessionManagerServiceTag;
			const log = yield* LoggerTag;

			const id = sessionId;
			if (!id) return [];
			const inspection = yield* prepareSessionWorktreeDeletion(id).pipe(
				Effect.map((plan) => ({ plan, warnings: [] as string[] })),
				Effect.catchAllCause((cause) =>
					Effect.succeed({
						plan: undefined,
						warnings: [
							`Worktrees kept because inspection failed: ${Cause.pretty(cause).slice(0, 2_000)}`,
						],
					}),
				),
			);

			const didDelete = yield* sessionManagerService.deleteSession(id);
			if (!didDelete) return [];

			log.info(`client=${clientId} Deleted: ${id}`);
			const warnings = inspection.warnings;
			if (
				inspection.plan?.ownership.length &&
				(removeWorktrees ?? inspection.plan.removeWorktrees)
			) {
				warnings.push(
					...(yield* cleanupSessionWorktrees(id, inspection.plan).pipe(
						Effect.catchAllCause((cause) =>
							Effect.succeed([
								`Worktree cleanup failed: ${Cause.pretty(cause).slice(0, 2_000)}`,
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
		return yield* workspace._tag === "Some"
			? workspace.value.withLaunch(deletion)
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
		const sessionManagerService = yield* SessionManagerServiceTag;
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
		const service = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;
		if (yield* service.setSessionSettled(sessionId, { settled })) {
			const config = yield* Effect.serviceOption(ConfigTag);
			if (config._tag === "Some" && config.value.broadcastSessionListChanged) {
				yield* Effect.tryPromise(config.value.broadcastSessionListChanged).pipe(
					Effect.catchAll(() => Effect.void),
				);
			}
			log.info(`client=${clientId} Set settled=${settled}: ${sessionId}`);
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
		const service = yield* SessionManagerServiceTag;
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
		const service = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;
		if (yield* service.setSessionAutoSettleDisabled(sessionId, disabled)) {
			const config = yield* Effect.serviceOption(ConfigTag);
			if (config._tag === "Some" && config.value.broadcastSessionListChanged) {
				yield* Effect.tryPromise(config.value.broadcastSessionListChanged).pipe(
					Effect.catchAll(() => Effect.void),
				);
			}
			log.info(
				`client=${clientId} Set auto-settle disabled=${disabled}: ${sessionId}`,
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
		const service = yield* SessionManagerServiceTag;
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
		const service = yield* SessionManagerServiceTag;
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
		const sessionManagerService = yield* SessionManagerServiceTag;
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
		const sessionManagerService = yield* SessionManagerServiceTag;
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
		const sessionManagerService = yield* SessionManagerServiceTag;
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
		const pageMessages = newestRowsWithin(messages, PAGE_FRAME_BUDGET);
		return {
			sessionId,
			messages: pageMessages,
			hasMore: page.hasMore || pageMessages.length < messages.length,
		};
	});

export const forkSessionForClient = ({
	clientId,
	sessionId: requestedSessionId,
	messageId,
}: {
	readonly clientId: string;
	readonly sessionId?: string;
	readonly messageId?: string;
}) =>
	Effect.gen(function* () {
		const wsHandler = yield* WebSocketHandlerTag;
		const sessionManagerService = yield* SessionManagerServiceTag;

		const sessionId =
			requestedSessionId || wsHandler.getClientSession(clientId) || "";
		if (!sessionId) return undefined;
		const log = yield* LoggerTag;

		// Through the seam: forking upstream and forgetting to record the forked
		// session locally is the same parity gap as creating one and forgetting.
		const forked = yield* forkSession(
			sessionId,
			messageId === undefined ? undefined : { messageId },
		);

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
			parentId: sessionId,
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
	}).pipe(Effect.asVoid);
