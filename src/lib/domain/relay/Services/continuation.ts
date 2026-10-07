import { randomUUID } from "node:crypto";
import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer, Schema } from "effect";
import {
	AccountUnavailable,
	type ContinuationError,
	type ContinuationReason,
	DriverMismatch,
	LimitRecoverySchema,
	SessionBusy,
	StaleSwitch,
} from "../../../contracts/limit-recovery.js";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
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
import { QuotaCheckTag } from "../../daemon/Services/quota-check.js";
import {
	type ProviderTurnService,
	ProviderTurnServiceTag,
} from "./provider-turn-service.js";
import { ConfigTag } from "./services.js";
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

export interface Continuation {
	readonly requestContinuation: (
		sessionId: string,
		options: {
			readonly instanceId: string;
			readonly expectedInstanceId: string;
			readonly reason: ContinuationReason;
		},
	) => Effect.Effect<
		void,
		| ContinuationError
		| CommitAndSignalFailure
		| ReadQueryEffectError
		| Effect.Effect.Error<ReturnType<ProviderTurnService["sendTurn"]>>,
		| ConfigTag
		| QuotaCheckTag
		| ProviderTurnServiceTag
		| OverridesStateTag
		| ReadQueryEffectTag
	>;
	/** The supplied projector joins runner intake's existing claimed transaction. */
	readonly intakeLimit: (
		event: UsageLimitedEvent,
		project?: CommitAndSignalProject,
	) => Effect.Effect<boolean, CommitAndSignalFailure>;
	readonly dismissCutOff: (
		sessionId: string,
	) => Effect.Effect<void, CommitAndSignalFailure>;
	/** Ingress calls this after its outer commit, for an accepted limit only. */
	readonly runLimitPolicy: (sessionId: string) => Effect.Effect<void>;
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
	const requestContinuation: Continuation["requestContinuation"] = (
		sessionId,
		options,
	) =>
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
					if (
						!session ||
						session.provider !== options.expectedInstanceId ||
						session.provider !== options.instanceId
					)
						return yield* new StaleSwitch({
							sessionId,
							expectedInstanceId: options.expectedInstanceId,
							...(session ? { actualInstanceId: session.provider } : {}),
						});
					if (
						session.status === "busy" ||
						session.status === "retry" ||
						(!ownRequest && requesting.has(sessionId)) ||
						(yield* hasActiveProcessingTimeout(sessionId))
					)
						return yield* new SessionBusy({ sessionId });
					return session;
				});
			yield* checkSession();
			yield* Effect.acquireUseRelease(
				Effect.gen(function* () {
					if (requesting.has(sessionId))
						return yield* new SessionBusy({ sessionId });
					requesting.add(sessionId);
				}),
				() =>
					Effect.gen(function* () {
						const quota = yield* QuotaCheckTag;
						const decision = yield* quota.check(options.instanceId);
						const cutOffMessageId = yield* commit.write((project) =>
							Effect.gen(function* () {
								// A probe can take five seconds; selection and turn state must
								// still agree when the continuation is committed.
								const session = yield* checkSession(true);
								if (
									decision._tag === "Limited" ||
									decision._tag === "Unavailable"
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
										: Schema.decodeUnknownSync(
												Schema.parseJson(LimitRecoverySchema),
											)(session.limit_recovery);
								// Dismiss or a reply may have closed it while the probe ran.
								if (!recovery?.cutOffMessageId) return;
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
								return recovery.cutOffMessageId;
							}),
						);
						if (!cutOffMessageId) return;
						const turns = yield* ProviderTurnServiceTag;
						const model = yield* getModel(sessionId);
						const agent = yield* getAgent(sessionId);
						const variant = yield* getVariant(sessionId);
						const contextWindow = yield* getContextWindow(sessionId);
						yield* turns.sendTurn({
							clientId: "continuation",
							commandId: randomUUID(),
							sessionId,
							text: "",
							continuation: { cutOffMessageId },
							modelUserSelected: yield* isModelUserSelected(sessionId),
							...(model ? { model } : {}),
							...(agent ? { agent } : {}),
							...(variant ? { variant } : {}),
							...(contextWindow ? { contextWindow } : {}),
						});
					}),
				() => Effect.sync(() => requesting.delete(sessionId)),
			);
		});
	// Tickets eon2.12 and eon2.13 supply these policy decisions, in this order.
	const tryAutoSwitch = (_sessionId: string) => Effect.succeed(false);
	const tryAutoResume = (_sessionId: string) => Effect.succeed(false);
	const runLimitPolicy = (sessionId: string) =>
		Effect.gen(function* () {
			if (!(yield* tryAutoSwitch(sessionId))) yield* tryAutoResume(sessionId);
		});

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
							appended ? runLimitPolicy(event.sessionId) : Effect.void,
						),
					);
	};

	const dismissCutOff: Continuation["dismissCutOff"] = (sessionId) =>
		commit.write((project) =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					cut_off: string | null;
				}>`SELECT json_extract(limit_recovery, '$.cutOffMessageId') AS cut_off FROM sessions WHERE id = ${sessionId}`;
				const cutOffMessageId = rows[0]?.cut_off;
				if (cutOffMessageId == null) return;
				yield* project(
					yield* store.appendBatch([
						canonicalEvent(
							"session.cut_off_dismissed",
							sessionId,
							{ cutOffMessageId },
							{ provider: "claude" },
						),
					]),
				);
			}),
		);
	return {
		intakeLimit,
		dismissCutOff,
		runLimitPolicy,
		requestContinuation,
	} satisfies Continuation;
});

export const ContinuationLive = Layer.effect(ContinuationTag, makeContinuation);
