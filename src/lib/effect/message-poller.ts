// ─── Effect-based Message Poller (fiber-per-session) ────────────────────────
// Uses FiberMap instead of manual Map<string, Fiber> + manual interrupt loops.
// FiberMap auto-interrupts on scope close, provides run() for fork-and-register.
//
// Each session gets its own fiber that polls at a configurable interval.
// FiberMap.run auto-deduplicates — if a fiber already exists for the key,
// it's interrupted before the new one starts.

import { Context, Duration, Effect, FiberMap, Layer, Schedule } from "effect";
import { OpenCodeAPITag } from "./services.js";

// ─── State Tag ──────────────────────────────────────────────────────────────

export class PollerManagerStateTag extends Context.Tag("PollerManagerState")<
	PollerManagerStateTag,
	FiberMap.FiberMap<string>
>() {}

export const makePollerManagerStateLive =
	(): Layer.Layer<PollerManagerStateTag> =>
		Layer.scoped(PollerManagerStateTag, FiberMap.make<string>());

// ─── Internal: per-session poll loop ────────────────────────────────────────

const pollSession = (sessionId: string, interval: Duration.DurationInput) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;

		const poll = Effect.tryPromise({
			try: () => api.session.messages(sessionId),
			catch: (error) => error,
		}).pipe(
			Effect.catchAll((e) =>
				Effect.logWarning(
					`Poll error for session ${sessionId}`,
					e as { toString(): string },
				),
			),
		);

		yield* poll.pipe(
			Effect.repeat(Schedule.spaced(interval)),
			Effect.interruptible,
		);
	});

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Start polling for a session. If a poller is already running for this
 * session, FiberMap.run auto-interrupts the previous fiber before starting
 * the new one. All fibers are auto-interrupted when the scope closes.
 */
export const startPoller = (
	sessionId: string,
	interval: Duration.DurationInput = Duration.seconds(3),
) =>
	Effect.gen(function* () {
		const fiberMap = yield* PollerManagerStateTag;
		yield* FiberMap.run(fiberMap, sessionId, pollSession(sessionId, interval));
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("poller.start", { attributes: { sessionId } }),
	);

/**
 * Stop polling for a session by interrupting its fiber and removing from map.
 */
export const stopPoller = (sessionId: string) =>
	Effect.gen(function* () {
		const fiberMap = yield* PollerManagerStateTag;
		yield* FiberMap.remove(fiberMap, sessionId);
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("poller.stop", { attributes: { sessionId } }),
	);

/**
 * Check whether a poller is currently active for a session.
 */
export const isPollerActive = (sessionId: string) =>
	Effect.gen(function* () {
		const fiberMap = yield* PollerManagerStateTag;
		return yield* FiberMap.has(fiberMap, sessionId);
	});
