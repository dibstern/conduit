// PTY Subscription (conduit-test-ni8.11)
// A project's terminals as one stream: a snapshot of every PTY with its
// scrollback ring, `synchronized`, then live changes.
//
// Not a read-model subscription: PTYs live in memory, not the event store, so
// there is no sequence to resume from. Every (re)subscribe is a cold snapshot,
// which is exactly what restores a reconnecting tab's scrollback intact. The
// snapshot is read in the same synchronous turn the listener attaches, so no
// change can fall between them and nothing needs de-duplicating.
//
// The scope is the project, by argument (the RPC's projectSlug picks the relay
// whose terminal service this reads). Terminals are not tied to a session.
//
// Coalescing lives here. A busy shell emits many small writes; each 50 ms
// window becomes one chunk with at most one `output` per terminal in a row, so
// the stream socket carries — and the client acks — one frame per window
// rather than one per write. Input is never coalesced (see PtyInput).

import { type Chunk, Duration, Effect, Queue, Stream } from "effect";
import type { PtyEnvelope, PtyEvent } from "../../../contracts/ws-rpc.js";
import {
	OpenCodeTerminalServiceTag,
	type TerminalServiceError,
} from "./terminal-service.js";

export const PTY_COALESCE_WINDOW = Duration.millis(50);
/** Bounds one window's chunk when a slow subscriber has a backlog. */
const PTY_COALESCE_MAX_EVENTS = 512;

/**
 * Merge each terminal's consecutive writes. A write joins the latest envelope
 * for the same terminal when that envelope is output; a `replace` restarts it.
 * Each terminal keeps its own order; independent terminals may interleave.
 */
export const coalescePtyEvents = (
	events: Chunk.Chunk<PtyEvent>,
): PtyEvent[] => {
	const merged: PtyEvent[] = [];
	const latest = new Map<string, number>();
	for (const event of events) {
		const ptyId =
			event._tag === "output"
				? event.ptyId
				: event._tag === "upsert"
					? event.item.id
					: event.id;
		const index = latest.get(ptyId);
		const previous = index === undefined ? undefined : merged[index];
		if (
			event._tag === "output" &&
			previous?._tag === "output" &&
			index !== undefined
		) {
			merged[index] = event.replace
				? event
				: { ...previous, data: previous.data + event.data };
			continue;
		}
		latest.set(ptyId, merged.length);
		merged.push(event);
	}
	return merged;
};

export const subscribePtys = (): Stream.Stream<
	PtyEnvelope,
	TerminalServiceError,
	OpenCodeTerminalServiceTag
> =>
	Stream.unwrapScoped(
		Effect.gen(function* () {
			const terminal = yield* OpenCodeTerminalServiceTag;
			const discovered = yield* terminal.list();
			const queue = yield* Queue.unbounded<PtyEvent>();
			const { rows } = yield* Effect.acquireRelease(
				Effect.sync(() => ({
					rows: terminal.snapshot(),
					unsubscribe: terminal.subscribe((event) =>
						Queue.unsafeOffer(queue, event),
					),
				})),
				({ unsubscribe }) => Effect.sync(unsubscribe),
			);
			const tracked = new Set(rows.map(({ pty }) => pty.id));
			const snapshot: PtyEnvelope = {
				_tag: "snapshot",
				rows: [
					...rows,
					...discovered
						.filter(({ id }) => !tracked.has(id))
						.map((pty) => ({ pty, scrollback: "" })),
				],
			};
			return Stream.concat(
				Stream.make(snapshot, { _tag: "synchronized" } as const),
				Stream.fromQueue(queue).pipe(
					Stream.groupedWithin(PTY_COALESCE_MAX_EVENTS, PTY_COALESCE_WINDOW),
					Stream.mapConcat(coalescePtyEvents),
				),
			);
		}),
	);
