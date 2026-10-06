// The Session Inbox owns every input from send until handoff. A pure decider
// turns the session's inbox view and one command (or drain check) into
// canonical events and an optional handoff; a stateless shell reads the view
// from read models on every call, serialises per session and commits the
// decision. No queue state lives in memory, so a restart has nothing to rebuild.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Deferred, Effect, Layer, Schema, Stream } from "effect";
import {
	type InputAdmittedPayload,
	type InputCancelledPayload,
	type InputDelivery,
	type InputRequest,
	InputRequestSchema,
	type InputSentPayload,
	type SteerBlocker,
} from "../../../contracts/stored-event.js";
import {
	ClaudeEventPersistEffectTag,
	type ClaudeEventPersistFailure,
} from "../../../persistence/effect/claude-event-persist-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import {
	type ProviderTurnService,
	ProviderTurnServiceTag,
} from "./provider-turn-service.js";
import { LoggerTag } from "./services.js";
import { SessionEventBusTag } from "./session-event-bus.js";
import { OverridesStateTag } from "./session-overrides-state.js";

// ─── Decider ────────────────────────────────────────────────────────────────

/** What the inbox knows about one session, read fresh for every decision. */
export interface InboxView {
	/** Queued inputs, oldest first. */
	readonly queued: readonly InboxInput[];
	/** An input was handed off as a steer and has not started yet. */
	readonly steering: boolean;
	/** A turn is open, a handoff is in flight, or a prompt waits on the user. */
	readonly busy: boolean;
	/** A turn was stopped or failed since the latest handoff. */
	readonly stoppedSinceHandoff: boolean;
	/** The command's input id is already admitted or started. */
	readonly known: boolean;
	/** The session's provider can take an input mid-turn. */
	readonly providerSteers: boolean;
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
	| { readonly _tag: "SendNow"; readonly inputId: string }
	| { readonly _tag: "Drain" };

export type InboxEvent =
	| { readonly type: "input.admitted"; readonly data: InputAdmittedPayload }
	| { readonly type: "input.sent"; readonly data: InputSentPayload }
	| { readonly type: "input.cancelled"; readonly data: InputCancelledPayload };

export type InboxDecision =
	| {
			readonly _tag: "Accepted";
			readonly events: readonly InboxEvent[];
			/** The input to hand off; its input.sent commits with the outbox row. */
			readonly handoff?: InboxInput;
			/** The handoff joins the running turn. */
			readonly steer?: true;
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
	if (request.text.trimStart().startsWith("/")) return "slash_command";
	const { running } = view;
	if (!running) return undefined;
	if (
		running.model?.providerID !== request.model?.providerID ||
		running.model?.modelID !== request.model?.modelID ||
		running.contextWindow !== request.contextWindow
	)
		return "model_differs";
	if (running.agent !== request.agent) return "agent_differs";
	if (running.variant !== request.variant) return "variant_differs";
	return undefined;
}

/** Hand `input` off into the running turn, or refuse with the reason. */
const steer = (
	sessionId: string,
	view: InboxView,
	input: InboxInput,
	events: readonly InboxEvent[],
): InboxDecision => {
	const reason = steerBlocker(view, input.request);
	if (reason) return { _tag: "Rejected", reason };
	return {
		_tag: "Accepted",
		events: [...events, sent(sessionId, input.inputId)],
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
	// the latest handoff. A steer still answered after Stop leaves it paused.
	const paused = view.queued.length > 0 && view.stoppedSinceHandoff;
	const idle = !view.busy && !view.steering;
	switch (command._tag) {
		case "Submit": {
			if (view.known) return { _tag: "Accepted", events: [] };
			const { inputId, request } = command;
			const admitted: InboxEvent = {
				type: "input.admitted",
				data: { sessionId, inputId, delivery: command.delivery, request },
			};
			if (!idle && command.delivery === "steer")
				return steer(sessionId, view, { inputId, request }, [admitted]);
			if (!idle) return { _tag: "Accepted", events: [admitted] };
			// An idle session hands off at once. An unpaused queue still goes first.
			const next = paused ? undefined : view.queued[0];
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
			const next = view.queued[0];
			if (!idle || paused || !next) return { _tag: "Accepted", events: [] };
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
	readonly errorDelivery?: "client" | "session";
}

type SendTurnError = Effect.Effect.Error<
	ReturnType<ProviderTurnService["sendTurn"]>
>;

export type SessionInboxError =
	| SqlError
	| ClaudeEventPersistFailure
	| SendTurnError;

export interface SessionInboxTarget {
	readonly clientId: string;
	readonly sessionId: string;
	readonly inputId: string;
}

export type SessionInboxOutcome = "accepted" | "already_started" | SteerBlocker;

export interface SessionInbox {
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
		target: SessionInboxTarget,
	) => Effect.Effect<SessionInboxOutcome, SessionInboxError>;
	/** Hand a queued input off now: a steer on a busy session, else the next
	 *  turn. The only way to restart a paused queue. */
	readonly sendNow: (
		target: SessionInboxTarget,
	) => Effect.Effect<SessionInboxOutcome, SessionInboxError>;
	/** Start draining once the relay's providers are registered and recovered. */
	readonly start: Effect.Effect<void>;
}

export class SessionInboxTag extends Context.Tag("SessionInbox")<
	SessionInboxTag,
	SessionInbox
>() {}

// A drained handoff has no requesting client; its errors go to the session.
const DRAINED = { clientId: "", errorDelivery: "session" } as const;

const decodeRequest = Schema.decodeUnknown(
	Schema.parseJson(InputRequestSchema),
);

export const SessionInboxLive = Layer.scoped(
	SessionInboxTag,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const persist = yield* ClaudeEventPersistEffectTag;
		const providerTurnService = yield* ProviderTurnServiceTag;
		const overrides = yield* OverridesStateTag;
		const bus = yield* SessionEventBusTag;
		const log = yield* LoggerTag;
		const registry = yield* Effect.serviceOption(ProviderRegistryTag);
		const permits = new Map<string, Effect.Semaphore>();
		const serialised = (sessionId: string) => {
			let permit = permits.get(sessionId);
			if (!permit) {
				permit = Effect.unsafeMakeSemaphore(1);
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
				const [facts] = yield* sql<{
					status: string | null;
					provider: string | null;
					open_prompts: number;
					last_turn: string | null;
					stopped: number;
					running: string | null;
					in_flight: number;
				}>`SELECT
					(SELECT status FROM sessions WHERE id = ${sessionId}) AS status,
					(SELECT provider FROM sessions WHERE id = ${sessionId}) AS provider,
					(SELECT COUNT(*) FROM pending_approvals
						WHERE session_id = ${sessionId} AND status = 'pending') AS open_prompts,
					(SELECT state FROM turns WHERE session_id = ${sessionId}
						ORDER BY requested_at DESC, rowid DESC LIMIT 1) AS last_turn,
					EXISTS (SELECT 1 FROM turns WHERE session_id = ${sessionId}
						AND state IN ('interrupted', 'error')
						AND completed_at >= COALESCE(
							(SELECT MAX(requested_at) FROM provider_command_outbox
								WHERE session_id = ${sessionId} AND effect_type = 'send_turn'),
							(SELECT MAX(requested_at) FROM turns WHERE session_id = ${sessionId}),
							0)) AS stopped,
					(SELECT pending.request FROM provider_command_outbox outbox
						JOIN pending_inputs pending ON pending.input_id = outbox.command_id
						WHERE outbox.session_id = ${sessionId}
						AND outbox.effect_type = 'send_turn'
						ORDER BY outbox.request_sequence DESC LIMIT 1) AS running,
					EXISTS (SELECT 1 FROM provider_command_outbox outbox
						JOIN pending_inputs pending ON pending.input_id = outbox.command_id
						WHERE outbox.session_id = ${sessionId}
						AND outbox.effect_type = 'send_turn'
						AND outbox.status IN ('pending', 'running', 'retryable_failed')
						AND NOT EXISTS (SELECT 1 FROM messages
							WHERE messages.input_id = outbox.command_id)) AS in_flight`;
				const known =
					inputId === undefined
						? false
						: (yield* sql<{ n: number }>`SELECT
								EXISTS (SELECT 1 FROM pending_inputs WHERE input_id = ${inputId})
								OR EXISTS (SELECT 1 FROM messages
									WHERE input_id = ${inputId} OR id = ${inputId}) AS n`)[0]
								?.n === 1;
				const lastTurn = facts?.last_turn ?? null;
				const running =
					facts?.running == null
						? undefined
						: yield* decodeRequest(facts.running).pipe(Effect.orDie);
				return {
					queued,
					steering: rows.some((row) => row.state === "steering"),
					busy:
						facts?.status === "busy" ||
						facts?.status === "retry" ||
						(facts?.open_prompts ?? 0) > 0 ||
						lastTurn === "pending" ||
						lastTurn === "running" ||
						facts?.in_flight === 1,
					stoppedSinceHandoff: facts?.stopped === 1,
					known,
					providerSteers:
						facts?.provider != null &&
						registry._tag === "Some" &&
						registry.value.getInstance(facts.provider)?.steering === true,
					promptOpen: (facts?.open_prompts ?? 0) > 0,
					running,
				} satisfies InboxView;
			});

		const commit = (
			sessionId: string,
			decision: InboxDecision,
			delivery: Pick<SessionInboxSubmitInput, "clientId" | "errorDelivery">,
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
				const { handoff } = decision;
				if (!handoff) {
					if (events.length > 0) yield* persist.persistEvents(events);
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
						modelUserSelected: request.modelUserSelected,
						...(request.agent ? { agent: request.agent } : {}),
						...(request.variant ? { variant: request.variant } : {}),
						...(request.contextWindow
							? { contextWindow: request.contextWindow }
							: {}),
						...(delivery.errorDelivery
							? { errorDelivery: delivery.errorDelivery }
							: {}),
						...(decision.steer ? { steer: true } : {}),
						events,
					})
					.pipe(Effect.provideService(OverridesStateTag, overrides));
				// sendTurn reports a failure it could not place (no provider, no
				// model) to the session and leaves no trace, so a queued input would
				// be retried on every advance. Place it as a failed turn instead: it
				// leaves the tray, and the queue behind it pauses.
				if (!wasQueued) return;
				const [unsent] = yield* sql<{ n: number }>`SELECT 1 AS n
					FROM pending_inputs WHERE input_id = ${handoff.inputId} AND state = 'queued'`;
				if (!unsent) return;
				log.warn(
					`session=${sessionId} input=${handoff.inputId} queued handoff failed before it was sent; pausing the queue`,
				);
				const meta = provider ? { provider: provider.provider } : {};
				yield* persist.persistUserMessage(sessionId, request.text, {
					messageId: handoff.inputId,
					inputId: handoff.inputId,
					...meta,
				});
				yield* persist.persistEvent(
					canonicalEvent(
						"turn.error",
						sessionId,
						{
							messageId: handoff.inputId,
							userMessageId: handoff.inputId,
							error: "This queued message could not be sent",
						},
						meta,
					),
				);
			});

		const act =
			(command: "Cancel" | "SendNow") => (target: SessionInboxTarget) =>
				serialised(target.sessionId)(
					Effect.gen(function* () {
						const view = yield* readView(target.sessionId);
						const decision = decideInbox(target.sessionId, view, {
							_tag: command,
							inputId: target.inputId,
						});
						yield* commit(target.sessionId, decision, {
							clientId: target.clientId,
							errorDelivery: "session",
						});
						return decision._tag === "Rejected"
							? decision.reason
							: ("accepted" as const);
					}),
				);

		const drain = (sessionId: string) =>
			serialised(sessionId)(
				Effect.gen(function* () {
					const view = yield* readView(sessionId);
					if (view.queued.length === 0) return;
					yield* commit(
						sessionId,
						decideInbox(sessionId, view, { _tag: "Drain" }),
						DRAINED,
					);
				}),
			).pipe(
				Effect.catchAllCause((cause) =>
					Effect.sync(() =>
						log.warn(`session=${sessionId} inbox drain failed: ${cause}`),
					),
				),
			);

		const drainSessions = (sessionIds?: readonly string[]) =>
			Effect.gen(function* () {
				const rows = yield* sql<{ session_id: string }>`
					SELECT DISTINCT session_id FROM pending_inputs WHERE state = 'queued'`;
				const wanted = sessionIds && new Set(sessionIds);
				yield* Effect.forEach(
					rows.filter((row) => !wanted || wanted.has(row.session_id)),
					(row) => drain(row.session_id),
					{ discard: true },
				);
			}).pipe(
				Effect.catchAllCause((cause) =>
					Effect.sync(() => log.warn(`inbox drain sweep failed: ${cause}`)),
				),
			);

		// Subscribe before the startup sweep so no advance falls between them. A
		// dropped advance may have named any session, so it sweeps them all.
		// Nothing drains before start: a handoff before the providers are
		// registered would fail and pause a queue for no reason.
		const advances = yield* bus.subscribeAdvances();
		const ready = yield* Deferred.make<void>();
		yield* Effect.forkScoped(
			Deferred.await(ready).pipe(
				Effect.zipRight(drainSessions()),
				Effect.zipRight(
					Stream.runForEach(advances, (advance) =>
						advance.dropped
							? drainSessions()
							: advance.sessionIds.length > 0
								? drainSessions(advance.sessionIds)
								: Effect.void,
					),
				),
			),
		);

		return {
			start: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
			cancel: act("Cancel"),
			sendNow: act("SendNow"),
			submit: (input) =>
				serialised(input.sessionId)(
					Effect.gen(function* () {
						const view = yield* readView(input.sessionId, input.inputId);
						const decision = decideInbox(input.sessionId, view, {
							_tag: "Submit",
							inputId: input.inputId,
							delivery: input.delivery,
							request: input.request,
						});
						// Submit is only refused as a steer: a known id is accepted.
						if (decision._tag === "Rejected")
							return decision.reason === "already_started"
								? { handedOff: false }
								: { refused: decision.reason };
						// A queued input handed off ahead of this one has no requesting client.
						const own = decision.handoff?.inputId === input.inputId;
						yield* commit(input.sessionId, decision, own ? input : DRAINED);
						return { handedOff: own };
					}),
				),
		} satisfies SessionInbox;
	}),
);
