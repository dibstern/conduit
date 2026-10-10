import { RpcClientError } from "@effect/rpc/RpcClientError";
import { Chunk, Effect, Stream } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SessionDetailEnvelope } from "../../../../src/lib/contracts/ws-rpc.js";
import {
	applyTranscriptEnvelope,
	type TranscriptEntry,
} from "../../../../src/lib/frontend/stores/transcript.svelte.js";
import { resumeStream } from "../../../../src/lib/frontend/transport/resume.js";
import { decodeSessionDetail } from "../../../../src/lib/frontend/transport/session-detail-wire.js";

// Each message holds up to two text parts: `clear` deletes one part alone, a
// later slot can be written before an earlier one, and `flip` swaps the slots'
// places the way a reconcile re-sends a message's parts in a new order.
type Slot = 0 | 1;
type Change = {
	readonly id: "a" | "b" | "c";
	readonly kind: "grow" | "remove" | "clear" | "flip";
	readonly slot: Slot;
	readonly text: string;
};
type Event = readonly Change[];
type Row = Extract<
	Extract<SessionDetailEnvelope, { _tag: "upsert" }>["item"],
	{ _tag: "message" | "part" }
>;

const header = (id: string): Row => ({
	_tag: "message",
	message: { id, role: "assistant", time: { created: id.charCodeAt(0) } },
});
const part = (
	id: string,
	slot: Slot,
	text: string,
	sortOrder: number,
): Row => ({
	_tag: "part",
	messageId: id,
	sortOrder,
	part: { id: `${id}-${slot}`, type: "text", text },
});
const partKey = (id: string, slot: Slot) =>
	JSON.stringify([id, `${id}-${slot}`]);
// The name a row shares with its own removal.
const keyOf = (
	row: Extract<SessionDetailEnvelope, { _tag: "upsert" }>["item"],
) => {
	if (row._tag === "message") return row.message.id;
	if (row._tag === "part") return JSON.stringify([row.messageId, row.part.id]);
	throw new Error(`unexpected ${row._tag} row`);
};
const empty = (): TranscriptEntry => ({
	project: "project",
	rows: [],
	hwm: null,
	hasMore: false,
	status: { _tag: "live" },
	pending: [],
	waiting: new Map(),
	partOrder: new Map(),
});
const lost = () =>
	new RpcClientError({ reason: "Protocol", message: "scripted drop" });

// The event log owns state independently of the client. One event can fan out to
// multiple envelopes with one sequence, and removals are durable tombstones.
function logOf(events: readonly Event[]) {
	// Message id to its parts' text by slot; a deleted part has no slot.
	const state = new Map<string, Map<Slot, string>>();
	// Messages whose slots sit in reverse order.
	const flipped = new Set<string>();
	const orderOf = (id: string, slot: Slot) =>
		flipped.has(id) ? 1 - slot : slot;
	const log: SessionDetailEnvelope[] = [];
	for (const [index, changes] of events.entries()) {
		const sequence = index + 1;
		const changed = new Map<string, SessionDetailEnvelope>();
		const upsert = (item: Row) =>
			changed.set(keyOf(item), { _tag: "upsert", item, sequence });
		for (const change of changes) {
			const held = state.get(change.id);
			if (change.kind === "remove") {
				// A message removed and grown again in one event is never seen
				// gone, so its old parts go by name.
				for (const slot of held?.keys() ?? []) {
					const id = partKey(change.id, slot);
					changed.set(id, { _tag: "remove", id, sequence });
				}
				state.delete(change.id);
				flipped.delete(change.id);
				changed.delete(change.id);
				changed.set(change.id, { _tag: "remove", id: change.id, sequence });
			} else if (change.kind === "flip") {
				if (!held) continue;
				if (!flipped.delete(change.id)) flipped.add(change.id);
				for (const [slot, text] of held)
					upsert(part(change.id, slot, text, orderOf(change.id, slot)));
				changed.delete(change.id);
				upsert(header(change.id));
			} else if (change.kind === "clear") {
				held?.delete(change.slot);
				const id = partKey(change.id, change.slot);
				changed.set(id, { _tag: "remove", id, sequence });
			} else {
				const parts = held ?? new Map<Slot, string>();
				const text = (parts.get(change.slot) ?? "") + change.text;
				state.set(change.id, parts.set(change.slot, text));
				upsert(
					part(change.id, change.slot, text, orderOf(change.id, change.slot)),
				);
				// As the server sends it: a new message's header after its parts.
				if (!held) {
					changed.delete(change.id);
					upsert(header(change.id));
				}
			}
		}
		log.push(...changed.values());
	}
	const rows = [...state].flatMap(([id, parts]) => [
		...[...parts]
			.sort(([left], [right]) => orderOf(id, left) - orderOf(id, right))
			.map(([slot, text]) => part(id, slot, text, orderOf(id, slot))),
		header(id),
	]);
	return { log, rows, head: events.length };
}

// Sent prefixes belong to this subscription only. Replay is whole rows;
// suffixes are allowed only after its own synchronized boundary.
function wire(envelopes: readonly SessionDetailEnvelope[], corrupt: boolean) {
	// Part id to the message that holds it and the text last sent for it.
	const sent = new Map<string, { messageId: string; text: string }>();
	let live = false;
	let injected = false;
	return envelopes.map((envelope): SessionDetailEnvelope => {
		if (envelope._tag === "snapshot") {
			sent.clear();
			for (const row of envelope.rows)
				if (row._tag === "part")
					sent.set(row.part.id, {
						messageId: row.messageId,
						text: row.part.text ?? "",
					});
			live = false;
			return envelope;
		}
		if (envelope._tag === "synchronized") {
			live = true;
			return envelope;
		}
		if (envelope._tag === "remove") {
			const pair: unknown = envelope.id.startsWith("[")
				? JSON.parse(envelope.id)
				: [envelope.id];
			if (Array.isArray(pair) && pair.length === 2)
				sent.delete(String(pair[1]));
			else
				for (const [partId, { messageId }] of sent)
					if (messageId === envelope.id) sent.delete(partId);
			return envelope;
		}
		const row = envelope.item;
		if (row._tag !== "part") return envelope;
		const text = row.part.text ?? "";
		const before = sent.get(row.part.id)?.text;
		sent.set(row.part.id, { messageId: row.messageId, text });
		if (!live || before === undefined || !text.startsWith(before))
			return envelope;
		const wrong = corrupt && !injected;
		if (wrong) injected = true;
		return {
			...envelope,
			item: { ...row, part: { ...row.part, text: text.slice(before.length) } },
			textSuffix: {
				from: wrong ? text.length + 1 : before.length,
				total: text.length,
			},
		};
	});
}

function coalesce(envelopes: readonly SessionDetailEnvelope[]) {
	const latest = new Map<string, SessionDetailEnvelope>();
	for (const envelope of envelopes) {
		if (envelope._tag === "remove") latest.set(envelope.id, envelope);
		if (envelope._tag === "upsert") latest.set(keyOf(envelope.item), envelope);
	}
	return [...latest.values()].sort((a, b) => {
		const left = "sequence" in a ? a.sequence : 0;
		const right = "sequence" in b ? b.sequence : 0;
		return left - right;
	});
}

async function fold<E>(stream: Stream.Stream<SessionDetailEnvelope, E>) {
	const delivered = Chunk.toReadonlyArray(
		await Effect.runPromise(Stream.runCollect(stream).pipe(Effect.orDie)),
	);
	return delivered.reduce(applyTranscriptEnvelope, empty());
}

describe("session detail exactly once", () => {
	it("converges to the canonical transcript across drops, replay shapes and corrupt suffixes", async () => {
		const change = fc.record({
			id: fc.constantFrom("a", "b", "c"),
			kind: fc.constantFrom("grow", "remove", "clear", "flip"),
			slot: fc.constantFrom<Slot>(0, 1),
			text: fc.constantFrom("x", "y", "💡"),
		});
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.array(change, { minLength: 1, maxLength: 2 }), {
					minLength: 1,
					maxLength: 6,
				}),
				fc.nat(30),
				fc.nat(30),
				fc.boolean(),
				fc.boolean(),
				async (generated, firstCut, secondCut, coalesced, corrupt) => {
					// A final two-row event makes a cut between siblings a routine case.
					const events: Event[] = [
						[{ id: "a", kind: "grow", slot: 0, text: "base" }],
						...generated,
						[
							{ id: "b", kind: "grow", slot: 1, text: "tail" },
							{ id: "c", kind: "grow", slot: 0, text: "tail" },
						],
					];
					const { log, rows, head } = logOf(events);
					const cold: SessionDetailEnvelope = {
						_tag: "snapshot",
						sequence: 0,
						rows: [],
					};
					const synchronized: SessionDetailEnvelope = { _tag: "synchronized" };
					const canonical = await fold(
						decodeSessionDetail(
							Stream.fromIterable(wire([cold, synchronized, ...log], false)),
						),
					);
					let attempts = 0;
					let mismatchInjected = false;
					const cursors: Array<number | undefined> = [];
					const resumed = resumeStream((from) => {
						cursors.push(from);
						const attempt = attempts++;
						const replay =
							from === undefined
								? [
										{
											_tag: "snapshot",
											sequence: attempt === 0 ? 0 : head,
											rows: attempt === 0 ? [] : rows,
										} satisfies SessionDetailEnvelope,
									]
								: coalesced
									? coalesce(
											log.filter(
												(envelope) =>
													"sequence" in envelope && envelope.sequence > from,
											),
										)
									: log.filter(
											(envelope) =>
												"sequence" in envelope && envelope.sequence > from,
										);
						const base =
							from === undefined && attempt === 0
								? [...replay, synchronized, ...log]
								: [...replay, synchronized];
						const encoded = wire(base, corrupt && !mismatchInjected);
						const cut =
							attempt === 0
								? firstCut % (encoded.length + 1)
								: attempt === 1
									? secondCut % (encoded.length + 1)
									: encoded.length;
						const stopped = attempt < 2 && cut < encoded.length;
						if (
							encoded
								.slice(0, cut)
								.some(
									(envelope) =>
										envelope._tag === "upsert" &&
										envelope.textSuffix !== undefined &&
										envelope.textSuffix.from > envelope.textSuffix.total,
								)
						)
							mismatchInjected = true;
						return decodeSessionDetail(
							Stream.fromIterable(encoded.slice(0, cut)).pipe(
								stopped
									? Stream.concat(Stream.fail(lost()))
									: (stream) => stream,
							),
						);
					});
					const actual = await fold(resumed);
					// Laid down whole, each message's parts are in their order.
					const whole = [
						{ _tag: "snapshot", sequence: head, rows } as const,
					].reduce(applyTranscriptEnvelope, empty());
					expect(canonical.rows).toEqual(whole.rows);
					expect(actual.rows).toEqual(whole.rows);
					expect(actual.hwm).toBe(head);
					expect(canonical.hwm).toBe(head);
					if (mismatchInjected) expect(cursors.slice(1)).toContain(undefined);
					expect(cursors.length).toBeLessThanOrEqual(4);
				},
			),
			{ numRuns: 60 },
		);
	});
});
