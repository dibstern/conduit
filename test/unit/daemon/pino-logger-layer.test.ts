import { describe, it } from "@effect/vitest";
import { Effect, type Layer, Logger, LogLevel } from "effect";
import { expect, vi } from "vitest";
import { makePinoLoggerLive } from "../../../src/lib/effect/pino-logger-layer.js";

/** Create a mock Pino logger with spies on every log method. */
function mockPino() {
	const spies = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: vi.fn(),
	};
	// child() returns an object with the same shape so calls chain properly.
	spies.child.mockReturnValue(spies);
	return spies;
}

type MockPino = ReturnType<typeof mockPino>;

/** Type-safe wrapper — casts mock to PinoLogger for makePinoLoggerLive. */
function layer(mock: MockPino): Layer.Layer<never> {
	// biome-ignore lint/suspicious/noExplicitAny: mock shape satisfies the subset of PinoLogger used by the bridge
	return makePinoLoggerLive(mock as any);
}

describe("PinoLoggerLive", () => {
	it.effect("routes Effect.logInfo to pino.info", () =>
		Effect.gen(function* () {
			const pino = mockPino();
			yield* Effect.logInfo("test message").pipe(Effect.provide(layer(pino)));
			expect(pino.info).toHaveBeenCalled();
			// biome-ignore lint/style/noNonNullAssertion: safe — prior assertion guarantees called
			expect(pino.info.mock.calls[0]![0]).toContain("test message");
		}),
	);

	it.effect("routes Effect.logWarning to pino.warn", () =>
		Effect.gen(function* () {
			const pino = mockPino();
			yield* Effect.logWarning("warning msg").pipe(Effect.provide(layer(pino)));
			expect(pino.warn).toHaveBeenCalled();
			// biome-ignore lint/style/noNonNullAssertion: safe — prior assertion guarantees called
			expect(pino.warn.mock.calls[0]![0]).toContain("warning msg");
		}),
	);

	it.effect("routes Effect.logError to pino.error", () =>
		Effect.gen(function* () {
			const pino = mockPino();
			yield* Effect.logError("error msg").pipe(Effect.provide(layer(pino)));
			expect(pino.error).toHaveBeenCalled();
		}),
	);

	it.effect("routes Effect.logDebug to pino.debug", () =>
		Effect.gen(function* () {
			const pino = mockPino();
			yield* Effect.logDebug("debug msg").pipe(
				Logger.withMinimumLogLevel(LogLevel.Debug),
				Effect.provide(layer(pino)),
			);
			expect(pino.debug).toHaveBeenCalled();
			// biome-ignore lint/style/noNonNullAssertion: safe — prior assertion guarantees called
			expect(pino.debug.mock.calls[0]![0]).toContain("debug msg");
		}),
	);

	it.effect("forwards annotations as pino child bindings", () =>
		Effect.gen(function* () {
			const pino = mockPino();
			yield* Effect.logInfo("annotated").pipe(
				Effect.annotateLogs({ sessionId: "s1", cmd: "run" }),
				Effect.provide(layer(pino)),
			);
			// Should have called child() with annotation bindings
			expect(pino.child).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: "s1", cmd: "run" }),
			);
		}),
	);

	it.effect("forwards span label as binding", () =>
		Effect.gen(function* () {
			const pino = mockPino();
			yield* Effect.logInfo("spanned").pipe(
				Effect.withLogSpan("mySpan"),
				Effect.provide(layer(pino)),
			);
			expect(pino.child).toHaveBeenCalledWith(
				expect.objectContaining({ span: "mySpan" }),
			);
		}),
	);

	it.effect("skips child() when no annotations or spans", () =>
		Effect.gen(function* () {
			const pino = mockPino();
			yield* Effect.logInfo("plain message").pipe(Effect.provide(layer(pino)));
			// Should call info directly on root pino, not on a child
			expect(pino.child).not.toHaveBeenCalled();
			expect(pino.info).toHaveBeenCalledWith("plain message");
		}),
	);
});
