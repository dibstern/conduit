import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import { describe, it } from "@effect/vitest";
import { Chunk, Effect, Layer, Queue, Schema, Stream } from "effect";
import { expect } from "vitest";
import type { SessionDetailEnvelope } from "../../../src/lib/contracts/ws-rpc.js";
import {
	SessionDetailEnvelopeSchema,
	WsRpcError,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import {
	type SessionDetailItem,
	subscribeSessionDetail,
} from "../../../src/lib/domain/relay/Services/session-detail-subscription.js";
import { encodeSessionDetail } from "../../../src/lib/domain/relay/Services/session-detail-wire.js";
import {
	SessionEventBusLive,
	type SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { resumeStream } from "../../../src/lib/frontend/transport/resume.js";
import { decodeSessionDetail } from "../../../src/lib/frontend/transport/session-detail-wire.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import type { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const wireRoundTrip = (
	envelope: SessionDetailEnvelope,
): SessionDetailEnvelope =>
	Schema.decodeUnknownSync(SessionDetailEnvelopeSchema)(
		JSON.parse(
			JSON.stringify(Schema.encodeSync(SessionDetailEnvelopeSchema)(envelope)),
		),
	);

const row = (text: string): SessionDetailItem => ({
	_tag: "transcriptMessage",
	message: {
		id: "m",
		role: "assistant",
		text,
		parts: [{ id: "p", type: "text", text }],
	},
});

const testLayer = () => {
	const dir = mkdtempSync(join(process.cwd(), ".suffix-test-"));
	return Layer.mergeAll(
		makePersistenceEffectLayer(
			join(dir, "events.db"),
			undefined,
			SessionEventBusLive,
		),
		SessionEventBusLive,
		Layer.scopedDiscard(
			Effect.addFinalizer(() =>
				Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
			),
		),
	);
};

describe("session detail wire", () => {
	for (const damage of ["missed", "reordered", "duplicated"] as const) {
		it.effect(`a ${damage} suffix repairs the transcript`, () =>
			Effect.gen(function* () {
				const encoded = Chunk.toReadonlyArray(
					yield* Stream.fromIterable<SessionDetailEnvelope>([
						{ _tag: "snapshot", rows: [row("A")], sequence: 1 },
						{ _tag: "synchronized" },
						{ _tag: "upsert", item: row("AB"), sequence: 2 },
						{ _tag: "upsert", item: row("ABC"), sequence: 3 },
					]).pipe(encodeSessionDetail, Stream.runCollect),
				);
				const [snapshot, synchronized, first, last] = encoded;
				if (!snapshot || !synchronized || !first || !last)
					throw new Error("missing wire envelope");
				const broken =
					damage === "missed"
						? [last]
						: damage === "reordered"
							? [last, first]
							: [first, first, last];
				let attempts = 0;
				const delivered = yield* resumeStream(() =>
					Stream.fromIterable<SessionDetailEnvelope>(
						attempts++ === 0
							? [snapshot, synchronized, ...broken]
							: [
									{ _tag: "snapshot", rows: [row("ABC")], sequence: 3 },
									{ _tag: "synchronized" },
								],
					).pipe(Stream.map(wireRoundTrip), decodeSessionDetail),
				).pipe(Stream.runCollect);
				expect(attempts).toBe(2);
				expect(Chunk.toReadonlyArray(delivered).slice(-2)).toEqual([
					{ _tag: "snapshot", rows: [row("ABC")], sequence: 3 },
					{ _tag: "synchronized" },
				]);
			}),
		);
	}

	it.effect(
		"rewrites, truncation, removed parts and replacement snapshots remain authoritative",
		() =>
			Effect.gen(function* () {
				const input: SessionDetailEnvelope[] = [
					{ _tag: "snapshot", rows: [row("Hello")], sequence: 1 },
					{ _tag: "synchronized" },
					{ _tag: "upsert", item: row("Other"), sequence: 2 },
					{ _tag: "upsert", item: row("Oh"), sequence: 3 },
					{
						_tag: "upsert",
						item: {
							_tag: "transcriptMessage",
							message: { id: "m", role: "assistant", parts: [] },
						},
						sequence: 4,
					},
					{ _tag: "upsert", item: row("Restored"), sequence: 5 },
					{ _tag: "snapshot", rows: [row("Base")], sequence: 6 },
					{ _tag: "synchronized" },
					{ _tag: "upsert", item: row("Base plus"), sequence: 7 },
				];
				const source = Stream.fromIterable(input).pipe(encodeSessionDetail);
				const first = yield* source.pipe(Stream.runCollect);
				const second = yield* source.pipe(Stream.runCollect);
				expect(second).toEqual(first);
				expect(Chunk.toReadonlyArray(first).slice(0, 8)).toEqual(
					input.slice(0, 8),
				);
				expect(
					Chunk.toReadonlyArray(
						yield* source.pipe(
							Stream.map(wireRoundTrip),
							decodeSessionDetail,
							Stream.runCollect,
						),
					),
				).toEqual(input);
			}),
	);

	it.effect(
		"a resumed subscriber with stale server sent state and no client buffer repairs by length check",
		() =>
			Effect.gen(function* () {
				// Retain the server's sent prefix, then reconnect only the client. This
				// deliberately violates our usual per-execution reset discipline.
				const sent = yield* Stream.fromIterable<SessionDetailEnvelope>([
					{ _tag: "snapshot", rows: [row("Hello")], sequence: 7 },
					{ _tag: "synchronized" },
					{ _tag: "upsert", item: row("Hello world"), sequence: 8 },
				]).pipe(encodeSessionDetail, Stream.runCollect);
				const staleSuffix = Chunk.last(sent);
				if (staleSuffix._tag !== "Some") throw new Error("missing suffix");
				expect(staleSuffix.value).toMatchObject({
					textSuffixes: [
						{ from: 5, total: 11 },
						{ partId: "p", from: 5, total: 11 },
					],
				});
				const requests: (number | undefined)[] = [];
				const delivered = yield* resumeStream(
					(cursor) => {
						requests.push(cursor);
						return Stream.fromIterable<SessionDetailEnvelope>(
							cursor === undefined
								? [
										{
											_tag: "snapshot",
											rows: [row("Hello world")],
											sequence: 8,
										},
										{ _tag: "synchronized" },
									]
								: [{ _tag: "synchronized" }, staleSuffix.value],
						).pipe(Stream.map(wireRoundTrip), decodeSessionDetail);
					},
					{ from: 7 },
				).pipe(Stream.runCollect);
				expect(requests).toEqual([7, undefined]);
				expect(Chunk.toReadonlyArray(delivered)).toEqual([
					{ _tag: "synchronized" },
					{ _tag: "snapshot", rows: [row("Hello world")], sequence: 8 },
					{ _tag: "synchronized" },
				]);
			}),
	);

	it.effect(
		"replay seeds decoding before duplicate suppression and remains whole on the wire",
		() =>
			Effect.gen(function* () {
				let attempt = 0;
				const wire: SessionDetailEnvelope[] = [];
				const delivered = yield* resumeStream(() => {
					const envelopes: SessionDetailEnvelope[] =
						attempt++ === 0
							? [
									{ _tag: "snapshot", rows: [], sequence: 0 },
									{ _tag: "synchronized" },
									{ _tag: "upsert", item: row("Hello"), sequence: 1 },
								]
							: [
									{ _tag: "upsert", item: row("Hello"), sequence: 1 },
									{ _tag: "synchronized" },
									{ _tag: "upsert", item: row("Hello world"), sequence: 2 },
								];
					const source = Stream.fromIterable(envelopes).pipe(
						encodeSessionDetail,
						Stream.map(wireRoundTrip),
						Stream.tap((env) => Effect.sync(() => wire.push(env))),
					);
					return (
						attempt === 1
							? Stream.concat(
									source,
									Stream.fail(
										new RpcClientError({
											reason: "Unknown",
											message: "disconnect",
										}),
									),
								)
							: source
					).pipe(decodeSessionDetail);
				}).pipe(Stream.runCollect);
				expect(wire[3]).toEqual({
					_tag: "upsert",
					item: row("Hello"),
					sequence: 1,
				});
				expect(wire[5]).toMatchObject({
					textSuffixes: [
						{ from: 5, total: 11 },
						{ partId: "p", from: 5, total: 11 },
					],
				});
				expect(Chunk.toReadonlyArray(delivered)).toEqual([
					{ _tag: "snapshot", rows: [], sequence: 0 },
					{ _tag: "synchronized" },
					{ _tag: "upsert", item: row("Hello"), sequence: 1 },
					{ _tag: "synchronized" },
					{ _tag: "upsert", item: row("Hello world"), sequence: 2 },
				]);
			}),
	);
	it.scoped(
		"a corrupted total requests a whole-row snapshot and streaming continues correctly",
		() =>
			Effect.gen(function* () {
				yield* (yield* ProjectionRunnerEffectTag).recover();
				const commit = yield* makeCommitAndSignal;
				yield* commit([
					canonicalEvent(
						"session.created",
						"s",
						{ sessionId: "s", title: "Repair", provider: "claude" },
						{ provider: "claude", createdAt: 1 },
					),
					canonicalEvent(
						"message.created",
						"s",
						{ sessionId: "s", messageId: "m", role: "assistant" },
						{ provider: "claude", createdAt: 2 },
					),
					canonicalEvent(
						"text.delta",
						"s",
						{ messageId: "m", partId: "p", text: "Hello" },
						{ provider: "claude", createdAt: 3 },
					),
				]);
				const issued: (number | undefined)[] = [];
				const context = yield* Effect.context<
					ReadQueryEffectTag | SessionEventBusTag
				>();
				let corrupt = true;
				const output = yield* Queue.unbounded<SessionDetailEnvelope>();
				yield* resumeStream((resumeFromSequence) => {
					issued.push(resumeFromSequence);
					return subscribeSessionDetail({
						sessionId: "s",
						...(resumeFromSequence === undefined ? {} : { resumeFromSequence }),
					}).pipe(
						encodeSessionDetail,
						Stream.map(wireRoundTrip),
						Stream.map((envelope) => {
							if (
								corrupt &&
								envelope._tag === "upsert" &&
								envelope.textSuffixes
							) {
								corrupt = false;
								return {
									...envelope,
									textSuffixes: envelope.textSuffixes.map((field) => ({
										...field,
										total: field.total + 1,
									})),
								};
							}
							return envelope;
						}),
						Stream.mapError(
							(error) => new WsRpcError({ message: String(error) }),
						),
						decodeSessionDetail,
						Stream.provideContext(context),
					);
				}).pipe(
					Stream.runForEach((envelope) => Queue.offer(output, envelope)),
					Effect.forkScoped,
				);
				expect((yield* Queue.take(output))._tag).toBe("snapshot");
				expect(yield* Queue.take(output)).toEqual({ _tag: "synchronized" });
				yield* commit([
					canonicalEvent(
						"text.delta",
						"s",
						{ messageId: "m", partId: "p", text: " world" },
						{ provider: "claude", createdAt: 4 },
					),
				]);
				const repair = yield* Queue.take(output);
				expect(repair._tag).toBe("snapshot");
				if (repair._tag !== "snapshot")
					throw new Error("expected whole-row repair");
				expect(repair.rows).toMatchObject([
					{
						message: { text: "Hello world", parts: [{ text: "Hello world" }] },
					},
				]);
				expect(yield* Queue.take(output)).toEqual({ _tag: "synchronized" });
				expect(issued).toEqual([undefined, undefined]);
				yield* commit([
					canonicalEvent(
						"text.delta",
						"s",
						{ messageId: "m", partId: "p", text: "!" },
						{ provider: "claude", createdAt: 5 },
					),
				]);
				expect(yield* Queue.take(output)).toMatchObject({
					_tag: "upsert",
					item: {
						message: {
							text: "Hello world!",
							parts: [{ text: "Hello world!" }],
						},
					},
				});
			}).pipe(Effect.provide(testLayer())),
	);
	it.scoped(
		"delivers linear UTF-8 bytes across N persisted streaming part writes",
		() =>
			Effect.gen(function* () {
				const runner = yield* ProjectionRunnerEffectTag;
				yield* runner.recover();
				const commit = yield* makeCommitAndSignal;
				const measurements: {
					writes: number;
					finalBytes: number;
					deliveredBytes: number;
				}[] = [];
				for (const writes of [32, 64, 128, 256]) {
					const sessionId = `s${writes}`;
					yield* commit([
						canonicalEvent(
							"session.created",
							sessionId,
							{ sessionId, title: "Bytes", provider: "claude" },
							{ provider: "claude", createdAt: 1 },
						),
						canonicalEvent(
							"message.created",
							sessionId,
							{ sessionId, messageId: sessionId, role: "assistant" },
							{ provider: "claude", createdAt: 2 },
						),
					]);
					const output = yield* Queue.unbounded<Envelope<SessionDetailItem>>();
					let deliveredBytes = 0;
					yield* subscribeSessionDetail({ sessionId }).pipe(
						encodeSessionDetail,
						Stream.map((envelope) => {
							const json = JSON.stringify(
								Schema.encodeSync(SessionDetailEnvelopeSchema)(envelope),
							);
							deliveredBytes += Buffer.byteLength(json);
							return Schema.decodeUnknownSync(SessionDetailEnvelopeSchema)(
								JSON.parse(json),
							);
						}),
						decodeSessionDetail,
						Stream.runForEach((envelope) => Queue.offer(output, envelope)),
						Effect.forkScoped,
					);
					yield* Queue.take(output);
					yield* Queue.take(output);
					const piece = "🦊é".repeat(16);
					for (let i = 0; i < writes; i++) {
						yield* commit([
							canonicalEvent(
								"text.delta",
								sessionId,
								{ messageId: sessionId, partId: `${sessionId}-p`, text: piece },
								{ provider: "claude", createdAt: i + 3 },
							),
						]);
						const delivered = yield* Queue.take(output);
						if (i === writes - 1)
							expect(delivered).toMatchObject({
								item: {
									message: {
										text: piece.repeat(writes),
										parts: [{ text: piece.repeat(writes) }],
									},
								},
							});
					}
					measurements.push({
						writes,
						finalBytes: Buffer.byteLength(piece.repeat(writes)),
						deliveredBytes,
					});
				}
				console.log("wire bytes", JSON.stringify(measurements));
				for (let i = 1; i < measurements.length; i++) {
					const previous = measurements[i - 1];
					const current = measurements[i];
					if (!previous || !current) throw new Error("missing measurement");
					expect(current.deliveredBytes / previous.deliveredBytes).toBeLessThan(
						2.2,
					);
					expect(current.deliveredBytes).toBeLessThan(current.finalBytes * 10);
				}
			}).pipe(Effect.provide(testLayer())),
	);
});
