// The Session Inbox owns every input from send until handoff. A pure decider
// turns the session's inbox view and one command (or drain check) into
// canonical events and an optional handoff; a stateless shell reads the view
// from read models on every call, serialises per session and commits the
// decision. No queue state lives in memory, so a restart has nothing to rebuild.

import { randomUUID } from "node:crypto";
import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import {
	Clock,
	Context,
	Deferred,
	Effect,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect";
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
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import {
	ClaudeEventPersistEffectTag,
	type ClaudeEventPersistFailure,
} from "../../../persistence/effect/claude-event-persist-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import {
	type ProviderRegistry,
	ProviderRegistryTag,
} from "../../../provider/provider-registry.js";
import type { ProjectRelayConfig } from "../../../types.js";
import { Usage } from "../../daemon/Services/usage.js";
import { type Continuation, ContinuationTag } from "./continuation.js";
import {
	type ProviderTurnService,
	ProviderTurnServiceTag,
} from "./provider-turn-service.js";
import { ConfigTag, LoggerTag } from "./services.js";
import { SessionEventBusTag } from "./session-event-bus.js";
import { OverridesStateTag } from "./session-overrides-state.js";

/**
 * Whether a session's provider can steer. The registry holds one instance per
 * driver, but a session names its provider instance (e.g. a second Claude
 * account), so the instance is routed to its driver first.
 */
export const providerSteers = (
	registry: Option.Option<ProviderRegistry>,
	config: Option.Option<ProjectRelayConfig>,
	provider: string,
): boolean => {
	if (Option.isNone(registry)) return false;
	const driver = resolveProviderRoutingDriver(
		Option.isSome(config) ? loadDaemonConfig(config.value.configDir) : null,
		provider,
	);
	return (
		driver !== undefined &&
		registry.value.getInstance(driver)?.steering === true
	);
};

// ─── Decider ────────────────────────────────────────────────────────────────

/** What the inbox knows about one session, read fresh for every decision. */
export interface InboxView {
	/** The account whose usage was read for this decision. */
	readonly provider: string | undefined;
	/** Queued inputs, oldest first. */
	readonly queued: readonly InboxInput[];
	/** Oldest queued command whose interrupt request is still awaiting handoff. */
	readonly interruptRequested?: InboxInput | undefined;
	/** An input was handed off as a steer and has not started yet. */
	readonly steering: boolean;
	/** A turn is open, a handoff is in flight, or a prompt waits on the user. */
	readonly busy: boolean;
	/** A turn was stopped or failed since the latest handoff or reset release. */
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
			/** Interrupt after committing the events and releasing the session permit. */
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

/** Hand `input` off into the running turn, or refuse with the reason. */
const steer = (
	sessionId: string,
	view: InboxView,
	input: InboxInput,
	events: readonly InboxEvent[],
): InboxDecision => {
	const reason = steerBlocker(view, input.request);
	if (reason) return { _tag: "Rejected", reason };
	if (input.request.text.trimStart().startsWith("/"))
		return {
			_tag: "Accepted",
			events: [
				...events,
				{
					type: "input.interrupt_requested",
					data: { sessionId, inputId: input.inputId },
				},
			],
			interrupt: true,
		};
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
	const idle = !view.busy && !view.steering;
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
			if (!idle && command.delivery === "steer")
				return steer(sessionId, view, { inputId, request }, [admitted]);
			if (!idle) return { _tag: "Accepted", events: [admitted] };
			// An interrupt's command precedes the queue and bypasses its Stop pause.
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
}

type SendTurnError = Effect.Effect.Error<
	ReturnType<ProviderTurnService["sendTurn"]>
>;

export type SessionInboxError =
	| SqlError
	| ClaudeEventPersistFailure
	| SendTurnError
	| Effect.Effect.Error<ReturnType<Continuation["requestContinuation"]>>;

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
		target: SessionInboxTarget,
	) => Effect.Effect<SessionInboxOutcome, SessionInboxError>;
	/** Hand a queued input off now: a steer on a busy session, else the next
	 *  turn. Commands interrupt first and run next, including after Stop. */
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

// A drained handoff has no requesting client.
const DRAINED = { clientId: "" } as const;

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
		const usage = yield* Usage;
		const continuation = yield* ContinuationTag;
		const continuationContext =
			yield* Effect.context<
				Effect.Effect.Context<ReturnType<Continuation["requestContinuation"]>>
			>();
		const registry = yield* Effect.serviceOption(ProviderRegistryTag);
		const config = yield* Effect.serviceOption(ConfigTag);
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
				// A reset-only release restarts an input admitted after an earlier
				// Stop, as an idle Submit would. A Stop after admission still wins.
				const [facts] = yield* sql<{
					status: string | null;
					provider: string | null;
					limited: number;
					scheduled: number;
					open_prompts: number;
					last_turn: string | null;
					stopped: number;
					interrupt_requested: string | null;
					running: string | null;
					in_flight: number;
				}>`SELECT
					(SELECT status FROM sessions WHERE id = ${sessionId}) AS status,
					(SELECT provider FROM sessions WHERE id = ${sessionId}) AS provider,
					(SELECT json_extract(limit_recovery, '$.cutOffMessageId') IS NOT NULL
						FROM sessions WHERE id = ${sessionId}) AS limited,
					(SELECT json_extract(limit_recovery, '$.scheduledAt') IS NOT NULL
						AND NOT json_extract(limit_recovery, '$.continued')
						FROM sessions WHERE id = ${sessionId}) AS scheduled,
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
							0)) AND NOT EXISTS (
						SELECT 1 FROM events admitted JOIN events released
							ON released.session_id = admitted.session_id
						WHERE admitted.session_id = ${sessionId} AND admitted.type = 'input.admitted'
							AND released.type = 'session.resume_cancelled'
							AND json_extract(released.metadata, '$.source') = 'inbox-reset'
							AND released.sequence > admitted.sequence
							AND admitted.sequence > COALESCE((SELECT MAX(sequence) FROM events
								WHERE session_id = ${sessionId}
								AND type IN ('turn.interrupted', 'turn.error')), 0)) AS stopped,
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
				const reading = facts?.provider
					? yield* usage.latest(facts.provider)
					: undefined;
				const now = (yield* Clock.currentTimeMillis) / 1000;
				const resets =
					reading?.status === "limited"
						? reading.windows
								.filter(
									(window) =>
										(window.kind === "five_hour" ||
											window.kind === "seven_day") &&
										window.utilization >= 100,
								)
								.map((window) => Date.parse(window.resetsAt ?? "") / 1000)
								.filter((at) => Number.isFinite(at) && at > now)
						: [];
				return {
					provider: facts?.provider ?? undefined,
					queued,
					interruptRequested: queued.find(
						(input) => input.inputId === facts?.interrupt_requested,
					),
					steering: rows.some((row) => row.state === "steering"),
					busy:
						facts?.status === "busy" ||
						facts?.status === "retry" ||
						(facts?.open_prompts ?? 0) > 0 ||
						lastTurn === "pending" ||
						lastTurn === "running" ||
						facts?.in_flight === 1,
					stoppedSinceHandoff: facts?.stopped === 1,
					limited: facts?.limited === 1,
					usageResetsAt: resets.length > 0 ? Math.max(...resets) : undefined,
					scheduled: facts?.scheduled === 1,
					known,
					providerSteers:
						facts?.provider != null &&
						providerSteers(registry, config, facts.provider),
					promptOpen: (facts?.open_prompts ?? 0) > 0,
					running,
				} satisfies InboxView;
			});

		const commit = (
			sessionId: string,
			decision: InboxDecision,
			delivery: Pick<SessionInboxSubmitInput, "clientId">,
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
						...(request.agent ? { agent: request.agent } : {}),
						...(request.variant ? { variant: request.variant } : {}),
						...(request.contextWindow
							? { contextWindow: request.contextWindow }
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

		const interrupt = (
			target: Pick<SessionInboxTarget, "clientId" | "sessionId">,
			decision: InboxDecision,
		) =>
			decision._tag === "Accepted" && decision.interrupt
				? providerTurnService
						.interruptTurn({
							clientId: target.clientId,
							sessionId: target.sessionId,
							// The input id is reserved for its later send_turn receipt.
							commandId: randomUUID(),
						})
						.pipe(
							Effect.provideService(OverridesStateTag, overrides),
							Effect.catchAllCause((cause) =>
								Effect.sync(() =>
									log.warn(
										`session=${target.sessionId} inbox interrupt failed; command remains queued: ${cause}`,
									),
								),
							),
						)
				: Effect.void;

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
						});
						return decision;
					}),
				).pipe(
					// A turn end triggers a drain that needs the released permit.
					Effect.tap((decision) => interrupt(target, decision)),
					Effect.map((decision) =>
						decision._tag === "Rejected"
							? decision.reason
							: ("accepted" as const),
					),
				);

		const scheduleReset = (sessionId: string, view: InboxView) =>
			Effect.gen(function* () {
				if (
					view.usageResetsAt === undefined ||
					view.scheduled ||
					view.provider === undefined
				)
					return;
				// A cancellation after the last Submit stays cancelled. A new input
				// can schedule again; the sweep's reset release is not a user cancel.
				const [cancelled] = yield* sql<{ n: number }>`SELECT EXISTS (
					SELECT 1 FROM events WHERE session_id = ${sessionId}
						AND type = 'session.resume_cancelled'
						AND COALESCE(json_extract(metadata, '$.source'), '') <> 'inbox-reset'
						AND sequence > COALESCE((SELECT MAX(sequence) FROM events
							WHERE session_id = ${sessionId}
							AND type IN ('input.admitted', 'session.resume_scheduled')), 0)) AS n`;
				if (cancelled?.n === 1) return;
				yield* continuation
					.requestContinuation(sessionId, {
						instanceId: view.provider,
						expectedInstanceId: view.provider,
						reason: "reset",
						at: view.usageResetsAt,
						onlyIfUnscheduled: true,
					})
					.pipe(Effect.provide(continuationContext));
			});

		const drain = (sessionId: string) =>
			serialised(sessionId)(
				Effect.gen(function* () {
					const view = yield* readView(sessionId);
					if (view.queued.length === 0) return;
					yield* scheduleReset(sessionId, view);
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
			withSession: (sessionId, effect) => serialised(sessionId)(effect),
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
						if (decision._tag === "Rejected") return decision;
						// A queued input handed off ahead of this one has no requesting client.
						const own = decision.handoff?.inputId === input.inputId;
						yield* commit(input.sessionId, decision, own ? input : DRAINED);
						if (!decision.handoff && decision.events.length > 0)
							yield* scheduleReset(input.sessionId, view);
						return decision;
					}),
				).pipe(
					Effect.tap((decision) => interrupt(input, decision)),
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
