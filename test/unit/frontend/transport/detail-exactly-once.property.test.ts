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

type Change = {
	readonly id: "a" | "b" | "c";
	readonly kind: "grow" | "remove";
	readonly text: string;
};
type Event = readonly Change[];
type Row = Extract<SessionDetailEnvelope, { _tag: "upsert" }>["item"] & {
	_tag: "transcriptMessage";
};

const item = (id: string, text: string): Row => ({
	_tag: "transcriptMessage",
	message: {
		id,
		role: "assistant",
		time: { created: id.charCodeAt(0) },
		parts: [{ id: `${id}-text`, type: "text", text }],
	},
});
const empty = (): TranscriptEntry => ({
	project: "project",
	rows: [],
	hwm: null,
	hasMore: false,
	status: { _tag: "live" },
	pending: [],
});
const lost = () =>
	new RpcClientError({ reason: "Protocol", message: "scripted drop" });

// The event log owns state independently of the client. One event can fan out to
// multiple envelopes with one sequence, and removals are durable tombstones.
function logOf(events: readonly Event[]) {
	const state = new Map<string, Row>();
	const log: SessionDetailEnvelope[] = [];
	for (const [index, changes] of events.entries()) {
		const sequence = index + 1;
		const changed = new Map<string, SessionDetailEnvelope>();
		for (const change of changes) {
			if (change.kind === "remove") {
				state.delete(change.id);
				changed.set(change.id, { _tag: "remove", id: change.id, sequence });
			} else {
				const previous = state.get(change.id)?.message.parts?.[0]?.text ?? "";
				const next = item(change.id, previous + change.text);
				state.set(change.id, next);
				changed.set(change.id, { _tag: "upsert", item: next, sequence });
			}
		}
		log.push(...changed.values());
	}
	return { log, rows: [...state.values()], head: events.length };
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
				if (row._tag === "transcriptMessage")
					sent.set(row.message.id, row.message.parts?.[0]?.text ?? "");
			live = false;
			return envelope;
		}
		if (envelope._tag === "synchronized") {
			live = true;
			return envelope;
		}
		if (envelope._tag === "remove") {
			sent.delete(envelope.id);
			return envelope;
		}
		if (envelope.item._tag !== "transcriptMessage") return envelope;
		const row = envelope.item.message;
		const text = row.parts?.[0]?.text ?? "";
		const before = sent.get(row.id);
		sent.set(row.id, text);
		if (!live || before === undefined || !text.startsWith(before))
			return envelope;
		const wrong = corrupt && !injected;
		if (wrong) injected = true;
		return {
			...envelope,
			item: item(row.id, text.slice(before.length)),
			textSuffixes: [
				{
					partId: `${row.id}-text`,
					from: wrong ? text.length + 1 : before.length,
					total: text.length,
				},
			],
		};
	});
}

function coalesce(envelopes: readonly SessionDetailEnvelope[]) {
	const latest = new Map<string, SessionDetailEnvelope>();
	for (const envelope of envelopes) {
		if (envelope._tag === "remove") latest.set(envelope.id, envelope);
		if (
			envelope._tag === "upsert" &&
			envelope.item._tag === "transcriptMessage"
		)
			latest.set(envelope.item.message.id, envelope);
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
			kind: fc.constantFrom("grow", "remove"),
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
										envelope.textSuffixes?.some(
											(suffix) => suffix.from > suffix.total,
										),
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
