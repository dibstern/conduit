// The Session Inbox owns every input from send until handoff. A pure decider
// turns the session's inbox view and one command (or drain check) into
// canonical events and an optional handoff; a stateless shell reads the view
// from read models on every call, serialises per session and commits the
// decision. No queue state lives in memory, so a restart has nothing to rebuild.

import {
	Clock,
	Context,
	Deferred,
	Effect,
	Layer,
	Option,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { Account } from "../../../contracts/account.js";
import { accountLimit } from "../../../contracts/account-limit.js";
import {
	type AccountSwitchBusy,
	LimitRecoverySchema,
} from "../../../contracts/limit-recovery.js";
import { getProviderDriver } from "../../../contracts/provider-instance.js";
import { advanceTouchesScope } from "../../../contracts/read-model-advance.js";
import {
	type InputAdmittedPayload,
	type InputCancelledPayload,
	type InputDelivery,
	type InputInterruptRequestedPayload,
	type InputRequest,
	InputRequestSchema,
	type InputSentPayload,
	type SteerBlocker,
} from "../../../contracts/stored-event.js";
import {
	DraftAttachmentMissing,
	type InputDraftKey,
} from "../../../contracts/ws-rpc.js";
import {
	ClaudeEventPersistEffectTag,
	type ClaudeEventPersistFailure,
} from "../../../persistence/effect/claude-event-persist-effect.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { requeueFailedSteers } from "../../../persistence/effect/input-requeue-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import { inboxRunStatusQuery } from "../../../persistence/inbox-run-status-query.js";
import type { ProviderInstanceFailure } from "../../../provider/errors.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import { assertSessionRunnerAvailable } from "../../../provider/runner/runner-provider-instance.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { Usage } from "../../daemon/Services/usage.js";
import { type Continuation, ContinuationTag } from "./continuation.js";
import { type DraftChange, InputDraftsTag } from "./input-drafts.js";
import {
	type ProviderTurnService,
	ProviderTurnServiceTag,
} from "./provider-turn-service.js";
import { LoggerTag } from "./services.js";
import { SessionEventBusTag } from "./session-event-bus.js";
import { OverridesStateTag } from "./session-overrides-state.js";

/** A named account uses its driver's captured steering contract. */
export const providerSteers = (account: Account | undefined): boolean =>
	getProviderDriver(account?.driver)?.steering === "native";

// ─── Decider ────────────────────────────────────────────────────────────────

/** What the inbox knows about one session, read fresh for every decision. */
export interface InboxView {
	/** The account whose usage was read for this decision. */
	readonly provider: string | undefined;
	/** Queued inputs, oldest first. */
	readonly queued: readonly InboxInput[];
	/** Oldest queued input whose interrupt request is still awaiting handoff. */
	readonly interruptRequested?: InboxInput | undefined;
	/** An input was handed off as a steer and has not started yet. */
	readonly steering: boolean;
	/** A run is open, or Stop/account switching fences the next handoff. */
	readonly busy: boolean;
	/** A Stop's abort is in flight, including after its turn becomes terminal. */
	readonly stopping?: boolean;
	/** A continuation is moving the session to another account. */
	readonly switching?: boolean;
	/** Existing queued inputs are paused in the shared inbox read model. */
	readonly stoppedSinceHandoff: boolean;
	/** A usage limit cut a request off, and it is neither answered nor dismissed. */
	readonly limited: boolean;
	/** Usage reports this account limited until a known future Unix second. */
	readonly usageResetsAt: number | undefined;
	/** A scheduled reset must fire before queued inputs can drain. */
	readonly scheduled: boolean;
	/** The command's input id is already admitted or started. */
	readonly known: boolean;
	/** The session's provider can take an input mid-turn. */
	readonly providerSteers: boolean;
	/** Native Codex goal controls can run without interrupting the held turn. */
	readonly nativeGoalCommands?: boolean;
	/** A permission or question prompt waits on the user. */
	readonly promptOpen: boolean;
	/** The request of the latest handoff, which the running turn runs on. */
	readonly running: InputRequest | undefined;
}

export interface InboxInput {
	readonly inputId: string;
	readonly request: InputRequest;
}

export type InboxCommand =
	| {
			readonly _tag: "Submit";
			readonly inputId: string;
			readonly delivery: InputDelivery;
			readonly request: InputRequest;
	  }
	| { readonly _tag: "Cancel"; readonly inputId: string }
	| {
			readonly _tag: "SendNow";
			readonly inputId: string;
			readonly interrupt?: boolean;
	  }
	| { readonly _tag: "Drain" };

export type InboxEvent =
	| { readonly type: "input.admitted"; readonly data: InputAdmittedPayload }
	| { readonly type: "input.sent"; readonly data: InputSentPayload }
	| { readonly type: "input.cancelled"; readonly data: InputCancelledPayload }
	| {
			readonly type: "input.interrupt_requested";
			readonly data: InputInterruptRequestedPayload;
	  };

export type InboxDecision =
	| {
			readonly _tag: "Accepted";
			readonly events: readonly InboxEvent[];
			/** The input to hand off; its input.sent commits with the outbox row. */
			readonly handoff?: InboxInput;
			/** The handoff joins the running turn. */
			readonly steer?: true;
			/** Stop the running turn once the events are committed. */
			readonly interrupt?: true;
	  }
	| {
			readonly _tag: "Rejected";
			readonly reason: "already_started" | SteerBlocker;
	  };

const sent = (sessionId: string, inputId: string): InboxEvent => ({
	type: "input.sent",
	data: { sessionId, inputId },
});

// Only a queued input can be removed or sent now; anything else has started
// (or never existed, which the browser cannot tell apart from started).
const ALREADY_STARTED: InboxDecision = {
	_tag: "Rejected",
	reason: "already_started",
};

/** Why `request` cannot join the running turn, if it cannot. */
function steerBlocker(
	view: InboxView,
	request: InputRequest,
): SteerBlocker | undefined {
	if (!view.providerSteers) return "no_steering";
	if (view.promptOpen) return "prompt_open";
	// Commands start a new turn, so the running turn's options do not constrain them.
	if (request.text.trimStart().startsWith("/")) return undefined;
	const { running } = view;
	if (!running) return undefined;
	const runningModel = running.model;
	if (
		runningModel?.providerID !== request.model?.providerID ||
		runningModel?.modelID !== request.model?.modelID ||
		running.contextWindow !== request.contextWindow
	)
		return "model_differs";
	if (running.agent !== request.agent) return "agent_differs";
	if (running.variant !== request.variant) return "variant_differs";
	return undefined;
}

/** Reserve the next turn before stopping the current one. */
const interruptForInput = (
	sessionId: string,
	input: InboxInput,
	events: readonly InboxEvent[],
): InboxDecision => ({
	_tag: "Accepted",
	events: [
		...events,
		{
			type: "input.interrupt_requested",
			data: { sessionId, inputId: input.inputId },
		},
	],
	interrupt: true,
});

/** Hand `input` off into the running turn, or refuse with the reason. */
const steer = (
	sessionId: string,
	view: InboxView,
	input: InboxInput,
	events: readonly InboxEvent[],
): InboxDecision => {
	const reason = steerBlocker(view, input.request);
	if (reason) return { _tag: "Rejected", reason };
	if (
		input.request.text.trimStart().startsWith("/") &&
		!(
			view.nativeGoalCommands &&
			/^\/goal(?:\s|$)/.test(input.request.text.trim())
		)
	)
		return interruptForInput(sessionId, input, events);
	return {
		_tag: "Accepted",
		events: [
			...events,
			{
				type: "input.sent",
				data: { sessionId, inputId: input.inputId, steer: true },
			},
		],
		handoff: input,
		steer: true,
	};
};

export function decideInbox(
	sessionId: string,
	view: InboxView,
	command: InboxCommand,
): InboxDecision {
	// Pause is derived: a non-empty queue behind a turn stopped or failed since
	// the latest handoff, or behind a usage limit's open cut-off. A steer still
	// answered after Stop leaves it paused. The cut-off lifts when a reply lands
	// (a resume, a switch's continuation, or a new turn) or when it is dismissed.
	const paused =
		view.queued.length > 0 &&
		(view.stoppedSinceHandoff ||
			view.limited ||
			view.usageResetsAt !== undefined ||
			view.scheduled);
	// An unanswered prompt blocks a new handoff even when no owned run is open.
	const idle = !view.busy && !view.steering && !view.promptOpen;
	switch (command._tag) {
		case "Submit": {
			if (view.known) return { _tag: "Accepted", events: [] };
			const { inputId, request } = command;
			const admitted: InboxEvent = {
				type: "input.admitted",
				data: { sessionId, inputId, delivery: command.delivery, request },
			};
			if (view.usageResetsAt !== undefined || view.scheduled)
				return { _tag: "Accepted", events: [admitted] };
			if (view.stopping)
				return !view.interruptRequested
					? interruptForInput(sessionId, { inputId, request }, [admitted])
					: { _tag: "Accepted", events: [admitted] };
			// The switch's continuation owns the next turn; a steer would join the old one.
			if (view.switching) return { _tag: "Accepted", events: [admitted] };
			if (!idle && command.delivery === "steer")
				return steer(sessionId, view, { inputId, request }, [admitted]);
			if (!idle) return { _tag: "Accepted", events: [admitted] };
			// An interrupted input precedes the queue and bypasses its Stop pause.
			const next =
				view.interruptRequested && !view.limited
					? view.interruptRequested
					: paused
						? undefined
						: view.queued[0];
			const handoff = next ?? { inputId, request };
			return {
				_tag: "Accepted",
				events: [admitted, sent(sessionId, handoff.inputId)],
				handoff,
			};
		}
		case "Cancel": {
			const { inputId } = command;
			if (!view.queued.some((input) => input.inputId === inputId))
				return ALREADY_STARTED;
			return {
				_tag: "Accepted",
				events: [{ type: "input.cancelled", data: { sessionId, inputId } }],
			};
		}
		case "SendNow": {
			const input = view.queued.find(
				(queued) => queued.inputId === command.inputId,
			);
			if (!input) return ALREADY_STARTED;
			// A stopping turn cannot take a steer. Reserve the next turn instead, so
			// the Stop pause does not hold this input.
			if (view.stopping)
				return view.interruptRequested
					? { _tag: "Accepted", events: [] }
					: interruptForInput(sessionId, input, []);
			// Like a queued command's Run now, an open prompt must be answered first.
			if (!idle && command.interrupt)
				return view.promptOpen
					? { _tag: "Rejected", reason: "prompt_open" }
					: interruptForInput(sessionId, input, []);
			// It keeps its place and drains after the switch's continuation.
			if (view.switching) return { _tag: "Accepted", events: [] };
			// A busy session takes it as a steer; refused, it keeps its place.
			if (!idle) return steer(sessionId, view, input, []);
			// Paused or not, an idle session hands this input off.
			return {
				_tag: "Accepted",
				events: [sent(sessionId, input.inputId)],
				handoff: input,
			};
		}
		case "Drain": {
			const next = view.interruptRequested ?? view.queued[0];
			if (
				!idle ||
				!next ||
				view.limited ||
				view.usageResetsAt !== undefined ||
				view.scheduled ||
				(paused && !view.interruptRequested)
			)
				return { _tag: "Accepted", events: [] };
			return {
				_tag: "Accepted",
				events: [sent(sessionId, next.inputId)],
				handoff: next,
			};
		}
	}
}

// ─── Shell ──────────────────────────────────────────────────────────────────

export interface SessionInboxSubmitInput {
	readonly clientId: string;
	readonly sessionId: string;
	readonly inputId: string;
	readonly delivery: InputDelivery;
	readonly request: InputRequest;
	readonly draft?: {
		readonly key: InputDraftKey;
		readonly text?: string;
		readonly attachmentIds: readonly string[];
	};
}

type SendTurnError = Effect.Error<ReturnType<ProviderTurnService["sendTurn"]>>;

export type SessionInboxError =
	| DraftAttachmentMissing
	| SqlError
	| ProviderInstanceFailure
	| AccountSwitchBusy
	| ClaudeEventPersistFailure
	| SendTurnError
	| Effect.Error<ReturnType<Continuation["requestContinuation"]>>;

export interface SessionInboxTarget {
	readonly clientId: string;
	readonly sessionId: string;
	readonly inputId: string;
}

export type SessionInboxOutcome = "accepted" | "already_started" | SteerBlocker;

export interface SessionInbox {
	/** Rewind and undo share the input handoff lock, so they cannot race a send. */
	readonly withSession: <A, E, R>(
		sessionId: string,
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E, R>;
	/** Admit an input; `handedOff` is true when this input was sent at once.
	 *  A refused steer admits nothing. */
	readonly submit: (
		input: SessionInboxSubmitInput,
	) => Effect.Effect<
		{ readonly handedOff: boolean } | { readonly refused: SteerBlocker },
		SessionInboxError
	>;
	/** Remove a queued input before it is sent. */
	readonly cancel: (
		target: SessionInboxTarget & { readonly restoreTo?: InputDraftKey },
	) => Effect.Effect<SessionInboxOutcome, SessionInboxError>;
	/** Hand a queued input off now: a steer on a busy session, else the next
	 *  turn. With interrupt, stop the running turn and send this input next. */
	readonly sendNow: (
		target: SessionInboxTarget & { readonly interrupt?: boolean },
	) => Effect.Effect<SessionInboxOutcome, SessionInboxError>;
	/** The provider has declined this input and can no longer deliver it. */
	readonly steerDeclined: (
		sessionId: string,
		inputId: string,
	) => Effect.Effect<void, SqlError | ClaudeEventPersistFailure>;
	/** Start draining once the relay's providers are registered and recovered. */
	readonly start: Effect.Effect<void>;
}

export class SessionInboxTag extends Context.Service<
	SessionInboxTag,
	SessionInbox
>()("SessionInbox") {}

// A drained handoff has no requesting client.
const DRAINED = { clientId: "" } as const;

const decodeRequest = Schema.decodeUnknownEffect(
	Schema.fromJsonString(InputRequestSchema),
);

export const SessionInboxLive = Layer.effect(
	SessionInboxTag,
	Effect.gen(function* () {
		const accounts = yield* AccountDirectory;
		const sql = yield* SqlClient.SqlClient;
		const eventStore = yield* EventStoreEffectTag;
		const read = yield* ReadQueryEffectTag;
		const persist = yield* ClaudeEventPersistEffectTag;
		const drafts = yield* InputDraftsTag;
		const providerTurnService = yield* ProviderTurnServiceTag;
		const registry = Option.getOrUndefined(
			yield* Effect.serviceOption(ProviderRegistryTag),
		);
		const overrides = yield* OverridesStateTag;
		const bus = yield* SessionEventBusTag;
		const log = yield* LoggerTag;
		const usage = yield* Usage;
		const continuation = yield* ContinuationTag;
		const continuationContext =
			yield* Effect.context<
				Effect.Services<ReturnType<Continuation["requestContinuation"]>>
			>();
		const permits = new Map<string, Semaphore.Semaphore>();
		const serialised = (sessionId: string) => {
			let permit = permits.get(sessionId);
			if (!permit) {
				permit = Semaphore.makeUnsafe(1);
				permits.set(sessionId, permit);
			}
			return permit.withPermits(1);
		};

		const readView = (sessionId: string, inputId?: string) =>
			Effect.gen(function* () {
				const rows = yield* sql<{
					input_id: string;
					state: "queued" | "steering";
					request: string;
				}>`SELECT input_id, state, request FROM pending_inputs
					WHERE session_id = ${sessionId} AND state IN ('queued', 'steering')
					ORDER BY admitted_at, rowid`;
				const queued = yield* Effect.forEach(
					rows.filter((row) => row.state === "queued"),
					(row) =>
						decodeRequest(row.request).pipe(
							Effect.orDie,
							Effect.map((request) => ({ inputId: row.input_id, request })),
						),
				);
				const inboxState = yield* read.readInboxState(sessionId);
				const [facts] = yield* sql<{
					run_status: string | null;
					provider: string | null;
					limited: number;
					scheduled: number;
					open_prompts: number;
					limit_recovery: string | null;
					model_id: string | null;
					interrupt_requested: string | null;
					running: string | null;
				}>`WITH latest_run AS (${inboxRunStatusQuery(sql, sessionId)}) SELECT
					(SELECT status FROM latest_run) AS run_status,
					(SELECT provider FROM sessions WHERE id = ${sessionId}) AS provider,
					(SELECT limit_recovery FROM sessions WHERE id = ${sessionId}) AS limit_recovery,
					(SELECT model_id FROM sessions WHERE id = ${sessionId}) AS model_id,
					(SELECT json_extract(limit_recovery, '$.cutOffMessageId') IS NOT NULL
						FROM sessions WHERE id = ${sessionId}) AS limited,
					(SELECT json_extract(limit_recovery, '$.scheduledAt') IS NOT NULL
						AND NOT json_extract(limit_recovery, '$.continued')
						FROM sessions WHERE id = ${sessionId}) AS scheduled,
					(SELECT COUNT(*) FROM pending_approvals
						WHERE session_id = ${sessionId} AND status = 'pending'
							AND (type <> 'question' OR COALESCE(json_extract(details, '$.delivery'), '') <> 'async')) AS open_prompts,
					(SELECT pending.input_id FROM pending_inputs pending
						WHERE pending.session_id = ${sessionId} AND pending.state = 'queued'
						AND EXISTS (SELECT 1 FROM events
							WHERE events.session_id = pending.session_id
							AND events.type = 'input.interrupt_requested'
							AND json_extract(events.data, '$.inputId') = pending.input_id)
						ORDER BY pending.admitted_at, pending.rowid LIMIT 1) AS interrupt_requested,
					(SELECT pending.request FROM provider_command_outbox outbox
						JOIN pending_inputs pending ON pending.input_id = outbox.command_id
						WHERE outbox.session_id = ${sessionId}
						AND outbox.effect_type = 'send_turn'
						ORDER BY outbox.request_sequence DESC LIMIT 1) AS running`;
				const known =
					inputId === undefined
						? false
						: (yield* sql<{ n: number }>`SELECT
								EXISTS (SELECT 1 FROM pending_inputs WHERE input_id = ${inputId})
								OR EXISTS (SELECT 1 FROM messages
									WHERE input_id = ${inputId} OR id = ${inputId}) AS n`)[0]
								?.n === 1;
				const running =
					facts?.running == null
						? undefined
						: yield* decodeRequest(facts.running).pipe(Effect.orDie);
				const account = facts?.provider
					? yield* accounts
							.resolve({ _tag: "Id", id: facts.provider })
							.pipe(Effect.option)
					: Option.none<Account>();
				const reading = Option.isSome(account)
					? yield* usage.latest(account.value.id)
					: undefined;
				const recovery =
					facts?.limit_recovery == null
						? undefined
						: yield* Schema.decodeUnknownEffect(
								Schema.fromJsonString(LimitRecoverySchema),
							)(facts.limit_recovery).pipe(Effect.orDie);
				const limit = accountLimit({
					asker: "user",
					modelId: facts?.model_id ?? undefined,
					...(reading === undefined ? {} : { reading }),
					...(recovery === undefined ? {} : { recovery }),
					now: yield* Clock.currentTimeMillis,
				});
				const fences = providerTurnService.turnFences(sessionId);
				return {
					provider: facts?.provider ?? undefined,
					queued,
					interruptRequested: queued.find(
						(input) => input.inputId === facts?.interrupt_requested,
					),
					steering: rows.some((row) => row.state === "steering"),
					busy:
						fences.stopping ||
						fences.switching ||
						facts?.run_status === "pending" ||
						facts?.run_status === "running",
					stopping: fences.stopping,
					switching: fences.switching,
					stoppedSinceHandoff: inboxState?.paused === true,
					limited: facts?.limited === 1,
					usageResetsAt:
						limit.kind === "wait-until" ? limit.until / 1_000 : undefined,
					scheduled: facts?.scheduled === 1,
					known,
					providerSteers: providerSteers(Option.getOrUndefined(account)),
					nativeGoalCommands:
						Option.getOrUndefined(account)?.driver === "codex",
					promptOpen: (facts?.open_prompts ?? 0) > 0,
					running,
				} satisfies InboxView;
			});

		const steerDeclined = (
			sessionId: string,
			inputId: string,
			sentEventId?: string,
		) =>
			serialised(sessionId)(
				Effect.gen(function* () {
					const [pending] = yield* sql<{
						sent_sequence: number;
					}>`SELECT (SELECT MAX(sequence) FROM events WHERE session_id = ${sessionId}
						AND type = 'input.sent' AND json_extract(data, '$.inputId') = ${inputId}) AS sent_sequence FROM pending_inputs
						WHERE session_id = ${sessionId} AND input_id = ${inputId} AND state = 'steering'
						AND NOT EXISTS (SELECT 1 FROM messages WHERE input_id = ${inputId})
						AND (${sentEventId ?? null} IS NULL OR (SELECT event_id FROM events
							WHERE session_id = ${sessionId} AND type = 'input.sent'
							AND json_extract(data, '$.inputId') = ${inputId}
							ORDER BY sequence DESC LIMIT 1) = ${sentEventId ?? null})`;
					if (!pending) return;
					yield* persist.persistEvent(
						canonicalEvent("input.requeued", sessionId, {
							sessionId,
							inputId,
							sentSequence: pending.sent_sequence,
							reason: "declined",
						}),
					);
				}),
			);

		// Reservations whose Stop this daemon already issued; drain re-aborts any
		// other reservation it finds behind a running turn (one left by a restart).
		const stopIssued = new Set<string>();
		const stop = (sessionId: string, clientId: string, inputId: string) =>
			Effect.sync(() => stopIssued.add(inputId)).pipe(
				Effect.andThen(
					providerTurnService.beginStop({
						clientId,
						sessionId,
						// The input id is reserved for its later send_turn receipt.
						commandId: `inbox-stop:${inputId}`,
					}),
				),
				// The worker settles and reports the abort; the inbox only starts it.
				Effect.asVoid,
			);

		const commit = (
			sessionId: string,
			decision: InboxDecision,
			delivery: Pick<SessionInboxSubmitInput, "clientId">,
			draftChange?: DraftChange,
		) =>
			Effect.gen(function* () {
				if (decision._tag === "Rejected") return;
				const [provider] = yield* sql<{ provider: string }>`
					SELECT provider FROM sessions WHERE id = ${sessionId}`;
				const events = decision.events.map((event) =>
					canonicalEvent(event.type, sessionId, event.data, {
						...(provider ? { provider: provider.provider } : {}),
					}),
				);
				for (const event of decision.events)
					if (event.type === "input.sent" || event.type === "input.cancelled")
						stopIssued.delete(event.data.inputId);
				const { handoff } = decision;
				if (!handoff) {
					if (events.length > 0)
						yield* persist
							.persistEvents(events, draftChange ? { draftChange } : undefined)
							.pipe(
								Effect.catchTag("ClaudeEventPersistEffectError", (error) =>
									Effect.fail(
										error.cause instanceof DraftAttachmentMissing
											? error.cause
											: error,
									),
								),
							);
					const reserved = decision.events.find(
						(event) => event.type === "input.interrupt_requested",
					);
					if (decision.interrupt && reserved)
						yield* stop(sessionId, delivery.clientId, reserved.data.inputId);
					return;
				}
				const wasQueued = !decision.events.some(
					(event) =>
						event.type === "input.admitted" &&
						event.data.inputId === handoff.inputId,
				);
				// input.sent commits with the handoff's send_turn outbox row.
				const { request } = handoff;
				yield* providerTurnService
					.sendTurn({
						clientId: delivery.clientId,
						commandId: handoff.inputId,
						sessionId,
						text: request.text,
						...(request.images ? { images: request.images } : {}),
						...(request.model ? { model: request.model } : {}),
						...(request.agent ? { agent: request.agent } : {}),
						...(request.variant ? { variant: request.variant } : {}),
						...(request.contextWindow
							? { contextWindow: request.contextWindow }
							: {}),
						...(decision.steer ? { steer: true } : {}),
						onSteerDeclined: steerDeclined(
							sessionId,
							handoff.inputId,
							events.find((event) => event.type === "input.sent")?.eventId,
						),
						events,
						...(draftChange ? { draftChange } : {}),
					})
					.pipe(Effect.provideService(OverridesStateTag, overrides));
				// An unplaced failed handoff remains queued. Record it once so it
				// pauses the remaining queue instead of retrying on every advance.
				if (!wasQueued) return;
				const [unsent] = yield* sql<{ n: number }>`SELECT 1 AS n
					FROM pending_inputs WHERE input_id = ${handoff.inputId} AND state = 'queued'`;
				if (!unsent) return;
				log.warn(
					`session=${sessionId} input=${handoff.inputId} queued handoff failed before it was sent; pausing the queue`,
				);
				yield* persist.persistUserMessage(sessionId, request.text, {
					messageId: handoff.inputId,
					inputId: handoff.inputId,
					...(provider ? { provider: provider.provider } : {}),
					...(request.images ? { images: request.images } : {}),
					failure: { message: "This queued message could not be sent" },
				});
			});

		// Input ids are unique across sessions. Only coalesce requests while the
		// original Run now is active; ordinary Stop and steering keep their policy.
		const runNowInFlight = new Set<string>();
		const act =
			(command: "Cancel" | "SendNow") =>
			(
				target: SessionInboxTarget & {
					readonly interrupt?: boolean;
					readonly restoreTo?: InputDraftKey;
				},
			) =>
				Effect.gen(function* () {
					const runNow = command === "SendNow" && target.interrupt;
					if (runNow && runNowInFlight.has(target.inputId))
						return "accepted" as const;
					if (runNow) runNowInFlight.add(target.inputId);
					return yield* serialised(target.sessionId)(
						Effect.gen(function* () {
							const view = yield* readView(target.sessionId);
							if (command === "SendNow") {
								const account = view.provider
									? yield* accounts
											.resolve({ _tag: "Id", id: view.provider })
											.pipe(Effect.option)
									: Option.none<Account>();
								yield* assertSessionRunnerAvailable(
									target.sessionId,
									registry,
									Option.getOrUndefined(account),
								);
							}
							const decision = decideInbox(target.sessionId, view, {
								_tag: command,
								inputId: target.inputId,
								...(runNow ? { interrupt: true } : {}),
							});
							yield* commit(
								target.sessionId,
								decision,
								decision._tag === "Accepted" &&
									decision.handoff &&
									decision.handoff.inputId !== target.inputId
									? DRAINED
									: target,
								command === "Cancel" &&
									target.restoreTo &&
									decision._tag === "Accepted"
									? drafts.restoreChange(
											target.restoreTo,
											target.inputId,
											view.queued.find(
												(item) => item.inputId === target.inputId,
											)?.request.images ?? [],
										)
									: undefined,
							);
							return decision;
						}),
					).pipe(
						Effect.map((decision) =>
							decision._tag === "Rejected"
								? decision.reason
								: ("accepted" as const),
						),
						Effect.ensuring(
							Effect.sync(() => {
								if (runNow) runNowInFlight.delete(target.inputId);
							}),
						),
					);
				});

		const drain = (sessionId: string) =>
			serialised(sessionId)(
				Effect.gen(function* () {
					const view = yield* readView(sessionId);
					if (view.queued.length === 0) return;
					const reserved = view.interruptRequested;
					if (
						reserved &&
						view.busy &&
						!view.stopping &&
						!stopIssued.has(reserved.inputId)
					)
						yield* stop(sessionId, DRAINED.clientId, reserved.inputId);
					yield* commit(
						sessionId,
						decideInbox(sessionId, view, { _tag: "Drain" }),
						DRAINED,
					);
				}),
			).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() =>
						log.warn(`session=${sessionId} inbox drain failed: ${cause}`),
					),
				),
			);

		const drainSessions = (sessionIds?: readonly string[]) =>
			Effect.gen(function* () {
				const rows = yield* sql<{ session_id: string }>`
					SELECT DISTINCT pending.session_id FROM pending_inputs pending
					JOIN sessions ON sessions.id = pending.session_id
					WHERE pending.state = 'queued' AND sessions.project_id = ${eventStore.projectId}`;
				const wanted = sessionIds && new Set(sessionIds);
				yield* Effect.forEach(
					rows.filter((row) => !wanted || wanted.has(row.session_id)),
					(row) => drain(row.session_id),
					{ discard: true },
				);
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => log.warn(`inbox drain sweep failed: ${cause}`)),
				),
			);

		// Subscribe before the startup sweep so no advance or fence lift falls
		// between them. A dropped advance may have named any session, so it
		// sweeps them all.
		// Nothing drains before start: a handoff before the providers are
		// registered would fail and pause a queue for no reason.
		const advances = yield* bus.subscribeAdvances();
		const lifts = yield* providerTurnService.fenceLifts;
		const ready = yield* Deferred.make<void>();
		yield* Effect.forkScoped(
			Deferred.await(ready).pipe(
				Effect.andThen(
					requeueFailedSteers(sql, persist).pipe(
						Effect.catchCause((cause) =>
							Effect.sync(() => log.warn(`inbox recovery failed: ${cause}`)),
						),
					),
				),
				Effect.andThen(drainSessions()),
				Effect.andThen(
					Stream.runForEach(
						Stream.merge(
							Stream.map(advances, (advance) =>
								advance.dropped
									? drainSessions()
									: advanceTouchesScope(advance, {
												projectIds: [eventStore.projectId],
											}) && advance.sessionIds.length > 0
										? drainSessions(advance.sessionIds)
										: Effect.void,
							),
							Stream.map(lifts, (sessionId) => drainSessions([sessionId])),
						),
						(drain) => drain,
					),
				),
			),
			{ uninterruptible: "inherit" },
		);

		return {
			withSession: (sessionId, effect) => serialised(sessionId)(effect),
			start: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
			cancel: act("Cancel"),
			sendNow: act("SendNow"),
			steerDeclined,
			submit: (input) =>
				serialised(input.sessionId)(
					Effect.gen(function* () {
						const view = yield* readView(input.sessionId, input.inputId);
						if (view.known) return { _tag: "Accepted" as const, events: [] };
						// Busy and approval-blocked inputs may never reach runner execution.
						const account = view.provider
							? yield* accounts
									.resolve({ _tag: "Id", id: view.provider })
									.pipe(Effect.option)
							: Option.none<Account>();
						yield* assertSessionRunnerAvailable(
							input.sessionId,
							registry,
							Option.getOrUndefined(account),
						);
						const refs = input.draft
							? yield* drafts.takeForSend(
									input.draft.key,
									input.draft.attachmentIds,
								)
							: [];
						const request =
							refs.length > 0
								? {
										...input.request,
										images: [...(input.request.images ?? []), ...refs],
									}
								: input.request;
						const decision = decideInbox(input.sessionId, view, {
							_tag: "Submit",
							inputId: input.inputId,
							delivery: input.delivery,
							request,
						});
						// Submit is only refused as a steer: a known id is accepted.
						if (decision._tag === "Rejected") return decision;
						const draftChange = input.draft
							? drafts.sendChange(
									input.draft.key,
									input.sessionId,
									input.draft.text ?? request.text,
									input.draft.attachmentIds,
									refs,
								)
							: undefined;
						const delayMs =
							process.env["NODE_ENV"] === "test"
								? Number(
										process.env["CONDUIT_TEST_DRAFT_SEND_BEFORE_COMMIT_MS"],
									)
								: 0;
						if (draftChange && Number.isFinite(delayMs) && delayMs > 0) {
							log.info(`draft-send-before-commit:${input.inputId}`);
							yield* Effect.sleep(delayMs);
						}
						// A queued input handed off ahead of this one has no requesting client.
						const own = decision.handoff?.inputId === input.inputId;
						yield* commit(
							input.sessionId,
							decision,
							own ? input : DRAINED,
							draftChange,
						);
						if (
							!decision.handoff &&
							decision.events.length > 0 &&
							view.usageResetsAt !== undefined &&
							!view.scheduled &&
							view.provider !== undefined
						)
							yield* continuation
								.requestContinuation(input.sessionId, {
									instanceId: view.provider,
									expectedInstanceId: view.provider,
									reason: "reset",
									at: view.usageResetsAt,
									onlyIfUnscheduled: true,
								})
								.pipe(Effect.provide(continuationContext));
						return decision;
					}),
				).pipe(
					Effect.map((decision) =>
						decision._tag === "Rejected" &&
						decision.reason !== "already_started"
							? { refused: decision.reason }
							: {
									handedOff:
										decision._tag === "Accepted" &&
										decision.handoff?.inputId === input.inputId,
								},
					),
				),
		} satisfies SessionInbox;
	}),
);
