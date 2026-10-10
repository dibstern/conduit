// `RpcClient` reconnects the transport and replays nothing, so a dropped socket
// leaves every subscription on it dead. Someone has to re-issue. That someone is
// this module — once, for every stream subscription, never a consumer (ni8.5 §9).
//
// **Where the resume cursor lives.** In a `Ref` created here, per subscription,
// for the life of the consuming scope. It is transport state: it sits on the
// path every envelope already travels, between the socket and the consumer, and
// no store can see it or forget to keep it. It is not per socket (two
// subscriptions on one socket have unrelated sequence spaces) and not per
// consumer (that is the duplication §9 rejects). It advances on DELIVERY, not on
// receipt — an envelope buffered but never handed to the consumer must be
// re-fetched, not skipped.
//
// **The cursor lags one sequence on purpose.** A sequence is a store-global
// EVENT sequence, and one event can produce several envelopes: a session
// tombstone cascades, so the parent's `remove` and every child's `remove` all
// carry the same number. Server replay is exclusive, so a cursor parked on a
// sequence whose group is only half delivered silently drops the rest. The wire
// already says when a sequence is closed, without any change to it: a STRICTLY
// GREATER sequence proves the previous one had no more siblings, and
// `synchronized` — the server's own "you are caught up" marker — proves it for
// whatever is open. So `closed` is the newest sequence proven complete and the
// only value we ever resume from; `open` is the one still in flight.
//
// **The replayed group stops here, not at the consumer.** Resuming from `closed`
// means the server replays the whole open group, the members already delivered
// included. That is correct on the wire — the alternative loses siblings — but
// the consumer is promised one uninterrupted stream with no repeated items, so
// the already-delivered members are dropped here instead. The cursor therefore
// also carries the IDENTITY of every envelope delivered at `open`, and forgets
// them the moment that sequence closes, so the set is never bigger than one
// event's fan-out. Identity, not a count: replay re-derives current state rather
// than replaying history, so a group can come back coalesced or in a different
// order, and "skip the first two" would then skip the wrong two. An envelope we
// cannot identify is delivered — repeating is the recoverable mistake.
//
// **`synchronized` is exempt, deliberately.** The server closes every replay
// with it, an empty replay included, so a resume always ends in one and a
// consumer that had already been told it was live gets told again. That one is
// not suppressed: it is a marker, not an item — it names no row and carries no
// sequence — and it is the observable T-11 keys its switching state off, so a
// resume has to produce it. Acting on it twice is acting on it once.
//
// **How re-issue meets the transport's own reconnect.** It doesn't. The
// transport owns reconnecting the socket — `layerProtocolSocket` retries forever
// on its own schedule, which we deliberately leave at its default — and this
// module owns only re-asking for the subscription. We never open a socket, never
// replace the pair, never touch a unary call. The two would still collide on
// timing: while the socket is down `send` fails immediately, so an unpaced
// re-issue would spin. So the first re-issue is immediate (covers a server that
// closed just this stream while the socket is healthy) and later ones back off to
// a 1s ceiling, which is strictly cheaper than a reconnect attempt and never
// outlives one. Re-issue is infinite because the transport's reconnect is
// infinite: giving up would strand a consumer on a socket that later came back.
//
// **What the consumer sees during the gap: nothing.** No synthetic item, no
// error, no re-snapshot. The stream pauses, continues, and ends the resume with
// the `synchronized` that closes the replay. A "reconnecting" item
// would widen the envelope union for every consumer to handle a case that means
// nothing to it, and the vocabulary that says "you are live again" already
// exists: the server ends a resume with `synchronized`, which is precisely the
// signal ni8.5 T-11 keys its switching state off. Resume and switch therefore
// produce the same observable, which is what T-11 needs and what "one
// uninterrupted stream" means for S-14.
// A detail suffix length mismatch is different: its buffer is untrustworthy,
// so it explicitly requests a cold snapshot and discards the resume cursor.
//
// **A resume is checked, and the server wins** (conduit-test-y7eo.9). A
// subscription given a ledger records, for every row it delivers, the version
// that row moved at, starting from its last snapshot (whose rows all count at
// the snapshot's sequence), and a resume names that snapshot as its base. The
// server ends a catch-up against a base with the checksum of the set it holds;
// a ledger that disagrees is a view that has drifted, however it happened, so
// it is logged and treated as the suffix mismatch is: discard the cursor, take
// a cold snapshot. The `synchronized` that failed the check is not delivered;
// the snapshot's own is.
//
// **What is worth re-issuing.** `RpcClientError` — the transport's own error,
// raised for a dead socket or an undecodable frame — is protocol class and is
// re-issued; it says nothing about whether the subscription is servable. So is a
// bare INTERRUPTION, which is the same event arriving by a different door: when
// the socket dies while a chunk is still being handed into the client's 16-deep
// mailbox, the blocked handover is interrupted and the mailbox closes on that
// interrupt before any `ClientProtocolError` frame is written. Under backpressure
// that is the ordinary case, not the exotic one. The one interruption we must
// not re-issue is the consumer unsubscribing, and the two are told apart by who
// was interrupted: a torn-down socket interrupts a transport fiber and we merely
// observe the cause, whereas an unsubscribe interrupts US. `WsRpcError` is the
// server answering that it cannot serve this subscription: a domain failure,
// deterministic, and re-issuing it would loop. It surfaces, which is why this
// returns `Stream<A, WsRpcError>` — a consumer can only ever see a domain
// failure. Defects stay defects, and are asked about FIRST, because a cause is a
// tree and reaching into it for the typed failure would retry straight past a
// bug. A cause carrying both does reach here: `Stream.fromChannel` hands one
// over intact, and `Stream.ensuring` passes on whatever it was given. Not every
// route in does — `Stream.fromEffect` and `Stream.failCause` rebuild the cause
// from its typed failure alone, so the defect is gone before any handler is
// offered it (effect 3.21.2, probed at the handler rather than at the run
// boundary, which collapses causes of its own accord) — and that is why asking
// in the other order looks safe until the day it isn't. Both shapes end up in
// the same place: the whole cause goes on as defects, because a cause that
// killed us is not half a retryable thing.

import type { RpcClientError } from "@effect/rpc/RpcClientError";
import {
	Cause,
	Chunk,
	Data,
	Duration,
	Effect,
	HashSet,
	Option,
	Ref,
	Schema,
	Stream,
} from "effect";
import {
	digestRows,
	type ResumeBase,
	ResumeChecksum,
	ResumePoint,
	type WsRpcError,
} from "../../contracts/ws-rpc.js";
import type { DetailLengthMismatch } from "./session-detail-wire.js";

declare global {
	/**
	 * Test seam: the next change a checked subscription delivers that this
	 * matches is dropped, as a lost frame would be, while the cursor still
	 * moves past it. Cleared once it drops one.
	 */
	var __conduitDropChange: ((envelope: object) => boolean) | undefined;
}

/**
 * What a checked subscription holds: the base its last snapshot began, and
 * each row since applied, by id, at the version it moved at. Owned by the
 * caller, so a subscription opened again from a cursor it kept is checked too.
 */
export interface ResumeLedger {
	base: ResumeBase | undefined;
	/** The server's name for the base, when its snapshot carried one. */
	point: ResumePoint | undefined;
	readonly rows: Map<string, number>;
	/** The part rows seen under each message, which go when it goes. */
	readonly parts: Map<string, Set<string>>;
}

export const makeResumeLedger = (): ResumeLedger => ({
	base: undefined,
	point: undefined,
	rows: new Map(),
	parts: new Map(),
});

const clearLedger = (ledger: ResumeLedger) => {
	ledger.base = undefined;
	ledger.point = undefined;
	ledger.rows.clear();
	ledger.parts.clear();
};

/** The server's checksum of a resumed set disagrees with the ledger's. */
class ResumeChecksumMismatch extends Data.TaggedError(
	"ResumeChecksumMismatch",
) {}

/**
 * How far the consumer has provably got. `open` is the sequence currently being
 * delivered, which may still have siblings; `closed` is the newest sequence
 * known to have none left, and is the only safe thing to resume from. `seen`
 * identifies what has already been delivered at `open`, so that replaying the
 * open group repeats nothing.
 */
interface Cursor {
	readonly closed: number | undefined;
	readonly open: number | undefined;
	readonly seen: ReadonlySet<string>;
}

/** Shared because it is never mutated: `seen` is copied before it grows. */
const nothingSeen: ReadonlySet<string> = new Set();

/** One envelope's effect on the cursor, and whether the consumer should see it. */
interface Step {
	readonly cursor: Cursor;
	readonly deliver: boolean;
}

/** Envelopes that move the read model carry a sequence; `synchronized` does not. */
const sequenceOf = (envelope: object): number | undefined =>
	"sequence" in envelope && typeof envelope.sequence === "number"
		? envelope.sequence
		: undefined;

const tagOf = (envelope: object): string | undefined =>
	"_tag" in envelope && typeof envelope._tag === "string"
		? envelope._tag
		: undefined;

/** What an `upsert` wraps: a session row, or a transcript message or part. */
const payloadOf = (envelope: object): unknown => {
	if (!("item" in envelope)) return undefined;
	const item = envelope.item;
	if (typeof item !== "object" || item === null) return undefined;
	if ("message" in item) return item.message;
	if ("event" in item) return item.event;
	// A part is named by its message and its own id, as its removal is.
	if (
		"part" in item &&
		typeof item.part === "object" &&
		item.part !== null &&
		"id" in item.part &&
		"messageId" in item
	)
		return { id: JSON.stringify([item.messageId, item.part.id]) };
	return item;
};

/** A row is named by its id, a stored event by its OWN sequence, unique to it. */
const subjectOf = (payload: unknown): string | undefined => {
	if (typeof payload !== "object" || payload === null) return undefined;
	if ("id" in payload && typeof payload.id === "string") return payload.id;
	if ("sequence" in payload && typeof payload.sequence === "number")
		return String(payload.sequence);
	return undefined;
};

/**
 * What makes two envelopes at one sequence the same envelope, or `undefined`
 * when the shape does not say. `remove` names its subject outright; everything
 * else has it wrapped.
 */
const identityOf = (envelope: object): string | undefined => {
	const tag = tagOf(envelope);
	const subject =
		"id" in envelope && typeof envelope.id === "string"
			? envelope.id
			: subjectOf(payloadOf(envelope));
	return tag === undefined || subject === undefined
		? undefined
		: `${tag}:${subject}`;
};

/** A fresh base or a `synchronized` boundary leaves nothing in flight. */
const settled = (cursor: Cursor): Cursor => ({
	closed: cursor.open ?? cursor.closed,
	open: undefined,
	seen: nothingSeen,
});

const advance = (cursor: Cursor, envelope: object): Step => {
	const tag = tagOf(envelope);
	const closing = tag === "snapshot" || tag === "synchronized";
	const sequence = sequenceOf(envelope);
	const identity = identityOf(envelope);

	// A sibling of the group in flight. After a drop the server replays that
	// whole group, so whatever already reached the consumer stops here.
	if (!closing && sequence !== undefined && sequence === cursor.open)
		return identity === undefined
			? { cursor, deliver: true }
			: cursor.seen.has(identity)
				? { cursor, deliver: false }
				: {
						cursor: { ...cursor, seen: new Set(cursor.seen).add(identity) },
						deliver: true,
					};

	// A strictly greater sequence proves the one before it had no siblings left.
	// A lesser one is replay coalescing something we never saw: new to the
	// consumer, but it moves nothing, since `closed` is already past it.
	const opened =
		sequence === undefined ||
		(cursor.open !== undefined && sequence < cursor.open)
			? cursor
			: {
					closed: cursor.open ?? cursor.closed,
					open: sequence,
					seen: identity === undefined ? nothingSeen : new Set([identity]),
				};

	return { cursor: closing ? settled(opened) : opened, deliver: true };
};

/** Note one row the subscription holds, at the version it moved at. */
const holdRow = (ledger: ResumeLedger, envelope: object, version: number) => {
	const id = subjectOf(payloadOf(envelope));
	if (id === undefined) return;
	ledger.rows.set(id, Math.max(ledger.rows.get(id) ?? version, version));
	const item = "item" in envelope ? envelope.item : undefined;
	if (
		typeof item === "object" &&
		item !== null &&
		"part" in item &&
		"messageId" in item &&
		typeof item.messageId === "string"
	)
		ledger.parts.set(
			item.messageId,
			(ledger.parts.get(item.messageId) ?? new Set()).add(id),
		);
};

/**
 * Fold one delivered envelope into the ledger, and check a `synchronized`
 * that carries the server's checksum against it.
 */
const record = (
	ledger: ResumeLedger,
	envelope: object,
): Effect.Effect<void, ResumeChecksumMismatch> => {
	const sequence = sequenceOf(envelope);
	switch (tagOf(envelope)) {
		case "snapshot": {
			if (sequence === undefined) return Effect.void;
			clearLedger(ledger);
			ledger.base = {
				sequence,
				...("cursor" in envelope && typeof envelope.cursor === "string"
					? { cursor: envelope.cursor }
					: {}),
			};
			const point =
				"resumePoint" in envelope ? envelope.resumePoint : undefined;
			ledger.point = Schema.is(ResumePoint)(point) ? point : undefined;
			const rows: readonly unknown[] =
				"rows" in envelope && Array.isArray(envelope.rows) ? envelope.rows : [];
			for (const row of rows) holdRow(ledger, { item: row }, sequence);
			return Effect.void;
		}
		case "upsert":
			if (sequence !== undefined) holdRow(ledger, envelope, sequence);
			return Effect.void;
		case "remove": {
			if (!("id" in envelope) || typeof envelope.id !== "string")
				return Effect.void;
			ledger.rows.delete(envelope.id);
			// A removed message takes its parts.
			for (const part of ledger.parts.get(envelope.id) ?? [])
				ledger.rows.delete(part);
			ledger.parts.delete(envelope.id);
			return Effect.void;
		}
		case "synchronized": {
			const checksum = "checksum" in envelope ? envelope.checksum : undefined;
			if (ledger.base === undefined || !Schema.is(ResumeChecksum)(checksum))
				return Effect.void;
			const held = digestRows(ledger.rows, ledger.base.sequence);
			if (held.hash === checksum.hash && held.rows === checksum.rows)
				return Effect.void;
			console.warn("[resume] checksum mismatch, taking a fresh snapshot", {
				base: ledger.base,
				server: { hash: checksum.hash, rows: checksum.rows },
				client: held,
			});
			return Effect.fail(new ResumeChecksumMismatch());
		}
		default:
			return Effect.void;
	}
};

const reissueDelay = (failures: number): Duration.Duration =>
	Duration.millis(Math.min(50 * 2 ** (failures - 1), 1000));

/**
 * True when THIS fiber has been interrupted — i.e. the consumer unsubscribed.
 *
 * In the ordinary consumer shapes — a plain `Fiber.interrupt`, a
 * `Stream.interruptWhen` — the runtime unwinds past the handler below without
 * ever offering it the cause, which makes this look like dead code. It is not.
 * A consumer that pulls by hand inside an uninterruptible region has its
 * cancellation RECORDED but not yet delivered, so the handler does run, with the
 * consumer already gone; re-issuing there would talk to nobody, forever. The
 * test named "does not re-issue an interruption the consumer itself caused"
 * holds that shape open.
 */
const unsubscribed = Effect.map(
	Effect.descriptor,
	(fiber) => HashSet.size(fiber.interruptors) > 0,
);

/**
 * Wraps one subscription so a transport-class ending re-issues it from the last
 * sequence the consumer provably completed.
 *
 * `issue` is called with the sequence to resume from — `undefined` on the first
 * attempt unless `from` is given, and again on a drop that completed nothing, so
 * a subscription that never got a snapshot still asks for one. With a `ledger`
 * it is also given the base a resume is checked against, and the server's
 * point for it when there is one.
 *
 * `saved` is a snapshot kept from an earlier page load. It is delivered
 * first, before anything is asked, and the subscription resumes from it as
 * from any snapshot it was sent, so the server's checksum confirms it or a
 * fresh snapshot replaces it.
 */
export const resumeStream = <A extends object>(
	issue: (
		resumeFromSequence: number | undefined,
		resumeBase?: ResumeBase,
		resumePoint?: ResumePoint,
	) => Stream.Stream<A, WsRpcError | RpcClientError | DetailLengthMismatch>,
	options: {
		readonly from?: number | undefined;
		readonly onTransportDrop?: () => void;
		readonly ledger?: ResumeLedger;
		readonly saved?: A | undefined;
	} = {},
): Stream.Stream<A, WsRpcError> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const cursor = yield* Ref.make<Cursor>({
				closed: options.from,
				open: undefined,
				seen: nothingSeen,
			});
			const failures = yield* Ref.make(0);
			const ledger = options.ledger;

			const attempt = (): Stream.Stream<A, WsRpcError> =>
				Stream.unwrap(
					Effect.map(Ref.get(cursor), (at) =>
						at.closed === undefined || ledger?.base === undefined
							? issue(at.closed)
							: issue(at.closed, ledger.base, ledger.point),
					),
				).pipe(
					Stream.filterEffect((envelope) =>
						Effect.gen(function* () {
							yield* Ref.set(failures, 0);
							const deliver = yield* Ref.modify(cursor, (from) => {
								const step = advance(from, envelope);
								return [step.deliver, step.cursor];
							});
							if (!deliver || ledger === undefined) return deliver;
							const tag = tagOf(envelope);
							const drop = globalThis.__conduitDropChange;
							if (
								drop !== undefined &&
								(tag === "upsert" || tag === "remove") &&
								drop(envelope)
							) {
								globalThis.__conduitDropChange = undefined;
								return false;
							}
							yield* record(ledger, envelope);
							return true;
						}),
					),
					Stream.catchAllCause((cause): Stream.Stream<A, WsRpcError> => {
						// A defect is nobody's contract, and it decides before anything
						// else can be picked out of the cause. The rest goes with it: a
						// cause that killed us is not half a retryable thing.
						if (Chunk.isNonEmpty(Cause.defects(cause)))
							return Stream.failCause(Cause.flatMap(cause, Cause.die));

						// A suffix can only be decoded against the exact sent prefix,
						// and a view the server's checksum disowns cannot be resumed.
						// Ask the existing cold-start path for whole rows, even if the
						// cursor claims they were delivered.
						if (
							Chunk.some(
								Cause.failures(cause),
								(failure) =>
									failure._tag === "DetailLengthMismatch" ||
									failure._tag === "ResumeChecksumMismatch",
							)
						) {
							return Stream.unwrap(
								Ref.set(cursor, {
									closed: undefined,
									open: undefined,
									seen: nothingSeen,
								}).pipe(
									Effect.tap(() => {
										if (ledger !== undefined) clearLedger(ledger);
									}),
									Effect.as(reissue()),
								),
							);
						}

						// The server declining to serve this subscription is a domain
						// failure, deterministic, and re-issuing it would loop.
						const domain = Chunk.findFirst(
							Cause.failures(cause),
							(failure): failure is WsRpcError => failure._tag === "WsRpcError",
						);
						if (Option.isSome(domain)) return Stream.fail(domain.value);

						// What is left is transport class. An interruption is the
						// ambiguous one: a torn-down socket and an unsubscribe look
						// identical except in who was interrupted.
						const reissueAfterDrop = (): Stream.Stream<A, WsRpcError> =>
							Stream.unwrap(
								Effect.sync(() => options.onTransportDrop?.()).pipe(
									Effect.as(reissue()),
								),
							);
						return Cause.isInterrupted(cause)
							? Stream.unwrap(
									Effect.map(
										unsubscribed,
										(byConsumer): Stream.Stream<A, WsRpcError> =>
											byConsumer
												? Stream.failCause(Cause.stripFailures(cause))
												: reissueAfterDrop(),
									),
								)
							: reissueAfterDrop();
					}),
				);

			const reissue = (): Stream.Stream<A, WsRpcError> =>
				Stream.unwrap(
					Ref.getAndUpdate(failures, (n) => n + 1).pipe(
						Effect.flatMap((previous) =>
							previous === 0
								? Effect.void
								: Effect.sleep(reissueDelay(previous)),
						),
						Effect.map(attempt),
					),
				);

			const saved = options.saved;
			if (saved === undefined || ledger === undefined) return attempt();
			yield* Ref.update(cursor, (from) => advance(from, saved).cursor);
			yield* Effect.orDie(record(ledger, saved));
			return Stream.concat(Stream.make(saved), attempt());
		}),
	);
