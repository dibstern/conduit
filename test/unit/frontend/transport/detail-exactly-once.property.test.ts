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

// Each message holds at most one text part: `clear` deletes that part alone.
type Change = {
	readonly id: "a" | "b" | "c";
	readonly kind: "grow" | "remove" | "clear";
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
const part = (id: string, text: string): Row => ({
	_tag: "part",
	messageId: id,
	sortOrder: 0,
	part: { id: `${id}-text`, type: "text", text },
});
const partKey = (id: string) => JSON.stringify([id, `${id}-text`]);
// The name a row shares with its own removal.
const keyOf = (
	row: Extract<SessionDetailEnvelope, { _tag: "upsert" }>["item"],
) => {
	if (row._tag === "message") return row.message.id;
	if (row._tag === "part") return partKey(row.messageId);
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
});
const lost = () =>
	new RpcClientError({ reason: "Protocol", message: "scripted drop" });

// The event log owns state independently of the client. One event can fan out to
// multiple envelopes with one sequence, and removals are durable tombstones.
function logOf(events: readonly Event[]) {
	// Message id to its text part's text, absent when the part is deleted.
	const state = new Map<string, { text?: string }>();
	const log: SessionDetailEnvelope[] = [];
	for (const [index, changes] of events.entries()) {
		const sequence = index + 1;
		const changed = new Map<string, SessionDetailEnvelope>();
		const upsert = (item: Row) =>
			changed.set(keyOf(item), { _tag: "upsert", item, sequence });
		for (const change of changes) {
			const held = state.get(change.id);
			if (change.kind === "remove") {
				state.delete(change.id);
				changed.set(change.id, { _tag: "remove", id: change.id, sequence });
				changed.delete(partKey(change.id));
			} else if (change.kind === "clear") {
				if (held) state.set(change.id, {});
				const id = partKey(change.id);
				changed.set(id, { _tag: "remove", id, sequence });
			} else {
				const text = (held?.text ?? "") + change.text;
				state.set(change.id, { text });
				if (!held) upsert(header(change.id));
				upsert(part(change.id, text));
			}
		}
		log.push(...changed.values());
	}
	const rows = [...state].flatMap(([id, { text }]) =>
		text === undefined ? [header(id)] : [header(id), part(id, text)],
	);
	return { log, rows, head: events.length };
}

// Sent prefixes belong to this subscription only. Replay is whole rows;
// suffixes are allowed only after its own synchronized boundary.
function wire(envelopes: readonly SessionDetailEnvelope[], corrupt: boolean) {
	const sent = new Map<string, string>();
	let live = false;
	let injected = false;
	return envelopes.map((envelope): SessionDetailEnvelope => {
		if (envelope._tag === "snapshot") {
			sent.clear();
			for (const row of envelope.rows)
				if (row._tag === "part") sent.set(row.messageId, row.part.text ?? "");
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
			if (Array.isArray(pair)) sent.delete(String(pair[0]));
			return envelope;
		}
		const row = envelope.item;
		if (row._tag !== "part") return envelope;
		const text = row.part.text ?? "";
		const before = sent.get(row.messageId);
		sent.set(row.messageId, text);
		if (!live || before === undefined || !text.startsWith(before))
			return envelope;
		const wrong = corrupt && !injected;
		if (wrong) injected = true;
		return {
			...envelope,
			item: part(row.messageId, text.slice(before.length)),
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
			kind: fc.constantFrom("grow", "remove", "clear"),
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
						[{ id: "a", kind: "grow", text: "base" }],
						...generated,
						[
							{ id: "b", kind: "grow", text: "tail" },
							{ id: "c", kind: "grow", text: "tail" },
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
					expect(actual.rows).toEqual(canonical.rows);
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
