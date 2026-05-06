// ─── SSE Stream (Effect) ─────────────────────────────────────────────────────
// Replaces the imperative SSEStream class with Effect.Stream + Schedule.
//
// sseStream       – connects to an SSE endpoint via @effect/platform HttpClient,
//                   parses the text/event-stream protocol, and emits SSEEvent.
// resilientSSE    – wraps sseStream with automatic reconnection (exponential
//                   backoff + jitter) and stale-stream detection.
// reconnectSchedule – the retry schedule used by resilientSSE (exported for
//                   unit-testing).

import {
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "@effect/platform";
import { Data, Duration, Effect, Option, Ref, Schedule, Stream } from "effect";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SSEEvent {
	type: string;
	data: string;
	lastEventId?: string;
}

// ─── Error types ─────────────────────────────────────────────────────────────

export class SSEConnectionError extends Data.TaggedError("SSEConnectionError")<{
	cause: unknown;
}> {}

export class SSEStaleError extends Data.TaggedError("SSEStaleError")<{
	lastEventId?: string;
}> {}

// ─── Reconnect schedule ──────────────────────────────────────────────────────

// Schedule.upTo caps total elapsed retry time — retries stop after 5 minutes
// of continuous reconnection failures. This is intentional: after 5 minutes
// without a successful connection, the issue is likely persistent (server down,
// network unreachable) and further retries won't help.
export const reconnectSchedule = Schedule.exponential("1 second").pipe(
	Schedule.jittered,
	Schedule.upTo(Duration.minutes(5)),
	Schedule.whileInput((error: SSEConnectionError) => {
		const cause = error.cause;
		if (cause && typeof cause === "object" && "status" in cause) {
			const status = (cause as { status: number }).status;
			// Do not retry on auth errors
			if (status === 401 || status === 403) return false;
		}
		return true;
	}),
);

// ─── SSE block parser ────────────────────────────────────────────────────────

const parseSSEBlock = (block: string): SSEEvent | null => {
	let data = "";
	let type = "message";
	let id: string | undefined;

	for (const line of block.split("\n")) {
		if (line.startsWith("data: ")) {
			if (data) data += "\n";
			data += line.slice(6);
		} else if (line.startsWith("event: ")) type = line.slice(7);
		else if (line.startsWith("id: ")) id = line.slice(4);
	}

	if (!data) return null;
	const event: SSEEvent = { type, data };
	if (id !== undefined) event.lastEventId = id;
	return event;
};

// ─── Core SSE stream ─────────────────────────────────────────────────────────

/**
 * Connect to an SSE endpoint and emit parsed SSEEvent items.
 *
 * Requires an HttpClient in the environment (provided by @effect/platform).
 */
export const sseStream = (
	url: string,
	options?: { headers?: Record<string, string>; lastEventId?: string },
): Stream.Stream<SSEEvent, SSEConnectionError, HttpClient.HttpClient> =>
	Stream.unwrapScoped(
		Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient;

			const request = HttpClientRequest.get(url, {
				accept: "text/event-stream",
				headers: {
					...(options?.lastEventId
						? { "Last-Event-ID": options.lastEventId }
						: {}),
					...(options?.headers ?? {}),
				},
			});

			const responseEffect = client
				.execute(request)
				.pipe(Effect.mapError((e) => new SSEConnectionError({ cause: e })));

			return HttpClientResponse.stream(responseEffect).pipe(
				Stream.decodeText(),
				Stream.mapAccum("", (buffer, chunk) => {
					const combined = buffer + chunk;
					const blocks = combined.split("\n\n");
					const remainder = blocks.pop() ?? "";
					return [remainder, blocks] as const;
				}),
				Stream.flatMap((blocks) => Stream.fromIterable(blocks)),
				Stream.filterMap((block) => {
					const event = parseSSEBlock(block);
					return event ? Option.some(event) : Option.none();
				}),
				Stream.mapError((e) =>
					e instanceof SSEConnectionError
						? e
						: new SSEConnectionError({ cause: e }),
				),
			);
		}),
	);

// ─── Resilient SSE ───────────────────────────────────────────────────────────

/**
 * SSE stream with automatic reconnection and stale-stream detection.
 *
 * - On connection errors: retries with exponential backoff + jitter (up to 5 min).
 * - On 401/403: stops immediately (no retry).
 * - On stale stream (no events within staleTimeout): fails with SSEStaleError.
 * - Tracks lastEventId and sends it on reconnection for resumption.
 */
export const resilientSSE = (
	url: string,
	options?: {
		staleTimeout?: Duration.DurationInput;
		headers?: Record<string, string>;
	},
): Stream.Stream<
	SSEEvent,
	SSEStaleError | SSEConnectionError,
	HttpClient.HttpClient
> => {
	const staleTimeout = options?.staleTimeout ?? Duration.seconds(90);

	return Stream.unwrap(
		Effect.gen(function* () {
			const lastEventIdRef = yield* Ref.make<string | undefined>(undefined);

			const connectWithResume = (): Stream.Stream<
				SSEEvent,
				SSEConnectionError,
				HttpClient.HttpClient
			> =>
				Stream.unwrap(
					Ref.get(lastEventIdRef).pipe(
						Effect.map((lastEventId) =>
							sseStream(url, {
								...(options?.headers ? { headers: options.headers } : {}),
								...(lastEventId ? { lastEventId } : {}),
							}).pipe(
								Stream.tap((event) =>
									event.lastEventId
										? Ref.set(lastEventIdRef, event.lastEventId)
										: Effect.void,
								),
							),
						),
					),
				);

			return connectWithResume().pipe(
				Stream.retry(reconnectSchedule),
				Stream.timeoutFail(() => new SSEStaleError({}), staleTimeout),
			);
		}),
	);
};
