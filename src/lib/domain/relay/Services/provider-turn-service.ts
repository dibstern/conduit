import { SqlClient } from "@effect/sql";
import { SqlError } from "@effect/sql/SqlError";
import {
	Context,
	Deferred,
	Effect,
	type Either,
	Exit,
	FiberMap,
	Layer,
	Option,
	PubSub,
	Schedule,
	type Scope,
	Stream,
} from "effect";
import type { Account } from "../../../contracts/account.js";
import type { ProviderRuntimeEvent } from "../../../contracts/providers/provider-runtime-event.js";
import type { InputDelivery } from "../../../contracts/stored-event.js";
import type {
	ClaudeEventPersistEffectTag,
	ClaudeEventPersistFailure,
} from "../../../persistence/effect/claude-event-persist-effect.js";
import type { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import type { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import type { ProviderStateEffectTag } from "../../../persistence/effect/provider-state-effect.js";
import type { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import {
	type CanonicalEvent,
	createEventId,
} from "../../../persistence/events.js";
import type { AccountDirectory } from "../../daemon/Services/account-directory.js";
import type { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import type { AlertsTag } from "./alerts.js";
import type {
	PendingInteractionServiceTag,
	PendingQuestion,
} from "./pending-interaction-service.js";
import {
	type ProviderRuntimeIngestionError,
	ProviderRuntimeIngestionTag,
} from "./provider-runtime-ingestion-service.js";
import {
	ProviderTurnDispatchFibersTag,
	ProviderTurnTimeoutRuntimeTag,
	sendTurn,
} from "./provider-turn-dispatch.js";
import {
	completeRecoveredQuestion,
	interruptTurn,
	prepareTurnSession,
} from "./provider-turn-session.js";
import type {
	ConfigTag,
	LoggerTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "./services.js";
import type { SessionManagerServiceTag } from "./session-manager-service.js";
import {
	clearProcessingTimeout,
	OverridesStateTag,
} from "./session-overrides-state.js";
import type { SessionTitleServiceTag } from "./session-title-service.js";

export interface ProviderTurnServiceSendInput {
	/** Continuation admission may already have resolved this immutable snapshot. */
	readonly account?: Account;
	readonly clientId: string;
	readonly commandId: string;
	readonly sessionId: string;
	readonly text: string;
	/** Hidden resumption of the original request, with no new user message. */
	readonly continuation?: { readonly cutOffMessageId: string };
	readonly images?: readonly string[];
	readonly model?: {
		readonly providerID: string;
		readonly modelID: string;
	};
	readonly agent?: string;
	readonly variant?: string;
	readonly contextWindow?: string;
	/** A steer joins the running turn, whose status and timeout already run. */
	readonly steer?: boolean;
	/** Committed with the handoff's outbox row, in one transaction. */
	readonly events?: readonly CanonicalEvent[];
	/** Return an undelivered steer to the inbox. */
	readonly onSteerDeclined?: Effect.Effect<
		void,
		SqlError | ClaudeEventPersistFailure
	>;
}

export interface ProviderTurnServicePrepareInput {
	readonly clientId: string;
	readonly commandId: string;
	readonly sessionId: string;
	readonly model?: ProviderTurnServiceSendInput["model"];
	/** Steers leave open questions for the inbox to refuse. */
	readonly delivery?: InputDelivery;
}

export interface ProviderTurnServiceInterruptInput {
	readonly clientId: string;
	readonly commandId: string;
	readonly sessionId: string;
}

// A Stop fences new handoffs until its abort settles, for at most this long.
// OpenCode's abort is session-wide, and so is a retained runner's that predates
// bound interrupts: an abort still running past the bound can hit a replacement.
export const STOP_ABORT_WAIT_MS = 30_000;

type StopFailure =
	| Effect.Effect.Error<ReturnType<typeof interruptTurn>>
	| ProviderRuntimeIngestionError
	| SqlError;

export interface ProviderTurnService {
	/** Hold user turns from the continuation's commit until its scope closes.
	 *  Acquire under the inbox session permit, so no decided handoff overlaps it. */
	readonly holdUserTurnsForAccountSwitch: (
		sessionId: string,
	) => Effect.Effect<void, never, Scope.Scope>;
	/** In-memory fences the inbox treats as busy. */
	readonly turnFences: (sessionId: string) => {
		readonly stopping: boolean;
		readonly switching: boolean;
	};
	/** The session of each fence that lifts. Subscribe before the drain's first
	 *  read; a lift is the drain's only wake-up once the fence was its sole gate. */
	readonly fenceLifts: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
	readonly completeRecoveredQuestion?: (
		question: PendingQuestion,
		result: string | null,
		answers?: Record<string, unknown>,
	) => Effect.Effect<
		void,
		Effect.Effect.Error<ReturnType<typeof completeRecoveredQuestion>>
	>;
	readonly prepareTurnSession: (
		input: ProviderTurnServicePrepareInput,
	) => Effect.Effect<
		string,
		Effect.Effect.Error<ReturnType<typeof prepareTurnSession>>,
		OverridesStateTag
	>;
	readonly sendTurn: (
		input: ProviderTurnServiceSendInput,
	) => Effect.Effect<
		void,
		Effect.Effect.Error<ReturnType<typeof sendTurn>>,
		OverridesStateTag
	>;
	/** Install the session's Stop fence and fork its abort, or join the Stop in
	 *  flight. Call under the inbox session permit: that orders the Stop against
	 *  every handoff, and its admission cut-off excludes later ones from the
	 *  abort. The returned effect awaits the stopped turn's end. */
	readonly beginStop: (
		input: ProviderTurnServiceInterruptInput,
	) => Effect.Effect<Effect.Effect<void, StopFailure>>;
}

export class ProviderTurnServiceTag extends Context.Tag("ProviderTurnService")<
	ProviderTurnServiceTag,
	ProviderTurnService
>() {}

const makeProviderTurnService = Effect.gen(function* () {
	const context = yield* Effect.context<
		| AccountDirectory
		| OpenCodeAPITag
		| WebSocketHandlerTag
		| LoggerTag
		| ConfigTag
		| SessionManagerServiceTag
		| PendingInteractionServiceTag
		| OverridesStateTag
		| OrchestrationEngineTag
		| ReadQueryEffectTag
		| ClaudeEventPersistEffectTag
		| ProviderRuntimeIngestionTag
		| AlertsTag
		| ProviderStateEffectTag
		| SessionTitleServiceTag
		| ProviderTurnDispatchFibersTag
		| SqlClient.SqlClient
		| EventStoreEffectTag
		| ProjectionRunnerEffectTag
	>();
	const runtime = yield* Effect.runtime<OverridesStateTag>();
	const overridesRef = yield* OverridesStateTag;
	const providedContext = Context.add(context, ProviderTurnTimeoutRuntimeTag, {
		runtime,
		overridesRef,
	});
	const sql = yield* SqlClient.SqlClient;
	const ingestion = yield* ProviderRuntimeIngestionTag;
	const scope = yield* Effect.scope;
	// A Stop ends with session-wide frames (idle status, done) that can trail
	// the button press. Each entry lives exactly as long as its abort worker,
	// so a fence never outlives the process, scope or call that owns it.
	const stopping = new Map<string, Deferred.Deferred<void, StopFailure>>();
	const accountSwitches = new Map<string, Deferred.Deferred<void>>();
	// In memory, so no failed write can strand input reserved behind a fence.
	const lifts = yield* PubSub.unbounded<string>();
	const lift = (sessionId: string) => PubSub.publish(lifts, sessionId);
	const abort = (
		input: ProviderTurnServiceInterruptInput,
		cutoff: Either.Either<{ turn: number; admission: number }, SqlError>,
	) =>
		Effect.gen(function* () {
			// Read under the inbox permit: a continuation admitted since is not ours.
			const { turn: lastTurn, admission } = yield* cutoff;
			const [turn] = yield* sql<{ input_id: string | null }>`
				SELECT COALESCE((SELECT json_extract(payload_json, '$.inputId')
					FROM provider_command_outbox
					WHERE session_id = ${input.sessionId} AND effect_type = 'send_turn'
					AND request_sequence <= ${admission}
					AND (json_extract(payload_json, '$.inputId') = turns.user_message_id
						OR json_extract(payload_json, '$.continuation.cutOffMessageId') = turns.user_message_id)
					ORDER BY request_sequence DESC LIMIT 1), user_message_id) AS input_id
				FROM turns WHERE session_id = ${input.sessionId} AND rowid <= ${lastTurn}
				ORDER BY requested_at DESC, rowid DESC LIMIT 1`;
			const admitted = yield* sql<{ input_id: string }>`
				SELECT json_extract(payload_json, '$.inputId') AS input_id
				FROM provider_command_outbox WHERE session_id = ${input.sessionId}
				AND effect_type = 'send_turn' AND status IN ('pending', 'running', 'retryable_failed')
				AND request_sequence <= ${admission}
				ORDER BY request_sequence DESC`;
			// SDK started precedes message placement. Include admissions even with
			// an older projected turn; the runtime confirms which one is active.
			const turnIds = [
				...new Set(
					[...admitted.map((row) => row.input_id), turn?.input_id].filter(
						(id): id is string => typeof id === "string",
					),
				),
			];
			// The Stop lasts until the stopped work ends, not until the provider
			// acknowledges it. A later admission owns whatever activity remains.
			const later = sql`EXISTS (SELECT 1 FROM provider_command_outbox
				WHERE session_id = ${input.sessionId} AND effect_type = 'send_turn'
				AND request_sequence > ${admission})`;
			// A pre-echo admission keeps the inbox busy until its executor settles.
			// Retirement must not release it while that executor can still send.
			const running = sql<{ running: number }>`SELECT NOT ${later}
				AND (EXISTS (SELECT 1 FROM turns WHERE session_id = ${input.sessionId}
						AND state IN ('pending', 'running'))
					OR EXISTS (SELECT 1 FROM sessions WHERE id = ${input.sessionId}
						AND status IN ('busy', 'retry'))) AS running`.pipe(
				Effect.map(([row]) => row?.running === 1),
			);
			const ended = yield* interruptTurn(
				input,
				turnIds.length > 0 ? turnIds : undefined,
			).pipe(
				// Polled: the predicate spans turns, session status and the outbox,
				// and no one signal covers them. Advances need the optional session
				// bus and only name projected sessions, so an admission or a direct
				// write would go unseen. The read is cheap and lasts only while stopping.
				Effect.zipRight(
					Effect.repeat(running, {
						while: (still) => still,
						schedule: Schedule.spaced("100 millis"),
					}),
				),
				Effect.timeoutOption(STOP_ABORT_WAIT_MS),
			);
			if (Option.isSome(ended) || !(yield* running)) return;
			// The provider never ended the turn. Retire it, so it holds no admission.
			const event = <K extends ProviderRuntimeEvent["type"]>(
				type: K,
				data: Record<string, unknown>,
			) => ({
				eventId: createEventId(),
				type,
				providerId: "conduit",
				sessionId: input.sessionId,
				providerRefs: {},
				rawSource: { kind: "conduit.stop-bound" },
				createdAt: Date.now(),
				data,
			});
			// The projection ends whichever turn is open, so a continuation admitted
			// since the last check would end with it. Re-check in the transaction.
			// Transaction spans can proxy the error; its cause token keeps its identity.
			const superseded = new SqlError({
				message: "Stop retirement superseded",
				cause: Symbol("Stop retirement superseded"),
			});
			yield* ingestion
				.ingestBatch(
					[
						event("turn.interrupted", { messageId: "" }),
						event("session.status", {
							sessionId: input.sessionId,
							status: "idle",
						}),
					],
					{
						beforeCommit: Effect.gen(function* () {
							const [row] = yield* sql<{
								later: number;
							}>`SELECT ${later} AS later`;
							if (row?.later === 1) return yield* Effect.fail(superseded);
						}),
					},
				)
				.pipe(
					Effect.catchIf(
						(error) =>
							error._tag === "SqlError" && error.cause === superseded.cause,
						() => Effect.void,
					),
				);
		});
	const service: ProviderTurnService = {
		holdUserTurnsForAccountSwitch: (sessionId) =>
			Effect.acquireRelease(
				Effect.gen(function* () {
					const hold = yield* Deferred.make<void>();
					accountSwitches.set(sessionId, hold);
					return hold;
				}),
				(hold) =>
					Effect.sync(() => accountSwitches.delete(sessionId)).pipe(
						Effect.zipRight(Deferred.succeed(hold, undefined)),
						Effect.zipRight(lift(sessionId)),
					),
			).pipe(Effect.asVoid),
		turnFences: (sessionId) => ({
			stopping: stopping.has(sessionId),
			switching: accountSwitches.has(sessionId),
		}),
		fenceLifts: Effect.map(PubSub.subscribe(lifts), Stream.fromQueue),
		completeRecoveredQuestion: (question, result, answers) =>
			completeRecoveredQuestion(question, result, answers).pipe(
				Effect.provide(providedContext),
			),
		prepareTurnSession: (input) =>
			Effect.gen(function* () {
				// Outside the inbox permit, so waiting cannot stall the switch's handoff.
				const switching = accountSwitches.get(input.sessionId);
				if (switching) yield* Deferred.await(switching);
				return yield* prepareTurnSession(input);
			}).pipe(Effect.provide(providedContext)),
		sendTurn: (input) =>
			// The handoff arms a non-steer turn's timeout; a failure that escapes
			// the dispatch must not leave it to fire on an idle session.
			sendTurn(input).pipe(
				Effect.onError(() =>
					input.steer ? Effect.void : clearProcessingTimeout(input.sessionId),
				),
				Effect.provide(providedContext),
			),
		beginStop: (input) =>
			Effect.uninterruptible(
				Effect.gen(function* () {
					const existing = stopping.get(input.sessionId);
					if (existing) return Deferred.await(existing);
					const cutoff = yield* sql<{ turn: number; admission: number }>`SELECT
						(SELECT COALESCE(MAX(rowid), 0) FROM turns
							WHERE session_id = ${input.sessionId}) AS turn,
						(SELECT COALESCE(MAX(request_sequence), 0) FROM provider_command_outbox
							WHERE session_id = ${input.sessionId}) AS admission`.pipe(
						Effect.map(([row]) => row ?? { turn: 0, admission: 0 }),
						Effect.either,
					);
					const done = yield* Deferred.make<void, StopFailure>();
					stopping.set(input.sessionId, done);
					yield* abort(input, cutoff).pipe(
						Effect.onExit((exit) =>
							Effect.sync(() => stopping.delete(input.sessionId)).pipe(
								Effect.zipRight(Deferred.done(done, exit)),
								// Scope close interrupts the worker; nothing is left to drain.
								Effect.zipRight(
									Exit.isInterrupted(exit)
										? Effect.void
										: lift(input.sessionId),
								),
							),
						),
						Effect.provide(providedContext),
						Effect.interruptible,
						Effect.forkIn(scope),
					);
					return Deferred.await(done);
				}),
			),
	};
	return service;
});

const ProviderTurnDispatchFibersLive = Layer.scoped(
	ProviderTurnDispatchFibersTag,
	FiberMap.make<string, void, unknown>(),
);

export const ProviderTurnServiceLive: Layer.Layer<
	ProviderTurnServiceTag,
	never,
	| AccountDirectory
	| OpenCodeAPITag
	| WebSocketHandlerTag
	| LoggerTag
	| ConfigTag
	| SessionManagerServiceTag
	| PendingInteractionServiceTag
	| OverridesStateTag
	| OrchestrationEngineTag
	| ReadQueryEffectTag
	| ClaudeEventPersistEffectTag
	| ProviderRuntimeIngestionTag
	| AlertsTag
	| ProviderStateEffectTag
	| SessionTitleServiceTag
	| SqlClient.SqlClient
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
> = Layer.scoped(ProviderTurnServiceTag, makeProviderTurnService).pipe(
	Layer.provide(ProviderTurnDispatchFibersLive),
);
