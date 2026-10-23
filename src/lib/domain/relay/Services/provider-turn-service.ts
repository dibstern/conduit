import {
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	FiberMap,
	Layer,
	Option,
	PubSub,
	type Result,
	Schedule,
	type Scope,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { Account } from "../../../contracts/account.js";
import type { AttachmentRef } from "../../../contracts/attachment-ref.js";
import type { InputDelivery } from "../../../contracts/stored-event.js";
import type {
	ClaudeEventPersistEffectTag,
	ClaudeEventPersistFailure,
} from "../../../persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import type { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import type { ProviderStateEffectTag } from "../../../persistence/effect/provider-state-effect.js";
import type { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import type { CanonicalEvent } from "../../../persistence/events.js";
import { ProviderInstanceFailure } from "../../../provider/errors.js";
import { settleSessionRuns } from "../../../provider/session-run-settlement.js";
import type { AccountDirectory } from "../../daemon/Services/account-directory.js";
import type { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
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
	sendTurn,
} from "./provider-turn-dispatch.js";
import {
	completeRecoveredQuestion,
	interruptTurn,
	prepareStop,
	prepareTurnSession,
	STOP_ABORT_WAIT_MS,
} from "./provider-turn-session.js";
import type { ConfigTag, LoggerTag, WebSocketHandlerTag } from "./services.js";
import { OrchestrationEngineTag } from "./services.js";
import { SessionInboxTag } from "./session-inbox.js";
import type { SessionManagerServiceTag } from "./session-manager-service.js";
import {
	clearProcessingTimeout,
	type OverridesStateTag,
} from "./session-overrides-state.js";
import type { SessionTitleServiceTag } from "./session-title-service.js";
import type { SessionWorkspaceTag } from "./session-workspace.js";

export interface ProviderTurnServiceSendInput {
	readonly draftChange?: import("./input-drafts.js").DraftChange;
	/** Continuation admission may already have resolved this immutable snapshot. */
	readonly account?: Account;
	readonly clientId: string;
	readonly commandId: string;
	readonly sessionId: string;
	readonly text: string;
	/** Hidden resumption of the original request, with no new user message. */
	readonly continuation?: { readonly cutOffMessageId: string };
	readonly images?: readonly AttachmentRef[];
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
export { STOP_ABORT_WAIT_MS };

type StopFailure =
	| Effect.Error<ReturnType<typeof interruptTurn>>
	| Effect.Error<ReturnType<typeof prepareStop>>
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
		Effect.Error<ReturnType<typeof completeRecoveredQuestion>>
	>;
	readonly prepareTurnSession: (
		input: ProviderTurnServicePrepareInput,
	) => Effect.Effect<
		string,
		Effect.Error<ReturnType<typeof prepareTurnSession>>,
		OverridesStateTag | SessionInboxTag
	>;
	readonly sendTurn: (
		input: ProviderTurnServiceSendInput,
	) => Effect.Effect<
		void,
		Effect.Error<ReturnType<typeof sendTurn>>,
		OverridesStateTag
	>;
	/** Install the session's Stop fence and fork its abort, or join the Stop in
	 *  flight. Call under the inbox session permit: that orders the Stop against
	 *  every handoff, and its admission cut-off excludes later ones from the
	 *  abort. Every caller awaits the same stopped turn's end or interrupt failure. */
	readonly beginStop: (
		input: ProviderTurnServiceInterruptInput,
	) => Effect.Effect<Effect.Effect<void, StopFailure>>;
}

export class ProviderTurnServiceTag extends Context.Service<
	ProviderTurnServiceTag,
	ProviderTurnService
>()("ProviderTurnService") {}

const makeProviderTurnService = Effect.gen(function* () {
	const providedContext = yield* Effect.context<
		| AccountDirectory
		| OpenCodeInstancesTag
		| SessionWorkspaceTag
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
	const sql = yield* SqlClient.SqlClient;
	const { projectId } = yield* EventStoreEffectTag;
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
		snapshot: Effect.Success<ReturnType<typeof prepareStop>>,
		recovered = false,
	) =>
		Effect.gen(function* () {
			if (snapshot.owners.length === 0 && snapshot.retainedSteers) return;
			const running =
				snapshot.owners.length === 0
					? Effect.succeed(false)
					: sql<{ running: number }>`
			SELECT EXISTS (SELECT 1 FROM provider_runs WHERE session_id = ${input.sessionId}
				AND id IN ${sql.in(snapshot.owners.map(({ runId }) => runId))}
				AND status IN ('pending', 'running')) AS running`.pipe(
							Effect.map(([row]) => row?.running === 1),
						);
			const remaining = Math.max(
				0,
				snapshot.deadlineAt - (yield* Clock.currentTimeMillis),
			);
			const delivery = recovered
				? Effect.void
				: interruptTurn(input, snapshot).pipe(
						Effect.catch((error) =>
							Effect.gen(function* () {
								// Delivery failure cannot erase an already committed Stop deadline.
								const [stored] =
									yield* sql`SELECT 1 FROM provider_command_outbox
						WHERE command_id = ${input.commandId} AND session_id = ${input.sessionId}
						AND json_type(payload_json, '$.stop') = 'object'`;
								if (!stored) return yield* Effect.fail(error);
							}),
						),
					);
			const ended = yield* delivery.pipe(
				Effect.andThen(
					Effect.repeat(running, {
						while: (still) => still,
						schedule: Schedule.spaced("100 millis"),
					}),
				),
				Effect.timeoutOption(remaining),
			);
			if (Option.isSome(ended) || !(yield* running)) return;
			if (snapshot.runnerBacked) {
				const [target] = yield* sql<{
					provider_process_id: string | null;
					provider_id: string;
				}>`SELECT provider_process_id, provider_id
					FROM provider_command_outbox WHERE command_id = ${input.commandId} AND session_id = ${input.sessionId}`;
				if (!target?.provider_process_id)
					return yield* new ProviderInstanceFailure({
						providerId: target?.provider_id ?? "conduit",
						operation: "interrupt_turn",
						cause: new Error(
							"Stop unconfirmed: the captured provider process is unavailable",
						),
					});
				yield* (yield* OrchestrationEngineTag).dispatchEffect({
					type: "end_session",
					retireProcess: true,
					retireRunIds: snapshot.owners.map(({ runId }) => runId),
					commandId: `${input.commandId}:retire`,
					sessionId: input.sessionId,
					targetProviderId: target.provider_id,
					providerProcessId: target.provider_process_id,
				});
				// The runner's confirmed-exit path owns settlement, including sends
				// whose provider intake never arrived.
				if (yield* running)
					return yield* new ProviderInstanceFailure({
						providerId: target.provider_id,
						operation: "interrupt_turn",
						cause: new Error(
							"Stop unconfirmed: provider process loss was not confirmed",
						),
					});
				return;
			}
			yield* settleSessionRuns(
				sql,
				input.sessionId,
				"Stop unconfirmed: OpenCode did not report a terminal event",
				(events) => ingestion.ingestBatch(events),
				{ owners: snapshot.owners, errorCode: "stop_unconfirmed" },
			);
		});
	const startStop = (
		input: ProviderTurnServiceInterruptInput,
		cutoff: Result.Result<
			Effect.Success<ReturnType<typeof prepareStop>>,
			Effect.Error<ReturnType<typeof prepareStop>>
		>,
		recovered = false,
	) =>
		Effect.gen(function* () {
			const done = yield* Deferred.make<void, StopFailure>();
			stopping.set(input.sessionId, done);
			yield* Effect.fromResult(cutoff).pipe(
				Effect.flatMap((snapshot) => abort(input, snapshot, recovered)),
				Effect.onExit((exit) =>
					Effect.sync(() => stopping.delete(input.sessionId)).pipe(
						Effect.andThen(Deferred.done(done, exit)),
						Effect.andThen(
							Exit.hasInterrupts(exit) ? Effect.void : lift(input.sessionId),
						),
					),
				),
				Effect.provide(providedContext),
				Effect.interruptible,
				Effect.forkIn(scope),
			);
			return Deferred.await(done);
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
						Effect.andThen(Deferred.succeed(hold, undefined)),
						Effect.andThen(lift(sessionId)),
					),
			).pipe(Effect.asVoid),
		turnFences: (sessionId) => ({
			stopping: stopping.has(sessionId),
			switching: accountSwitches.has(sessionId),
		}),
		fenceLifts: Effect.map(PubSub.subscribe(lifts), Stream.fromSubscription),
		completeRecoveredQuestion: (question, result, answers) =>
			completeRecoveredQuestion(question, result, answers).pipe(
				Effect.provide(providedContext),
			),
		prepareTurnSession: (input) =>
			Effect.gen(function* () {
				// Outside the inbox permit, so waiting cannot stall the switch's handoff.
				const switching = accountSwitches.get(input.sessionId);
				if (switching) yield* Deferred.await(switching);
				const inbox = yield* SessionInboxTag;
				return yield* prepareTurnSession(input, (stopInput) =>
					inbox.withSession(stopInput.sessionId, service.beginStop(stopInput)),
				);
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
					const cutoff = yield* prepareStop(input).pipe(
						Effect.provide(providedContext),
						Effect.result,
					);
					return yield* startStop(input, cutoff);
				}),
			),
	};
	// Completed delivery receipts still own a deadline until their captured runs
	// end. Restore the fences before the inbox can admit another foreground turn.
	const recovered = yield* sql<{
		command_id: string;
		session_id: string;
	}>`
		SELECT command.command_id, command.session_id
		FROM provider_command_outbox command
		WHERE command.effect_type IN ('interrupt_turn', 'end_session')
			AND command.project_key = ${projectId}
			AND ((json_type(command.payload_json, '$.stop') = 'object'
			AND EXISTS (SELECT 1 FROM provider_runs run, json_each(command.payload_json, '$.stop.owners') owner
				WHERE run.id = json_extract(owner.value, '$.runId') AND run.session_id = command.session_id
				AND run.status IN ('pending', 'running')))
			OR (command.effect_type = 'interrupt_turn' AND json_type(command.payload_json, '$.stop') IS NULL
				AND command.status IN ('pending', 'running')))
		ORDER BY command.request_sequence`.pipe(Effect.orDie);
	for (const row of recovered) {
		if (stopping.has(row.session_id)) continue;
		const input = {
			commandId: row.command_id,
			sessionId: row.session_id,
			clientId: "stop-recovery",
		};
		const cutoff = yield* prepareStop(input).pipe(
			Effect.provide(providedContext),
			Effect.result,
		);
		yield* startStop(input, cutoff, true);
	}
	return service;
});

const ProviderTurnDispatchFibersLive = Layer.effect(
	ProviderTurnDispatchFibersTag,
	FiberMap.make<string, void, unknown>(),
);

export const ProviderTurnServiceLive: Layer.Layer<
	ProviderTurnServiceTag,
	never,
	| AccountDirectory
	| OpenCodeInstancesTag
	| SessionWorkspaceTag
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
> = Layer.effect(ProviderTurnServiceTag, makeProviderTurnService).pipe(
	Layer.provide(ProviderTurnDispatchFibersLive),
);
