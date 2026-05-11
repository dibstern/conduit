import { describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/effect/daemon-config-ref.js";

describe("DaemonConfigRef", () => {
	const defaults: DaemonRuntimeConfig = {
		port: 2633,
		host: "127.0.0.1",
		pinHash: null,
		tlsEnabled: false,
		keepAwake: false,
		keepAwakeCommand: undefined,
		keepAwakeArgs: undefined,
		shuttingDown: false,
		dismissedPaths: new Set(),
		startTime: Date.now(),
		hostExplicit: false,
		persistedSessionCounts: new Map(),
	};

	const testLayer = DaemonConfigRefLive(defaults);

	it.effect("provides Ref with initial config", () =>
		Effect.gen(function* () {
			const ref = yield* DaemonConfigRefTag;
			const config = yield* Ref.get(ref);
			expect(config.port).toBe(2633);
			expect(config.host).toBe("127.0.0.1");
			expect(config.pinHash).toBeNull();
			expect(config.tlsEnabled).toBe(false);
			expect(config.shuttingDown).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.effect("updates config via Ref.update", () =>
		Effect.gen(function* () {
			const ref = yield* DaemonConfigRefTag;
			yield* Ref.update(ref, (c) => ({ ...c, port: 3000, tlsEnabled: true }));
			const config = yield* Ref.get(ref);
			expect(config.port).toBe(3000);
			expect(config.tlsEnabled).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);

	it.effect(
		"seeds from DaemonOptions with overrides via makeDaemonConfigFromOptions",
		() =>
			Effect.gen(function* () {
				const ref = yield* DaemonConfigRefTag;
				const config = yield* Ref.get(ref);
				expect(config.keepAwake).toBe(true);
				expect(config.pinHash).toBe("abc123");
				expect(config.hostExplicit).toBe(true);
				expect(config.host).toBe("0.0.0.0");
			}).pipe(
				Effect.provide(
					Layer.fresh(
						DaemonConfigRefLive(
							makeDaemonConfigFromOptions({
								keepAwake: true,
								pinHash: "abc123",
								host: "0.0.0.0",
								hostExplicit: true,
							}),
						),
					),
				),
			),
	);

	it("makeDaemonConfigFromOptions carries tlsEnabled and explicit hostExplicit", () => {
		const c1 = makeDaemonConfigFromOptions({ tlsEnabled: true });
		expect(c1.tlsEnabled).toBe(true);
		expect(c1.hostExplicit).toBe(false);

		const c2 = makeDaemonConfigFromOptions({
			tlsEnabled: false,
			hostExplicit: true,
			host: "127.0.0.1",
		});
		expect(c2.tlsEnabled).toBe(false);
		expect(c2.hostExplicit).toBe(true);

		const c3 = makeDaemonConfigFromOptions({ host: "0.0.0.0" });
		expect(c3.hostExplicit).toBe(false);
	});

	it.effect("dismissedPaths is an independent Set per instance", () =>
		Effect.gen(function* () {
			const ref = yield* DaemonConfigRefTag;
			yield* Ref.update(ref, (c) => ({
				...c,
				dismissedPaths: new Set([...c.dismissedPaths, "/foo"]),
			}));
			const config = yield* Ref.get(ref);
			expect(config.dismissedPaths.has("/foo")).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(testLayer))),
	);
});
