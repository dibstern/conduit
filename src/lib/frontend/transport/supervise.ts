// ─── Feed supervision ───────────────────────────────────────────────────────
// `resumeStream` keeps a subscription alive across transport drops and hands
// everything else to its consumer: a server refusal (`WsRpcError`), a clean
// end, a defect. This is where those land, once, for every feed — the shell and
// the session detail alike — so the sidebar and the transcript recover the same
// way and say so in the same words (ni8.5 R5; decisions 6A, 6E, 6K, 3K, 6H).
//
// **Every ending is a failure.** The errors a feed can meet are mostly
// temporary — a relay still starting, a busy database — and a feed that has
// ended has stopped updating whether or not it meant to. So all three restart
// the feed from scratch, and a defect is only different in being logged as a
// bug. Only the consumer letting go stops it.
//
// **Quietly, forever, on the old socket's schedule.** 1s, growing by half each
// time, capped at 10s — the numbers `ws.svelte.ts` reconnects on — and reset
// once the feed says it is caught up. Giving up would freeze a phone's sidebar
// for hours over one busy moment; waiting at most 10s costs nothing.
//
// **Waking skips the wait.** A tab coming back into view, the network coming
// back, a page restored from the back/forward cache, or the user pressing Retry
// all mean "try now", so each one ends the current backoff early. They are one
// signal, so `retryFeedsNow` kicks every waiting feed, not one: a user asking
// for fresh data wants it everywhere, and a feed that is up ignores the kick.
//
// **One status for every feed.** `cold` until anything arrives, `catchingUp`
// until the server says `synchronized`, then `live`. `failing` from the first
// failure until the next `synchronized`: a restarted feed replaying its
// snapshot has not recovered yet, and keeping `since` across restarts is what
// lets a consumer wait out a short blip before showing it. Transport drops never
// show here — `resumeStream` hides them, and ends each one in `synchronized`.

import {
	Cause,
	Chunk,
	Clock,
	Duration,
	Effect,
	Option,
	Ref,
	Stream,
} from "effect";
import type { WsRpcError } from "../../contracts/ws-rpc.js";

export type FeedStatus =
	| { readonly _tag: "cold" }
	| { readonly _tag: "catchingUp" }
	| { readonly _tag: "live" }
	| {
			readonly _tag: "failing";
			/** When this run of failures began, in epoch millis. */
			readonly since: number;
			readonly lastError: string;
	  };

/** The old socket's reconnect bounds (`RECONNECT_BASE_MS`, `RECONNECT_MAX_MS`). */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 10_000;

const retryDelay = (failures: number): Duration.Duration =>
	Duration.millis(
		Math.min(RETRY_BASE_MS * 1.5 ** (failures - 1), RETRY_MAX_MS),
	);

const manualRetry = new EventTarget();

/** Restart every failing feed now instead of waiting out its backoff. */
export const retryFeedsNow = (): void => {
	manualRetry.dispatchEvent(new Event("retry"));
};

/** Resolves on the next reason to stop waiting: a wake-up or a manual retry. */
const nextWake = Effect.async<void>((resume) => {
	const wake = () => resume(Effect.void);
	const onVisibility = () => {
		if (document.visibilityState === "visible") wake();
	};
	const onPageShow = (event: Event) => {
		if ("persisted" in event && event.persisted === true) wake();
	};
	const browser = typeof window !== "undefined";
	manualRetry.addEventListener("retry", wake);
	if (browser) {
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("online", wake);
		window.addEventListener("pageshow", onPageShow);
	}
	return Effect.sync(() => {
		manualRetry.removeEventListener("retry", wake);
		if (browser) {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("online", wake);
			window.removeEventListener("pageshow", onPageShow);
		}
	});
});

/**
 * Runs `feed` for as long as the result is consumed, restarting it whenever it
 * fails or ends, and reports its status to `onStatus` as it changes. The result
 * never fails and never ends; interrupting it is the only way to stop.
 *
 * Each restart runs `feed` again from the top, so a resuming subscription asks
 * for a fresh snapshot rather than resuming.
 */
export const supervise = <A extends object>(
	feed: Stream.Stream<A, WsRpcError>,
	onStatus: (status: FeedStatus) => void,
): Stream.Stream<A> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const status = yield* Ref.make<FeedStatus>({ _tag: "cold" });
			const failures = yield* Ref.make(0);

			const report = (next: FeedStatus) =>
				Effect.zipRight(
					Ref.set(status, next),
					Effect.sync(() => onStatus(next)),
				);

			const observe = (envelope: A) =>
				Effect.flatMap(Ref.get(status), (current) =>
					"_tag" in envelope && envelope._tag === "synchronized"
						? Effect.zipRight(
								Ref.set(failures, 0),
								current._tag === "live"
									? Effect.void
									: report({ _tag: "live" }),
							)
						: current._tag === "cold"
							? report({ _tag: "catchingUp" })
							: Effect.void,
				);

			const backOff = (lastError: string) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					const current = yield* Ref.get(status);
					yield* report({
						_tag: "failing",
						since: current._tag === "failing" ? current.since : now,
						lastError,
					});
					const streak = yield* Ref.updateAndGet(failures, (n) => n + 1);
					yield* Effect.race(Effect.sleep(retryDelay(streak)), nextWake);
				});

			const restartAfter = (cause: Cause.Cause<WsRpcError>) => {
				const defects = Cause.defects(cause);
				if (Chunk.isNonEmpty(defects)) {
					const defect = Chunk.headNonEmpty(defects);
					return Effect.zipRight(
						Effect.logError("feed died; restarting", cause),
						backOff(defect instanceof Error ? defect.message : String(defect)),
					);
				}
				const message = Cause.failureOption(cause).pipe(
					Option.match({
						onNone: () => "The feed failed",
						onSome: (error) => error.message,
					}),
				);
				return Effect.zipRight(
					Effect.logWarning(`feed failed; restarting: ${message}`),
					backOff(message),
				);
			};

			const attempt = feed.pipe(
				Stream.tap(observe),
				Stream.concat(
					Stream.execute(
						Effect.zipRight(
							Effect.logWarning("feed ended; restarting"),
							backOff("The feed ended"),
						),
					),
				),
				// A bare interruption is the consumer letting go: resumeStream has
				// already restarted every interruption the transport caused.
				Stream.catchAllCause((cause) =>
					Cause.isInterruptedOnly(cause)
						? Stream.failCause(Cause.stripFailures(cause))
						: Stream.execute(restartAfter(cause)),
				),
			);

			yield* report({ _tag: "cold" });
			return Stream.forever(attempt);
		}),
	);
