import { describe, it } from "@effect/vitest";
import { Cause, Effect, type Layer, Logger, LogLevel } from "effect";
import { expect, vi } from "vitest";
import { makePinoLoggerLive } from "../../../src/lib/effect/pino-logger-layer.js";

/** Create a separate set of spies (used for child loggers). */
function makePinoSpies() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: vi.fn(),
	};
}

/** Create a mock Pino logger with spies on every log method. */
function mockPino() {
	const spies = makePinoSpies();
	const childSpies = makePinoSpies();
	// child() returns a distinct spy set so tests can distinguish
	// root-vs-child logger calls.
	spies.child.mockReturnValue(childSpies);
	return { root: spies, child: childSpies };
}

type MockPino = ReturnType<typeof mockPino>;

/** Type-safe wrapper — casts mock root to PinoLogger for makePinoLoggerLive. */
function layer(mock: MockPino): Layer.Layer<never> {
	// biome-ignore lint/suspicious/noExplicitAny: mock shape satisfies the subset of PinoLogger used by the bridge
	return makePinoLoggerLive(mock.root as any);
}

describe("PinoLoggerLive", () => {
	it.effect("routes Effect.logInfo to pino.info", () =>
		Effect.gen(function* () {
			const mock = mockPino();
			yield* Effect.logInfo("test message").pipe(Effect.provide(layer(mock)));
			expect(mock.root.info).toHaveBeenCalled();
			// biome-ignore lint/style/noNonNullAssertion: safe — prior assertion guarantees called
			expect(mock.root.info.mock.calls[0]![0]).toContain("test message");
		}),
	);

	it.effect("routes Effect.logWarning to pino.warn", () =>
		Effect.gen(function* () {
			const mock = mockPino();
			yield* Effect.logWarning("warning msg").pipe(Effect.provide(layer(mock)));
			expect(mock.root.warn).toHaveBeenCalled();
			// biome-ignore lint/style/noNonNullAssertion: safe — prior assertion guarantees called
			expect(mock.root.warn.mock.calls[0]![0]).toContain("warning msg");
		}),
	);

	it.effect("routes Effect.logError to pino.error", () =>
		Effect.gen(function* () {
			const mock = mockPino();
			yield* Effect.logError("error msg").pipe(Effect.provide(layer(mock)));
			expect(mock.root.error).toHaveBeenCalled();
		}),
	);

	it.effect("routes Effect.logDebug to pino.debug", () =>
		Effect.gen(function* () {
			const mock = mockPino();
			yield* Effect.logDebug("debug msg").pipe(
				Logger.withMinimumLogLevel(LogLevel.Debug),
				Effect.provide(layer(mock)),
			);
			expect(mock.root.debug).toHaveBeenCalled();
			// biome-ignore lint/style/noNonNullAssertion: safe — prior assertion guarantees called
			expect(mock.root.debug.mock.calls[0]![0]).toContain("debug msg");
		}),
	);

	it.effect("forwards annotations as pino child bindings", () =>
		Effect.gen(function* () {
			const mock = mockPino();
			yield* Effect.logInfo("annotated").pipe(
				Effect.annotateLogs({ sessionId: "s1", cmd: "run" }),
				Effect.provide(layer(mock)),
			);
			// Should have called child() with annotation bindings on root
			expect(mock.root.child).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: "s1", cmd: "run" }),
			);
			// The actual log call lands on the child, not the root
			expect(mock.child.info).toHaveBeenCalledWith("annotated");
			expect(mock.root.info).not.toHaveBeenCalled();
		}),
	);

	it.effect("forwards span label as binding", () =>
		Effect.gen(function* () {
			const mock = mockPino();
			yield* Effect.logInfo("spanned").pipe(
				Effect.withLogSpan("mySpan"),
				Effect.provide(layer(mock)),
			);
			expect(mock.root.child).toHaveBeenCalledWith(
				expect.objectContaining({ span: "mySpan" }),
			);
			// Log call should be on the child logger
			expect(mock.child.info).toHaveBeenCalledWith("spanned");
			expect(mock.root.info).not.toHaveBeenCalled();
		}),
	);

	it.effect("skips child() when no annotations or spans", () =>
		Effect.gen(function* () {
			const mock = mockPino();
			yield* Effect.logInfo("plain message").pipe(Effect.provide(layer(mock)));
			// Should call info directly on root pino, not on a child
			expect(mock.root.child).not.toHaveBeenCalled();
			expect(mock.root.info).toHaveBeenCalledWith("plain message");
			expect(mock.child.info).not.toHaveBeenCalled();
		}),
	);

	it.effect("includes cause context on error logs from failed effects", () =>
		Effect.gen(function* () {
			const mock = mockPino();
			// Run an effect that fails, then log the error with cause info
			const program = Effect.gen(function* () {
				yield* Effect.fail(new Error("boom"));
			}).pipe(
				Effect.catchAllCause((cause) =>
					Effect.logError("operation failed").pipe(
						Effect.annotateLogs({
							err: Cause.pretty(cause),
						}),
					),
				),
			);
			yield* program.pipe(Effect.provide(layer(mock)));

			// The error call should land on the child (because of the annotation)
			expect(mock.root.child).toHaveBeenCalledWith(
				expect.objectContaining({
					err: expect.stringContaining("boom"),
				}),
			);
			expect(mock.child.error).toHaveBeenCalled();
		}),
	);

	it.effect(
		"includes cause in pino error call when Effect cause is non-empty",
		() =>
			Effect.gen(function* () {
				const mock = mockPino();
				// Pass a Cause value as a message argument to logError.
				// Effect's logWithLevel detects Cause instances in the message
				// array and forwards them via the `cause` parameter of the logger.
				const cause = Cause.fail(new Error("db connection lost"));
				yield* Effect.logError("query failed", cause).pipe(
					Effect.provide(layer(mock)),
				);

				// logError with a non-empty cause should call pino.error({err: ...}, text)
				expect(mock.root.error).toHaveBeenCalledWith(
					expect.objectContaining({
						err: expect.stringContaining("db connection lost"),
					}),
					"query failed",
				);
			}),
	);
});
