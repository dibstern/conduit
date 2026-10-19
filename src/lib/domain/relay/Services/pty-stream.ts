// PTY Stream (Effect)
// Upstream PTY connection as an Effect.Stream over WebSocket.
//
// ptyStream  – connects to a WebSocket PTY endpoint and emits PtyEvent items.
//              Uses Effect.acquireRelease for guaranteed cleanup and
//              Stream.callback for callback-to-stream bridging.

import { Cause, Data, Duration, Effect, Queue, Stream } from "effect";
import WebSocket from "ws";

export interface PtyEvent {
	type: "output" | "exit" | "error";
	data: string;
}

export class PtyConnectionError extends Data.TaggedError("PtyConnectionError")<{
	cause: unknown;
}> {}

export class PtyConnectionTimeout extends Data.TaggedError(
	"PtyConnectionTimeout",
)<Record<string, never>> {}

/**
 * Connect to a PTY WebSocket endpoint and emit parsed PtyEvent items.
 *
 * - On WebSocket error: fails with PtyConnectionError.
 * - On WebSocket close: ends the stream.
 * - Connection timeout (10s): if WebSocket hasn't opened, fails with
 *   PtyConnectionTimeout via a fire-and-forget scoped fiber.
 */
export const ptyStream = (url: string) =>
	Stream.callback<PtyEvent, PtyConnectionError | PtyConnectionTimeout>(
		(queue) =>
			Effect.gen(function* () {
				const ws = yield* Effect.acquireRelease(
					Effect.sync(
						() =>
							new WebSocket(url, {
								perMessageDeflate: false,
							}),
					),
					(ws) => Effect.sync(() => ws.close()).pipe(Effect.ignore),
				);

				ws.on("message", (data: Buffer) => {
					// try/catch OK here — sync callback bridge, not Effect context
					try {
						const event = JSON.parse(data.toString()) as PtyEvent;
						Queue.offerUnsafe(queue, event);
					} catch {
						Queue.offerUnsafe(queue, { type: "output", data: data.toString() });
					}
				});

				ws.on("error", (err: Error) => {
					Queue.failCauseUnsafe(
						queue,
						Cause.fail(new PtyConnectionError({ cause: err })),
					);
				});

				ws.on("close", () => {
					Queue.endUnsafe(queue);
				});

				// Connection timeout — fire-and-forget fiber
				yield* Effect.sleep(Duration.seconds(10)).pipe(
					Effect.flatMap(() =>
						ws.readyState !== WebSocket.OPEN
							? Effect.sync(() =>
									Queue.failCauseUnsafe(
										queue,
										Cause.fail(new PtyConnectionTimeout({})),
									),
								)
							: Effect.void,
					),
					Effect.forkScoped({ uninterruptible: "inherit" }),
				);
			}),
	);
