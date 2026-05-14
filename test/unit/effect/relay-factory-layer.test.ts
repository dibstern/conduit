import { describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import {
	HttpServerRefLive,
	HttpServerRefTag,
	RelayFactoryError,
	RelayFactoryLive,
	RelayFactoryTag,
} from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";

// ─── HttpServerRefTag tests ─────────────────────────────────────────────────

describe("HttpServerRefTag", () => {
	const testLayer = HttpServerRefLive;

	it.effect("initializes with null", () =>
		Effect.gen(function* () {
			const ref = yield* HttpServerRefTag;
			const value = yield* Ref.get(ref);
			expect(value).toBeNull();
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.effect("can be set to a mock server value", () =>
		Effect.gen(function* () {
			const ref = yield* HttpServerRefTag;
			// Use a plain object as a mock http.Server
			const mockServer = {
				listening: true,
			} as unknown as import("node:http").Server;
			yield* Ref.set(ref, mockServer);
			const value = yield* Ref.get(ref);
			expect(value).toBe(mockServer);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.effect("can be reset to null", () =>
		Effect.gen(function* () {
			const ref = yield* HttpServerRefTag;
			const mockServer = {
				listening: true,
			} as unknown as import("node:http").Server;
			yield* Ref.set(ref, mockServer);
			yield* Ref.set(ref, null);
			const value = yield* Ref.get(ref);
			expect(value).toBeNull();
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});

// ─── RelayFactoryTag tests ──────────────────────────────────────────────────

describe("RelayFactoryTag", () => {
	const configLayer = DaemonConfigRefLive(makeDaemonConfigFromOptions({}));

	// RelayFactoryLive provides both RelayFactoryTag and HttpServerRefTag.
	// It requires DaemonConfigRefTag from the caller.
	const factoryLayer = RelayFactoryLive("/tmp/test-conduit").pipe(
		Layer.provide(configLayer),
	);

	it.effect("resolves from the Layer", () =>
		Effect.gen(function* () {
			const factory = yield* RelayFactoryTag;
			expect(factory).toBeDefined();
			expect(typeof factory.create).toBe("function");
		}).pipe(Effect.provide(Layer.fresh(factoryLayer))),
	);

	it.effect("also provides HttpServerRefTag", () =>
		Effect.gen(function* () {
			const ref = yield* HttpServerRefTag;
			const value = yield* Ref.get(ref);
			// HttpServerRefLive initializes to null
			expect(value).toBeNull();
		}).pipe(Effect.provide(Layer.fresh(factoryLayer))),
	);

	it.effect("create fails with RelayFactoryError when httpServer is null", () =>
		Effect.gen(function* () {
			const factory = yield* RelayFactoryTag;
			const project = {
				slug: "test-project",
				directory: "/tmp/test-project",
				title: "Test Project",
			};

			const result = yield* factory
				.create(project, "http://localhost:4096")
				.pipe(Effect.scoped, Effect.either);

			expect(result._tag).toBe("Left");
			if (result._tag === "Left") {
				const error = result.left;
				expect(error).toBeInstanceOf(RelayFactoryError);
				expect(error._tag).toBe("RelayFactoryError");
				expect(error.reason).toBe("HTTP server not started");
			}
		}).pipe(Effect.provide(Layer.fresh(factoryLayer))),
	);
});

// ─── RelayFactoryError tests ────────────────────────────────────────────────

describe("RelayFactoryError", () => {
	it("has correct tag", () => {
		const err = new RelayFactoryError({ reason: "test" });
		expect(err._tag).toBe("RelayFactoryError");
	});

	it("message includes reason", () => {
		const err = new RelayFactoryError({ reason: "server not started" });
		expect(err.message).toBe("server not started");
	});

	it("message includes cause when present", () => {
		const cause = new Error("connection refused");
		const err = new RelayFactoryError({
			reason: "failed to connect",
			cause,
		});
		expect(err.message).toBe("failed to connect: connection refused");
	});

	it("works with Effect.catchTag", () => {
		const program = Effect.gen(function* () {
			return yield* new RelayFactoryError({ reason: "test error" });
		}).pipe(
			Effect.catchTag("RelayFactoryError", (e) =>
				Effect.succeed(`caught: ${e.reason}`),
			),
		);

		const result = Effect.runSync(program);
		expect(result).toBe("caught: test error");
	});
});
