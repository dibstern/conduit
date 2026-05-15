import { Duration, Effect } from "effect";

/** Scope-managed fetch — aborts in-flight request on scope close. */
export const trackedFetch = (url: string, init?: RequestInit) =>
	Effect.acquireRelease(
		Effect.sync(() => new AbortController()),
		(controller) => Effect.sync(() => controller.abort()),
	).pipe(
		Effect.flatMap((controller) =>
			Effect.tryPromise(() =>
				fetch(url, { ...init, signal: controller.signal }),
			),
		),
	);

/** Scope-managed repeating effect — uses Effect.repeat with forkScoped. */
export const repeating = (fn: () => Effect.Effect<void>, ms: number) =>
	fn().pipe(
		Effect.delay(Duration.millis(ms)),
		Effect.forever,
		Effect.forkScoped,
	);

/** Scope-managed delayed effect — uses Effect.delay with forkScoped. */
export const delayed = (fn: () => Effect.Effect<void>, ms: number) =>
	fn().pipe(Effect.delay(Duration.millis(ms)), Effect.forkScoped);
