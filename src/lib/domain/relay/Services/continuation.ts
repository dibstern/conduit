import { randomUUID } from "node:crypto";
import { SqlClient } from "@effect/sql";
import { Clock, Context, Effect, Layer, Queue, Ref, Schema } from "effect";
import type { AccountRef, ClaudeAccount } from "../../../contracts/account.js";
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
import { loadDaemonConfigResult } from "../../../daemon/config-persistence.js";
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
import type { SessionRow } from "../../../persistence/read-model-types.js";
import { makePrepareTurn } from "../../../provider/claude/prepare-turn.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { DaemonConfigRefTag } from "../../daemon/Services/daemon-config-ref.js";
import { Usage } from "../../daemon/Services/usage.js";
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

const previewContinuationForAccount = (
	session: Pick<SessionRow, "id" | "provider" | "limit_recovery">,
	account: ClaudeAccount,
) =>
	Effect.gen(function* () {
		const sessionId = session.id;
		const recovery =
			session.limit_recovery === null
				? null
				: Schema.decodeUnknownSync(Schema.parseJson(LimitRecoverySchema))(
						session.limit_recovery,
					);
		const contextWindow = yield* getContextWindow(sessionId);
		const prepare = yield* makePrepareTurn({
			configDir: account.folder,
			folderSource: "account",
			agent: yield* getAgent(sessionId),
			modelContextWindow: contextWindow === "1m" ? 1000000 : undefined,
			continuation:
				account.id !== session.provider && !!recovery?.cutOffMessageId,
		});
		const prepared = yield* prepare(sessionId, account.id);
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

/** The confirmation uses the same planner as delivery, without a live runner. */
export const previewContinuation = (
	sessionId: string,
	instanceId: string,
	accountRef: AccountRef = { _tag: "Id", id: instanceId },
) =>
	Effect.gen(function* () {
		const read = yield* ReadQueryEffectTag;
		const session = yield* read.getSession(sessionId);
		if (!session)
			return yield* new StaleSwitch({
				sessionId,
				expectedInstanceId: instanceId,
			});
		const directory = yield* AccountDirectory;
		const account = yield* directory.resolve(accountRef);
		const source =
			accountRef._tag === "Id" && session.provider === accountRef.id
				? account
				: yield* directory.resolve({ _tag: "Id", id: session.provider });
		if (account.driver !== "claude" || source.driver !== "claude")
			return yield* new DriverMismatch({ sessionId, instanceId });
		return yield* previewContinuationForAccount(session, account);
	});

export interface Continuation {
	readonly requestContinuation: (
		sessionId: string,
		options: {
			readonly instanceId: string;
			readonly accountRef?: AccountRef | undefined;
			readonly expectedInstanceId: string;
			readonly reason: ContinuationReason;
			/** Unix seconds. A scheduled continuation stays on the same account. */
			readonly at?: number;
			/** Inbox admission must preserve a schedule that another request won. */
			readonly onlyIfUnscheduled?: boolean;
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
		| Usage
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
	const cancelledEvent = (sessionId: string, releaseQueue = false) =>
		canonicalEvent(
			"session.resume_cancelled",
			sessionId,
			{},
			{
				provider: "claude",
				...(releaseQueue ? { metadata: { source: "inbox-reset" } } : {}),
			},
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
				yield* project(
					yield* store.appendBatch([
						cancelledEvent(
							sessionId,
							expected !== undefined && expected.cutOffMessageId === undefined,
						),
					]),
				);
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
			const read = yield* ReadQueryEffectTag;
			const initialSession = yield* read.getSession(sessionId);
			if (!initialSession)
				return yield* new StaleSwitch({
					sessionId,
					expectedInstanceId: options.expectedInstanceId,
				});
			const directory = yield* AccountDirectory;
			const accountRef: AccountRef = options.accountRef ?? {
				_tag: "Id",
				id: options.instanceId,
			};
			const account = yield* directory.resolve(accountRef);
			const source =
				accountRef._tag === "Id" && initialSession.provider === accountRef.id
					? account
					: yield* directory.resolve({
							_tag: "Id",
							id: initialSession.provider,
						});
			if (account.driver !== "claude" || source.driver !== "claude")
				return yield* new DriverMismatch({
					sessionId,
					instanceId: options.instanceId,
				});
			const checkSession = (ownRequest = false) =>
				Effect.gen(function* () {
					const session = yield* read.getSession(sessionId);
					if (!session || session.provider !== options.expectedInstanceId)
						return yield* new StaleSwitch({
							sessionId,
							expectedInstanceId: options.expectedInstanceId,
							...(session ? { actualInstanceId: session.provider } : {}),
						});
					if (
						(options.at === undefined && session.pending_rewind_message_id) ||
						(!ownRequest && requesting.has(sessionId)) ||
						(!policy &&
							options.at === undefined &&
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
											Effect.flatMap(Usage, (usage) =>
												usage
													.refresh([account.id])
													.pipe(Effect.map((readings) => readings[0])),
											),
										)
									: undefined;
							const exhausted =
								decision?.windows.filter(
									(window) =>
										(window.kind === "five_hour" ||
											window.kind === "seven_day") &&
										window.utilization >= 100,
								) ?? [];
							const limit = exhausted[0];
							const resetTimes = exhausted.map(
								(window) => Date.parse(window.resetsAt ?? "") / 1000,
							);
							const futureResets = resetTimes.filter(
								(at) => Number.isFinite(at) && (!due || at > due.now),
							);
							const resetsAt =
								futureResets.length > 0 ? Math.max(...futureResets) : undefined;
							// A cached or fresh limited result cannot re-arm past a reset it
							// explicitly says has expired. Unknown reset times keep the
							// cut-off continuation's existing retry policy.
							const limitExpired =
								due &&
								resetTimes.length > 0 &&
								resetTimes.every((at) => Number.isFinite(at) && at <= due.now);
							const turns = yield* ProviderTurnServiceTag;
							if (source.id !== account.id)
								yield* turns.holdUserTurnsForAccountSwitch(sessionId);
							const continued = yield* commit.write((project) =>
								Effect.gen(function* () {
									// A probe can take five seconds; selection and turn state must
									// still agree when the continuation is committed.
									const session = yield* checkSession(true);
									if (
										!due &&
										decision &&
										(decision.status === "limited" ||
											decision.status === "unavailable")
									)
										return yield* new AccountUnavailable({
											instanceId: account.id,
											reason:
												decision.status === "unavailable"
													? (decision.reason ?? "Claude account is unavailable")
													: `Account is still limited (${limit?.kind ?? "usage"}).`,
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
									const switched = source.id !== account.id;
									if (options.at !== undefined) {
										// A schedule resumes the limited account; it never switches.
										if (
											switched ||
											(recovery &&
												recovery.instanceId !== options.expectedInstanceId) ||
											(options.onlyIfUnscheduled &&
												recovery?.scheduledAt !== undefined)
										)
											return;
										yield* project(
											yield* store.appendBatch([
												canonicalEvent(
													"session.resume_scheduled",
													sessionId,
													{
														instanceId: session.provider,
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
									// Dismiss or a reply may have closed it while the probe ran.
									if (!switched && !recovery?.cutOffMessageId) return;
									if (
										due &&
										recovery &&
										((decision?.status === "limited" && !limitExpired) ||
											decision?.status === "unavailable")
									) {
										const event =
											decision.status === "limited" && recovery.rearms < 3
												? canonicalEvent(
														"session.resume_scheduled",
														sessionId,
														{
															instanceId: recovery.instanceId,
															at: resetsAt ?? due.now + 300,
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
										yield* previewContinuationForAccount(session, account);
										yield* applySessionCommand(
											{
												type: "session.provider_changed",
												data: {
													sessionId,
													oldProvider: session.provider,
													newProvider: account.id,
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
														instanceId: session.provider,
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
									engine.bindSession(sessionId, account.id),
								);
								yield* engine.dispatchEffect({
									type: "end_session",
									commandId: randomUUID(),
									sessionId,
									targetProviderId: continued.previousInstanceId,
									account: source,
								});
								yield* preWarmSession(sessionId, account).pipe(
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
											instanceId: account.id,
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
								account,
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
						AccountUnroutable: cancel,
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
	const readUsageLimits = Effect.gen(function* () {
		const configRef = yield* Effect.serviceOption(DaemonConfigRefTag);
		if (configRef._tag === "Some")
			return (yield* Ref.get(configRef.value)).usageLimits;
		const config = yield* ConfigTag;
		return yield* Effect.suspend(() =>
			loadDaemonConfigResult(config.configDir),
		).pipe(
			Effect.map((loaded) => loaded.usageLimits),
			Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
		);
	});
	const tryAutoSwitch = (sessionId: string) =>
		Effect.gen(function* () {
			const usageLimits = yield* readUsageLimits;
			if (!usageLimits?.autoSwitch) return false;
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
			const usage = yield* Usage;
			const instanceId = yield* usage.pickFailover(recovery.instanceId);
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
			const usageLimits = yield* readUsageLimits;
			if (!usageLimits?.autoResume) return false;
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
