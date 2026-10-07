import { SqlClient } from "@effect/sql";
import { Context, Effect, Layer, Schema } from "effect";
import { LimitRecoverySchema } from "../../../contracts/limit-recovery.js";
import {
	type CommitAndSignalFailure,
	type CommitAndSignalProject,
	makeCommitAndSignal,
} from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../persistence/events.js";

type UsageLimitedEvent = Extract<
	CanonicalEvent,
	{ readonly type: "session.usage_limited" }
>;

export interface Continuation {
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
	return { intakeLimit, dismissCutOff, runLimitPolicy } satisfies Continuation;
});

export const ContinuationLive = Layer.effect(ContinuationTag, makeContinuation);
