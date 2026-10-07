import { randomUUID } from "node:crypto";
import { SqlClient } from "@effect/sql";
import { Clock, Context, Effect, Layer, Queue, Schema } from "effect";
import {
	AccountUnavailable,
	type ContinuationError,
	type ContinuationReason,
	DriverMismatch,
	type HandoffSummary,
	type LimitRecovery,
	LimitRecoverySchema,
	SessionBusy,
	StaleSwitch,
} from "../../../contracts/limit-recovery.js";
import {
	loadDaemonConfig,
	resolveClaudeInstanceConfigDir,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import { preWarmSession } from "../../../handlers/session-prewarm.js";
import {
	type CommitAndSignalFailure,
	type CommitAndSignalProject,
	makeCommitAndSignal,
} from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import {
	type ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../persistence/events.js";
import { makePrepareTurn } from "../../../provider/claude/prepare-turn.js";
import { QuotaCheckTag } from "../../daemon/Services/quota-check.js";
import {
	type ProviderTurnService,
	ProviderTurnServiceTag,
} from "./provider-turn-service.js";
import { ConfigTag, LoggerTag, OrchestrationEngineTag } from "./services.js";
import { applySessionCommand } from "./session-command.js";
import {
	getAgent,
	getContextWindow,
	getModel,
	getVariant,
	hasActiveProcessingTimeout,
	isModelUserSelected,
	type OverridesStateTag,
} from "./session-overrides-state.js";

type UsageLimitedEvent = Extract<
	CanonicalEvent,
	{ readonly type: "session.usage_limited" }
>;

/** The confirmation uses the same planner as delivery, without a live runner. */
export const previewContinuation = (sessionId: string, instanceId: string) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const read = yield* ReadQueryEffectTag;
		const session = yield* read.getSession(sessionId);
		const daemonConfig = loadDaemonConfig(config.configDir);
		if (!session)
			return yield* new StaleSwitch({
				sessionId,
				expectedInstanceId: instanceId,
			});
		if (
			resolveProviderRoutingDriver(daemonConfig, instanceId) !== "claude" ||
			resolveProviderRoutingDriver(daemonConfig, session.provider) !== "claude"
		)
			return yield* new DriverMismatch({ sessionId, instanceId });
		const recovery =
			session.limit_recovery === null
				? null
				: Schema.decodeUnknownSync(Schema.parseJson(LimitRecoverySchema))(
						session.limit_recovery,
					);
		const contextWindow = yield* getContextWindow(sessionId);
		const prepare = yield* makePrepareTurn({
			configDir: resolveClaudeInstanceConfigDir(daemonConfig, instanceId),
			agent: yield* getAgent(sessionId),
			modelContextWindow: contextWindow === "1m" ? 1000000 : undefined,
			continuation:
				instanceId !== session.provider && !!recovery?.cutOffMessageId,
		});
		const prepared = yield* prepare(sessionId, instanceId);
		return (
			prepared.handoff ??
			({
				included: 0,
				omitted: 0,
				firstMessageIncluded: false,
				tokens: 0,
			} satisfies HandoffSummary)
		);
	});

export interface Continuation {
	readonly requestContinuation: (
		sessionId: string,
		options: {
			readonly instanceId: string;
			readonly expectedInstanceId: string;
			readonly reason: ContinuationReason;
			/** Unix seconds. A scheduled continuation stays on the same account. */
			readonly at?: number;
		},
	) => Effect.Effect<
		void,
		| ContinuationError
		| CommitAndSignalFailure
		| ReadQueryEffectError
		| Effect.Effect.Error<ReturnType<typeof previewContinuation>>
		| Effect.Effect.Error<ReturnType<typeof applySessionCommand>>
		| Effect.Effect.Error<ReturnType<typeof preWarmSession>>
		| Effect.Effect.Error<
				ReturnType<OrchestrationEngineTag["Type"]["dispatchEffect"]>
		  >
		| Effect.Effect.Error<ReturnType<ProviderTurnService["sendTurn"]>>,
		| ConfigTag
		| QuotaCheckTag
		| ProviderTurnServiceTag
		| OverridesStateTag
		| ReadQueryEffectTag
		| Effect.Effect.Context<ReturnType<typeof previewContinuation>>
		| Effect.Effect.Context<ReturnType<typeof applySessionCommand>>
		| Effect.Effect.Context<ReturnType<typeof preWarmSession>>
	>;
	/** The supplied projector joins runner intake's existing claimed transaction. */
	readonly intakeLimit: (
		event: UsageLimitedEvent,
		project?: CommitAndSignalProject,
	) => Effect.Effect<boolean, CommitAndSignalFailure>;
	readonly dismissCutOff: (
		sessionId: string,
	) => Effect.Effect<void, CommitAndSignalFailure>;
	readonly cancelContinuation: (
		sessionId: string,
	) => Effect.Effect<void, CommitAndSignalFailure>;
	readonly sweepDueContinuations: (
		now?: number,
	) => ReturnType<Continuation["requestContinuation"]>;
	/** Ingress calls this after its outer commit, for an accepted limit only. */
	readonly queueLimitPolicy: (sessionId: string) => Effect.Effect<void>;
	/** Applies the usage-limit policy to each queued limit; the relay runs it for its lifetime. */
	readonly runLimitPolicies: Effect.Effect<
		never,
		never,
		Effect.Effect.Context<ReturnType<Continuation["requestContinuation"]>>
	>;
}

export class ContinuationTag extends Context.Tag("Continuation")<
	ContinuationTag,
	Continuation
>() {}

export const makeContinuation = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const store = yield* EventStoreEffectTag;
	const commit = yield* makeCommitAndSignal;
	const requesting = new Set<string>();
	const decodeRecovery = Schema.decodeUnknownSync(
		Schema.parseJson(LimitRecoverySchema),
	);
	const sameSchedule = (
		recovery: LimitRecovery | null,
		expected: LimitRecovery,
	) =>
		recovery?.scheduledAt === expected.scheduledAt &&
		recovery?.instanceId === expected.instanceId &&
		recovery?.cutOffMessageId === expected.cutOffMessageId;
	const cancelledEvent = (sessionId: string) =>
		canonicalEvent(
			"session.resume_cancelled",
			sessionId,
			{},
			{ provider: "claude" },
		);
	const cancelContinuation = (sessionId: string, expected?: LimitRecovery) =>
		commit.write((project) =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					limit_recovery: string | null;
				}>`SELECT limit_recovery FROM sessions WHERE id = ${sessionId}`;
				const value = rows[0]?.limit_recovery;
				const recovery = value == null ? null : decodeRecovery(value);
				if (
					recovery?.scheduledAt === undefined ||
					(expected && !sameSchedule(recovery, expected))
				)
					return;
				yield* project(yield* store.appendBatch([cancelledEvent(sessionId)]));
			}),
		);
	const stillCutOff = (sessionId: string, recovery: LimitRecovery) =>
		Effect.gen(function* () {
			if (!recovery.cutOffMessageId || recovery.continued) return false;
			const latest = yield* sql<{
				message_id: string;
			}>`SELECT json_extract(data, '$.messageId') AS message_id FROM events WHERE session_id = ${sessionId} AND type = 'message.created' AND json_extract(data, '$.role') = 'user' ORDER BY sequence DESC LIMIT 1`;
			return latest[0]?.message_id === recovery.cutOffMessageId;
		});
	const requestContinuation = (
		sessionId: string,
		options: Parameters<Continuation["requestContinuation"]>[1],
		{
			due,
			policy = false,
		}: {
			readonly due?: { readonly recovery: LimitRecovery; readonly now: number };
			/** Limit recovery can run while the cut-off turn is still ending. */
			readonly policy?: boolean;
		} = {},
	): ReturnType<Continuation["requestContinuation"]> =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const read = yield* ReadQueryEffectTag;
			const checkSession = (ownRequest = false) =>
				Effect.gen(function* () {
					const session = yield* read.getSession(sessionId);
					const daemonConfig = loadDaemonConfig(config.configDir);
					const targetDriver = resolveProviderRoutingDriver(
						daemonConfig,
						options.instanceId,
					);
					if (
						session &&
						(targetDriver !== "claude" ||
							resolveProviderRoutingDriver(daemonConfig, session.provider) !==
								targetDriver)
					)
						return yield* new DriverMismatch({
							sessionId,
							instanceId: options.instanceId,
						});
					if (!session || session.provider !== options.expectedInstanceId)
						return yield* new StaleSwitch({
							sessionId,
							expectedInstanceId: options.expectedInstanceId,
							...(session ? { actualInstanceId: session.provider } : {}),
						});
					if (
						(!ownRequest && requesting.has(sessionId)) ||
						(!policy &&
							(session.status === "busy" ||
								session.status === "retry" ||
								(yield* hasActiveProcessingTimeout(sessionId))))
					)
						return yield* new SessionBusy({ sessionId });
					if (policy) {
						const recovery =
							session.limit_recovery === null
								? null
								: decodeRecovery(session.limit_recovery);
						// Only the still-current cut-off may bypass the busy check.
						// Recheck inside the commit after quota probing as well.
						if (
							!recovery ||
							recovery.instanceId !== options.expectedInstanceId ||
							!(yield* stillCutOff(sessionId, recovery))
						)
							return yield* new StaleSwitch({
								sessionId,
								expectedInstanceId: options.expectedInstanceId,
								actualInstanceId: session.provider,
							});
					}
					return session;
				});
			const initial = yield* checkSession();
			if (due) {
				const recovery =
					initial.limit_recovery === null
						? null
						: decodeRecovery(initial.limit_recovery);
				if (!sameSchedule(recovery, due.recovery)) return;
				if (!recovery || !(yield* stillCutOff(sessionId, recovery)))
					return yield* cancelContinuation(sessionId, due.recovery);
			}
			yield* Effect.acquireUseRelease(
				Effect.gen(function* () {
					if (requesting.has(sessionId))
						return yield* new SessionBusy({ sessionId });
					requesting.add(sessionId);
				}),
				() =>
					Effect.uninterruptibleMask((restore) =>
						Effect.gen(function* () {
							// Future quota cannot be checked now. Due and immediate resumes
							// share the fresh probe and the recheck inside the commit.
							// Shutdown may interrupt the probe, but an accepted resume must
							// reach the existing turn dispatcher before this fiber stops.
							const decision =
								options.at === undefined
									? yield* restore(
											Effect.flatMap(QuotaCheckTag, (quota) =>
												quota.check(options.instanceId),
											),
										)
									: undefined;
							const turns = yield* ProviderTurnServiceTag;
							if (options.instanceId !== options.expectedInstanceId)
								yield* turns.holdUserTurnsForAccountSwitch(sessionId);
							const continued = yield* commit.write((project) =>
								Effect.gen(function* () {
									// A probe can take five seconds; selection and turn state must
									// still agree when the continuation is committed.
									const session = yield* checkSession(true);
									if (
										!due &&
										decision &&
										(decision._tag === "Limited" ||
											decision._tag === "Unavailable")
									)
										return yield* new AccountUnavailable({
											instanceId: options.instanceId,
											reason:
												decision._tag === "Unavailable"
													? decision.reason
													: `Account is still limited (${decision.rateLimitType}).`,
										});
									const recovery =
										session.limit_recovery === null
											? null
											: decodeRecovery(session.limit_recovery);
									if (due) {
										// Cancel or a replacement schedule wins while quota is pending.
										if (!sameSchedule(recovery, due.recovery)) return;
										if (
											!recovery ||
											!(yield* stillCutOff(sessionId, recovery))
										) {
											yield* project(
												yield* store.appendBatch([cancelledEvent(sessionId)]),
											);
											return;
										}
									}
									const switched = session.provider !== options.instanceId;
									// Dismiss or a reply may have closed it while the probe ran.
									if (!switched && !recovery?.cutOffMessageId) return;
									if (options.at !== undefined) {
										// A schedule resumes the limited account; it never switches.
										if (
											switched ||
											!recovery?.cutOffMessageId ||
											recovery.instanceId !== options.instanceId
										)
											return;
										yield* project(
											yield* store.appendBatch([
												canonicalEvent(
													"session.resume_scheduled",
													sessionId,
													{
														instanceId: options.instanceId,
														at: options.at,
													},
													{
														provider: "claude",
														...(policy && {
															metadata: { source: "limit-policy" },
														}),
													},
												),
											]),
										);
										return;
									}
									if (
										due &&
										recovery &&
										(decision?._tag === "Limited" ||
											decision?._tag === "Unavailable")
									) {
										const event =
											decision._tag === "Limited" && recovery.rearms < 3
												? canonicalEvent(
														"session.resume_scheduled",
														sessionId,
														{
															instanceId: options.instanceId,
															at: decision.resetsAt ?? due.now + 300,
														},
														{
															provider: "claude",
															metadata: { source: "continuation-sweep" },
														},
													)
												: cancelledEvent(sessionId);
										yield* project(yield* store.appendBatch([event]));
										return;
									}
									if (switched) {
										// Complete every refusal decision before any canonical write.
										yield* previewContinuation(sessionId, options.instanceId);
										yield* applySessionCommand(
											{
												type: "session.provider_changed",
												data: {
													sessionId,
													oldProvider: session.provider,
													newProvider: options.instanceId,
													reason: options.reason,
												},
											},
											{ project },
										);
									} else
										yield* project(
											yield* store.appendBatch([
												canonicalEvent(
													"session.resumed",
													sessionId,
													{
														reason: options.reason,
														instanceId: options.instanceId,
													},
													{ provider: "claude" },
												),
											]),
										);
									return {
										cutOffMessageId: recovery?.cutOffMessageId,
										switched,
										previousInstanceId: session.provider,
									};
								}),
							);
							if (!continued) return;
							if (continued.switched) {
								const engine = yield* OrchestrationEngineTag;
								// The durable binding is projected by provider_changed; replace
								// the engine's transient binding from the previous send too.
								yield* Effect.sync(() =>
									engine.bindSession(sessionId, options.instanceId),
								);
								yield* engine.dispatchEffect({
									type: "end_session",
									commandId: randomUUID(),
									sessionId,
									targetProviderId: continued.previousInstanceId,
								});
								yield* preWarmSession(sessionId).pipe(
									Effect.catchAll((error) =>
										Effect.flatMap(LoggerTag, (log) =>
											Effect.sync(() =>
												log.warn(
													`Could not warm switched session ${sessionId}`,
													error,
												),
											),
										),
									),
								);
								yield* commit([
									canonicalEvent(
										"session.resumed",
										sessionId,
										{
											reason: options.reason,
											instanceId: options.instanceId,
											from: continued.previousInstanceId,
										},
										{ provider: "claude" },
									),
								]);
							}
							if (!continued.cutOffMessageId) return;
							const model = yield* getModel(sessionId);
							const agent = yield* getAgent(sessionId);
							const variant = yield* getVariant(sessionId);
							const contextWindow = yield* getContextWindow(sessionId);
							yield* turns.sendTurn({
								clientId: "continuation",
								commandId: randomUUID(),
								sessionId,
								text: "",
								continuation: { cutOffMessageId: continued.cutOffMessageId },
								modelUserSelected: yield* isModelUserSelected(sessionId),
								...(model ? { model } : {}),
								...(agent ? { agent } : {}),
								...(variant ? { variant } : {}),
								...(contextWindow ? { contextWindow } : {}),
							});
						}).pipe(Effect.scoped),
					),
				() => Effect.sync(() => requesting.delete(sessionId)),
			);
		});
	const sweepDueContinuations: Continuation["sweepDueContinuations"] = (now) =>
		Effect.gen(function* () {
			const currentTime = now ?? (yield* Clock.currentTimeMillis) / 1000;
			const rows = yield* sql<{
				id: string;
				limit_recovery: string;
			}>`SELECT id, limit_recovery FROM sessions WHERE json_extract(limit_recovery, '$.scheduledAt') <= ${currentTime} ORDER BY id`;
			for (const row of rows) {
				const recovery = decodeRecovery(row.limit_recovery);
				const cancel = () => cancelContinuation(row.id, recovery);
				yield* requestContinuation(
					row.id,
					{
						instanceId: recovery.instanceId,
						expectedInstanceId: recovery.instanceId,
						reason: "reset",
					},
					{ due: { recovery, now: currentTime } },
				).pipe(
					Effect.catchTags({
						DriverMismatch: cancel,
						StaleSwitch: cancel,
						SessionBusy: cancel,
					}),
					Effect.catchAll((error) =>
						Effect.logError("Scheduled continuation failed", row.id, error),
					),
				);
			}
		});
	const tryAutoSwitch = (sessionId: string) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			if (!loadDaemonConfig(config.configDir)?.usageLimits?.autoSwitch)
				return false;
			const rows = yield* sql<{
				limit_recovery: string | null;
			}>`SELECT limit_recovery FROM sessions WHERE id = ${sessionId}`;
			const value = rows[0]?.limit_recovery;
			const recovery = value == null ? null : decodeRecovery(value);
			if (!recovery || recovery.continued) return false;
			// Continuations reuse the cut-off message. Only a newer user message
			// permits another auto-switch; event sequence survives restarts and ties.
			const latest = yield* sql<{
				type: string;
				reason: string | null;
			}>`SELECT type, json_extract(data, '$.reason') AS reason FROM events WHERE session_id = ${sessionId} AND (type = 'session.resumed' OR (type = 'message.created' AND json_extract(data, '$.role') = 'user')) ORDER BY sequence DESC LIMIT 1`;
			if (
				latest[0]?.type === "session.resumed" &&
				latest[0].reason === "auto-switch"
			)
				return false;
			const quota = yield* QuotaCheckTag;
			const instanceId = yield* quota.pickFailover(recovery.instanceId);
			if (instanceId === undefined) return false;
			yield* requestContinuation(
				sessionId,
				{
					instanceId,
					expectedInstanceId: recovery.instanceId,
					reason: "auto-switch",
				},
				{ policy: true },
			);
			return true;
		});
	const tryAutoResume = (sessionId: string) =>
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			if (!loadDaemonConfig(config.configDir)?.usageLimits?.autoResume)
				return false;
			const rows = yield* sql<{
				limit_recovery: string | null;
			}>`SELECT limit_recovery FROM sessions WHERE id = ${sessionId}`;
			const value = rows[0]?.limit_recovery;
			const recovery = value == null ? null : decodeRecovery(value);
			// No reset time leaves Try again to the user; a schedule already won.
			if (
				recovery?.resetsAt === undefined ||
				recovery.scheduledAt !== undefined
			)
				return false;
			yield* requestContinuation(
				sessionId,
				{
					instanceId: recovery.instanceId,
					expectedInstanceId: recovery.instanceId,
					reason: "reset",
					at: recovery.resetsAt,
				},
				{ policy: true },
			);
			return true;
		});
	const limits = yield* Queue.unbounded<string>();
	const queueLimitPolicy = (sessionId: string) =>
		Effect.asVoid(Queue.offer(limits, sessionId));
	// A refusal leaves the recorded limit as it is: the strip still offers its actions.
	const runLimitPolicies: Continuation["runLimitPolicies"] = Queue.take(
		limits,
	).pipe(
		Effect.flatMap((sessionId) =>
			Effect.gen(function* () {
				const switched = yield* tryAutoSwitch(sessionId).pipe(
					Effect.catchAllCause((cause) =>
						Effect.logWarning("Auto-switch refused", sessionId, cause).pipe(
							Effect.as(false),
						),
					),
				);
				if (!switched) yield* tryAutoResume(sessionId);
			}).pipe(
				Effect.catchAllCause((cause) =>
					Effect.logWarning("Usage limit policy refused", sessionId, cause),
				),
			),
		),
		Effect.forever,
	);

	const intakeLimit: Continuation["intakeLimit"] = (event, withinCommit) => {
		const append = (project: CommitAndSignalProject) =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					limit_recovery: string | null;
				}>`SELECT limit_recovery FROM sessions WHERE id = ${event.sessionId}`;
				if (!rows[0]) return false;
				const recovery =
					rows[0].limit_recovery === null
						? null
						: Schema.decodeUnknownSync(Schema.parseJson(LimitRecoverySchema))(
								rows[0].limit_recovery,
							);
				const previous = yield* sql<{
					cut_off: string;
					sequence: number;
				}>`SELECT json_extract(data, '$.cutOffMessageId') AS cut_off, sequence FROM events WHERE session_id = ${event.sessionId} AND type = 'session.usage_limited' ORDER BY sequence DESC LIMIT 1`;
				const last = previous[0];
				if (
					recovery &&
					!recovery.continued &&
					last &&
					recovery.instanceId === event.data.instanceId &&
					recovery.rateLimitType === event.data.rateLimitType &&
					last.cut_off === event.data.cutOffMessageId
				) {
					// Dismiss removes the cut-off from the row, so use its durable
					// intake identity to reject late copies without re-opening it.
					const newerTurn = yield* sql<{
						sequence: number;
					}>`SELECT sequence FROM events WHERE session_id = ${event.sessionId} AND sequence > ${last.sequence} AND type = 'message.created' AND json_extract(data, '$.role') = 'user' LIMIT 1`;
					if (newerTurn.length === 0) return false;
				}
				yield* project(yield* store.appendBatch([event]));
				return true;
			});
		return withinCommit
			? append(withinCommit)
			: commit
					.write(append)
					.pipe(
						Effect.tap((appended) =>
							appended ? queueLimitPolicy(event.sessionId) : Effect.void,
						),
					);
	};

	const dismissCutOff: Continuation["dismissCutOff"] = (sessionId) =>
		commit.write((project) =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					cut_off: string | null;
					scheduled_at: number | null;
				}>`SELECT json_extract(limit_recovery, '$.cutOffMessageId') AS cut_off, json_extract(limit_recovery, '$.scheduledAt') AS scheduled_at FROM sessions WHERE id = ${sessionId}`;
				const cutOffMessageId = rows[0]?.cut_off;
				const events = [
					...(cutOffMessageId == null
						? []
						: [
								canonicalEvent(
									"session.cut_off_dismissed",
									sessionId,
									{ cutOffMessageId },
									{ provider: "claude" },
								),
							]),
					...(rows[0]?.scheduled_at == null ? [] : [cancelledEvent(sessionId)]),
				];
				if (events.length === 0) return;
				yield* project(yield* store.appendBatch(events));
			}),
		);
	return {
		intakeLimit,
		dismissCutOff,
		cancelContinuation,
		sweepDueContinuations,
		queueLimitPolicy,
		runLimitPolicies,
		requestContinuation,
	} satisfies Continuation;
});

export const ContinuationLive = Layer.effect(ContinuationTag, makeContinuation);
