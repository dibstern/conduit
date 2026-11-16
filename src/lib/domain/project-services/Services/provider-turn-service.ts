import {
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	PubSub,
	Schedule,
	type Scope,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { Account } from "../../../contracts/account.js";
import type { AttachmentRef } from "../../../contracts/attachment-ref.js";
import type { InputDelivery } from "../../../contracts/stored-event.js";
import * as Failure from "../../../effect/failure-classification.js";
import { formatErrorDetail } from "../../../errors.js";
import type {
	ClaudeEventPersistEffectTag,
	ClaudeEventPersistFailure,
} from "../../../persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import type { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import type { ProviderStateEffectTag } from "../../../persistence/effect/provider-state-effect.js";
import type { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { loadLedgerView } from "../../../persistence/effect/run-ledger-arm.js";
import type { CanonicalEvent } from "../../../persistence/events.js";
import { ProviderInstanceFailure } from "../../../provider/errors.js";
import { settleSessionRuns } from "../../../provider/session-run-settlement.js";
import type { AccountDirectory } from "../../daemon/Services/account-directory.js";
import type { DaemonTurns } from "../../daemon/Services/daemon-turns.js";
import type { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
import { OwnerScopes } from "../../daemon/Services/owner-scopes.js";
import { SessionActivityTag } from "../../daemon/Services/session-activity.js";
import type { AlertsTag } from "./alerts.js";
import type {
	PendingInteractionServiceTag,
	PendingQuestion,
} from "./pending-interaction-service.js";
import {
	type ProviderRuntimeIngestionError,
	ProviderRuntimeIngestionTag,
} from "./provider-runtime-ingestion-service.js";
import { sendTurn } from "./provider-turn-dispatch.js";
import {
	completeRecoveredQuestion,
	interruptTurn,
	prepareStop,
	prepareTurnSession,
	STOP_ABORT_WAIT_MS,
} from "./provider-turn-session.js";
import type { ConfigTag } from "./services.js";
import { LoggerTag, OrchestrationEngineTag } from "./services.js";
import { announceBackgroundWork } from "./session-attention.js";
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
		boolean,
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
	/** Commit the session's Stop and install its fence, or join the Stop in
	 *  flight. Fails when main does not accept it. The returned effect awaits the
	 *  abort's end. Call under the inbox session permit. */
	readonly beginStop: (
		input: ProviderTurnServiceInterruptInput,
	) => Effect.Effect<
		Effect.Effect<void, StopFailure>,
		Effect.Error<ReturnType<typeof prepareStop>>
	>;
}

export class ProviderTurnServiceTag extends Context.Service<
	ProviderTurnServiceTag,
	ProviderTurnService
>()("ProviderTurnService") {}

/** What a relay lends the daemon's turn service. */
export type ProviderTurnParts =
	| AccountDirectory
	| OpenCodeInstancesTag
	| SessionWorkspaceTag
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
	| DaemonTurns
	| SqlClient.SqlClient
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag;

/** One project's fences and lifts. They outlive any relay of the project and
 *  go when the project's owner scope closes. */
interface ProjectTurns {
	readonly stopping: Map<string, Deferred.Deferred<void, StopFailure>>;
	readonly accountSwitches: Map<string, Deferred.Deferred<void>>;
	readonly lifts: PubSub.PubSub<string>;
	readonly recovery: Semaphore.Semaphore;
	recovered: boolean;
	bound: boolean;
}

export class ProviderTurns extends Context.Service<
	ProviderTurns,
	{
		/** The project's turn service, run against the calling relay's parts and
		 *  lent to the daemon until the caller's scope closes. The project's
		 *  outbox Stops are recovered once, before it returns. */
		readonly forProject: (
			projectId: string,
			parts: Context.Context<ProviderTurnParts>,
		) => Effect.Effect<ProviderTurnService, never, Scope.Scope>;
		/** The project's one turn service, built in its owner scope (the caller's)
		 *  and lent until that scope closes. */
		readonly own: (
			projectId: string,
			parts: Context.Context<ProviderTurnParts>,
		) => Effect.Effect<ProviderTurnService, never, Scope.Scope>;
		/** The newest turn service lent for the project; none while no relay serves it. */
		readonly served: (projectId: string) => Option.Option<ProviderTurnService>;
	}
>()("ProviderTurns") {}

const makeProviderTurnService = Effect.fnUntraced(function* (
	projectId: string,
	project: ProjectTurns,
	providedContext: Context.Context<ProviderTurnParts>,
	spawn: (
		sessionId: string,
		worker: Effect.Effect<unknown, unknown>,
	) => Effect.Effect<void>,
) {
	// A Stop ends with session-wide frames (idle status, done) that can trail
	// the button press. Each entry lives exactly as long as its abort worker,
	// so a fence never outlives the process, scope or call that owns it.
	// Stop fences stay with the daemon's turn service for the project, main's run
	// seam (CONTRACT.md 5874, D57); a relay replacement keeps them.
	const { stopping, accountSwitches } = project;
	// In memory, so no failed write can strand input reserved behind a fence.
	const { lifts } = project;
	const lift = (sessionId: string) => PubSub.publish(lifts, sessionId);
	const abort = (
		input: ProviderTurnServiceInterruptInput,
		snapshot: Effect.Success<ReturnType<typeof prepareStop>>,
		recovered = false,
	) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const ingestion = yield* ProviderRuntimeIngestionTag;
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
				// Row 213 (CONTRACT.md 223, 8.4 at 2870-2877): past the deadline U2 never
				// destroys while tasks are live or unknown. It holds the Stop, shown to the
				// browser as the ask while the ledger's confirm is pending, and retires once
				// the tasks end or a confirm is recorded after the latest Stop request; the
				// Run ending lets the Stop go. A gate that never opened keeps the process.
				const activity = Option.getOrUndefined(
					yield* Effect.serviceOption(SessionActivityTag),
				);
				// The hold is in memory; only the stamp makes the project's row re-read it.
				const announce = announceBackgroundWork(input.sessionId).pipe(
					Effect.catch((cause) =>
						Effect.logWarning("Could not announce the held Stop", cause),
					),
				);
				const release = activity?.background.holdStop(input.sessionId);
				yield* announce;
				const asked = Effect.gen(function* () {
					if (!(yield* running)) return false;
					const view = yield* loadLedgerView(input.sessionId).pipe(
						Effect.provideService(SqlClient.SqlClient, sql),
					);
					if (view === undefined || view.tasks.tag === "none") return false;
					const [confirmed] = yield* sql<{ confirmed: number }>`
					SELECT EXISTS (SELECT 1 FROM events WHERE session_id = ${input.sessionId}
						AND type = 'escalation.confirmed' AND sequence > (
							SELECT COALESCE(MAX(sequence), 0) FROM events
							WHERE session_id = ${input.sessionId} AND type = 'interrupt.requested'
						)) AS confirmed`;
					return confirmed?.confirmed !== 1;
				});
				yield* Effect.repeat(asked, {
					while: (still) => still,
					schedule: Schedule.spaced("250 millis"),
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => release?.()).pipe(Effect.andThen(announce)),
					),
				);
				if (!(yield* running)) return;
				// 8.4 (2880): the retire carries the snapshot entry the user confirmed, so the gate
				// does not ask for it again unless the tasks changed since.
				const [confirm] = yield* sql<{ entry: number }>`
				SELECT json_extract(data, '$.snapshotEntry') AS entry FROM events
				WHERE session_id = ${input.sessionId} AND type = 'escalation.confirmed'
					AND sequence > (
						SELECT COALESCE(MAX(sequence), 0) FROM events
						WHERE session_id = ${input.sessionId} AND type = 'interrupt.requested'
					)
				ORDER BY sequence DESC LIMIT 1`;
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
					stop: snapshot,
					retireProcess: true,
					retireRunIds: snapshot.owners.map(({ runId }) => runId),
					...(confirm === undefined ? {} : { confirmed: confirm.entry }),
					commandId: `${input.commandId}:retire`,
					sessionId: input.sessionId,
					targetProviderId: target.provider_id,
					providerProcessId: target.provider_process_id,
				});
				// Release is final even if a survivor remains. Retirement settles its
				// captured cohort detached; Stop must not wait on that SQL work.
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
	/** Install the fence of a Stop main accepted and fork its abort. The worker
	 *  alone removes the entry, and reports a later failure once. */
	const startStop = (
		input: ProviderTurnServiceInterruptInput,
		snapshot: Effect.Success<ReturnType<typeof prepareStop>>,
		recovered = false,
	) =>
		Effect.gen(function* () {
			const done = yield* Deferred.make<void, StopFailure>();
			stopping.set(input.sessionId, done);
			yield* abort(input, snapshot, recovered).pipe(
				Effect.onExit((exit) =>
					Effect.sync(() => stopping.delete(input.sessionId)).pipe(
						Effect.andThen(Deferred.done(done, exit)),
						Effect.andThen(
							Exit.isSuccess(exit)
								? lift(input.sessionId)
								: Failure.isInterrupted(exit.cause)
									? Effect.void
									: lift(input.sessionId).pipe(
											Effect.andThen(
												Effect.flatMap(LoggerTag, (log) =>
													Effect.sync(() =>
														log.warn(
															`session=${input.sessionId} Stop ${input.commandId} failed: ${Failure.renderCause(exit.cause)}`,
														),
													),
												),
											),
										),
						),
					),
				),
				Effect.provide(providedContext),
				Effect.interruptible,
				(worker) => spawn(input.sessionId, worker),
			);
			return Deferred.await(done);
		});
	const beginStop: ProviderTurnService["beginStop"] = (input) =>
		Effect.uninterruptible(
			Effect.suspend(() => {
				const existing = stopping.get(input.sessionId);
				return existing
					? Effect.succeed(Deferred.await(existing))
					: prepareStop(input).pipe(
							Effect.provide(providedContext),
							Effect.flatMap((snapshot) => startStop(input, snapshot)),
						);
			}),
		);
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
				// Only acceptance is awaited (RL-081); the worker reports a later failure.
				return yield* prepareTurnSession(input, (stopInput) =>
					inbox
						.withSession(stopInput.sessionId, beginStop(stopInput))
						.pipe(Effect.asVoid),
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
		beginStop,
	};
	// Completed delivery receipts still own a deadline until their captured runs
	// end. Restore the fences before the inbox can admit another foreground turn,
	// once per project however many relays it has.
	yield* project.recovery.withPermits(1)(
		Effect.gen(function* () {
			if (project.recovered) return;
			const sql = yield* SqlClient.SqlClient;
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
				const accepted = yield* prepareStop(input).pipe(
					Effect.provide(providedContext),
					Effect.result,
				);
				// A refused row installs nothing, so a later row of the session is tried.
				if (accepted._tag === "Failure") {
					(yield* LoggerTag).warn(
						`session=${input.sessionId} recovered Stop ${input.commandId} refused: ${formatErrorDetail(accepted.failure)}`,
					);
					continue;
				}
				yield* startStop(input, accepted.success, true);
			}
			project.recovered = true;
		}).pipe(Effect.provide(providedContext)),
	);
	return service;
});

/** The daemon's turn service: one state per project, kept across relay
 *  replacements and dropped when the project's owner scope closes. A Stop
 *  worker runs in its session's owner scope, or the daemon's when the session
 *  has none. */
export const ProviderTurnsLive = Layer.effect(
	ProviderTurns,
	Effect.gen(function* () {
		const owners = yield* Effect.serviceOption(OwnerScopes);
		const daemonScope = yield* Effect.scope;
		const projects = new Map<string, ProjectTurns>();
		const lent = new Map<string, readonly ProviderTurnService[]>();
		const spawn = (
			sessionId: string,
			worker: Effect.Effect<unknown, unknown>,
		) =>
			Option.isNone(owners)
				? Effect.asVoid(Effect.forkIn(worker, daemonScope))
				: owners.value.sessionScope(sessionId).pipe(
						Effect.flatMap((scope) =>
							scope.acquire<unknown, never, never>(Effect.forkScoped(worker)),
						),
						Effect.asVoid,
						Effect.catch(() =>
							Effect.asVoid(Effect.forkIn(worker, daemonScope)),
						),
					);
		const forget = (projectId: string, project: ProjectTurns) =>
			Effect.sync(() => {
				if (projects.get(projectId) === project) projects.delete(projectId);
			});
		const bind = (projectId: string, project: ProjectTurns) =>
			Option.isNone(owners) || project.bound
				? Effect.void
				: owners.value.projectScope(projectId).pipe(
						Effect.flatMap((scope) =>
							scope.acquire<void, never, never>(
								Effect.addFinalizer(() => forget(projectId, project)),
							),
						),
						Effect.tap(() => Effect.sync(() => (project.bound = true))),
						Effect.ignore,
					);
		const state = (projectId: string) =>
			Effect.suspend(() => {
				const existing = projects.get(projectId);
				if (existing) return Effect.succeed(existing);
				return Effect.map(PubSub.unbounded<string>(), (lifts) => {
					const created: ProjectTurns = {
						stopping: new Map(),
						accountSwitches: new Map(),
						lifts,
						recovery: Semaphore.makeUnsafe(1),
						recovered: false,
						bound: false,
					};
					projects.set(projectId, created);
					return created;
				});
			});
		const lend = (
			projectId: string,
			project: ProjectTurns,
			parts: Context.Context<ProviderTurnParts>,
		) =>
			Effect.gen(function* () {
				const service = yield* makeProviderTurnService(
					projectId,
					project,
					parts,
					spawn,
				);
				yield* Effect.acquireRelease(
					Effect.sync(() =>
						lent.set(projectId, [...(lent.get(projectId) ?? []), service]),
					),
					() =>
						Effect.sync(() => {
							const rest = (lent.get(projectId) ?? []).filter(
								(entry) => entry !== service,
							);
							if (rest.length > 0) lent.set(projectId, rest);
							else lent.delete(projectId);
						}),
				);
				return service;
			});
		return ProviderTurns.of({
			forProject: (projectId, parts) =>
				Effect.gen(function* () {
					const project = yield* state(projectId);
					yield* bind(projectId, project);
					return yield* lend(projectId, project, parts);
				}),
			// The caller's scope is the project's owner scope, so it holds the state too.
			own: (projectId, parts) =>
				Effect.gen(function* () {
					const project = yield* state(projectId);
					if (!project.bound) {
						project.bound = true;
						yield* Effect.addFinalizer(() => forget(projectId, project));
					}
					return yield* lend(projectId, project, parts);
				}),
			served: (projectId) =>
				Option.fromUndefinedOr(lent.get(projectId)?.at(-1)),
		});
	}),
);

/** A relay's view of its project's turns, run against the relay's parts. */
export const attachProviderTurnsLive = Layer.effect(
	ProviderTurnServiceTag,
	Effect.gen(function* () {
		const turns = yield* ProviderTurns;
		const { projectId } = yield* EventStoreEffectTag;
		return yield* turns.forProject(
			projectId,
			yield* Effect.context<ProviderTurnParts>(),
		);
	}),
);
