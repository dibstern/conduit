// ─── PTY Stream (Effect) ─────────────────────────────────────────────────────
// Upstream PTY connection as an Effect.Stream over WebSocket.
//
// ptyStream  – connects to a WebSocket PTY endpoint and emits PtyEvent items.
//              Uses Effect.acquireRelease for guaranteed cleanup and
//              Stream.asyncPush for callback-to-stream bridging.

import { Data, Duration, Effect, Stream } from "effect";
import WebSocket from "ws";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PtyEvent {
	type: "output" | "exit" | "error";
	data: string;
}

// ─── Error types ────────────────────────────────────────────────────────────

export class PtyConnectionError extends Data.TaggedError("PtyConnectionError")<{
	cause: unknown;
}> {}

export class PtyConnectionTimeout extends Data.TaggedError(
	"PtyConnectionTimeout",
)<Record<string, never>> {}

// ─── Core PTY stream ────────────────────────────────────────────────────────

/**
 * Connect to a PTY WebSocket endpoint and emit parsed PtyEvent items.
 *
 * - On WebSocket error: fails with PtyConnectionError.
 * - On WebSocket close: ends the stream.
 * - Connection timeout (10s): if WebSocket hasn't opened, fails with
 *   PtyConnectionTimeout via a fire-and-forget scoped fiber.
 */
export const ptyStream = (url: string) =>
	Stream.asyncPush<PtyEvent, PtyConnectionError | PtyConnectionTimeout>(
		(emit) =>
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
						emit.single(event);
					} catch {
						emit.single({ type: "output", data: data.toString() });
					}
				});

				ws.on("error", (err: Error) => {
					emit.fail(new PtyConnectionError({ cause: err }));
				});

				ws.on("close", () => {
					emit.end();
				});

				// Connection timeout — fire-and-forget fiber
				yield* Effect.sleep(Duration.seconds(10)).pipe(
					Effect.flatMap(() =>
						ws.readyState !== WebSocket.OPEN
							? Effect.sync(() => emit.fail(new PtyConnectionTimeout({})))
							: Effect.void,
					),
					Effect.forkScoped,
				);
			}),
	);
