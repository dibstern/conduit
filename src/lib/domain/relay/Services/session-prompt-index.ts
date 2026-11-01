import { Effect, Stream } from "effect";
import {
	type SessionPromptIndexEnvelope,
	type SessionPromptSummary,
	WsRpcError,
} from "../../../contracts/ws-rpc.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { stream } from "./read-model-subscription.js";
import { SessionEventBusTag } from "./session-event-bus.js";

/** Compact full-session projection; bodies and their paging never write it. */
export const subscribeSessionPromptIndex = (options: {
	readonly sessionId: string;
}) =>
	Stream.unwrap(
		Effect.gen(function* () {
			const query = yield* ReadQueryEffectTag;
			const bus = yield* SessionEventBusTag;
			return stream({
				bus,
				source: {
					name: `session-prompt-index/${options.sessionId}`,
					collections: ["messages", "sessions"],
					shareReads: true,
					resume: "catchUp",
					read: (range) =>
						query.readSessionPromptIndex(options.sessionId, range),
					route: (advance) => ({
						moved: advance.sessionIds.includes(options.sessionId),
						removed: [],
					}),
				},
			}).pipe(
				Stream.flatMap((envelope) => {
					if (envelope._tag !== "snapshot")
						return Buffer.byteLength(JSON.stringify(envelope), "utf8") <=
							64 * 1024
							? Stream.succeed(envelope)
							: Stream.fail(
									new WsRpcError({
										message: "Prompt summary exceeds frame budget",
									}),
								);
					const frames: SessionPromptIndexEnvelope[] = [];
					let rows: SessionPromptSummary[] = [];
					const frame = (): SessionPromptIndexEnvelope => ({
						_tag: frames.length === 0 ? "snapshot" : "snapshotChunk",
						rows,
						sequence: envelope.sequence,
					});
					for (const row of envelope.rows) {
						const candidate = { ...frame(), rows: [...rows, row] };
						if (
							rows.length > 0 &&
							(rows.length >= 128 ||
								Buffer.byteLength(JSON.stringify(candidate), "utf8") >
									64 * 1024)
						) {
							frames.push(frame());
							rows = [];
						}
						rows.push(row);
						if (Buffer.byteLength(JSON.stringify(frame()), "utf8") > 64 * 1024)
							return Stream.fail(
								new WsRpcError({
									message: "Prompt summary exceeds frame budget",
								}),
							);
					}
					if (rows.length || frames.length === 0) frames.push(frame());
					return Stream.fromIterable(frames);
				}),
			);
		}),
	);
