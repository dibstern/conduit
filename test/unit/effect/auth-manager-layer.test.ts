import { describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { hashPin } from "../../../src/lib/auth.js";
import {
	AuthManagerFromConfigLive,
	AuthManagerTag,
} from "../../../src/lib/effect/auth-middleware.js";
import {
	DaemonConfigRefLive,
	DaemonConfigRefTag,
	type DaemonRuntimeConfig,
} from "../../../src/lib/effect/daemon-config-ref.js";
import {
	CrashCounterLive,
	CrashCounterTag,
} from "../../../src/lib/effect/daemon-startup.js";

// ─── AuthManagerFromConfigLive tests ─────────────────────────────────────────

describe("AuthManagerLive from DaemonConfigRef", () => {
	const withPin: DaemonRuntimeConfig = {
		port: 2633,
		host: "127.0.0.1",
		pinHash: "test-hash",
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

	const noPin: DaemonRuntimeConfig = { ...withPin, pinHash: null };

	const layerWithPin = AuthManagerFromConfigLive.pipe(
		Layer.provide(DaemonConfigRefLive(withPin)),
	);

	const layerNoPin = AuthManagerFromConfigLive.pipe(
		Layer.provide(DaemonConfigRefLive(noPin)),
	);

	it.effect("initializes with pinHash from DaemonConfigRef", () =>
		Effect.gen(function* () {
			const auth = yield* AuthManagerTag;
			expect(auth.hasPin()).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(layerWithPin))),
	);

	it.effect("initializes without pin when pinHash is null", () =>
		Effect.gen(function* () {
			const auth = yield* AuthManagerTag;
			expect(auth.hasPin()).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(layerNoPin))),
	);

	it.effect("reactively reads pinHash from DaemonConfigRef", () =>
		Effect.gen(function* () {
			const auth = yield* AuthManagerTag;
			expect(auth.hasPin()).toBe(false); // starts with no pin

			// Update DaemonConfigRef
			const configRef = yield* DaemonConfigRefTag;
			yield* Ref.update(configRef, (c) => ({
				...c,
				pinHash: "new-hash",
			}));

			// AuthManager should now see the pin reactively
			expect(auth.hasPin()).toBe(true);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					AuthManagerFromConfigLive.pipe(
						Layer.provideMerge(DaemonConfigRefLive(noPin)),
					),
				),
			),
		),
	);

	it.effect("checkPin returns correct result using reactive pinHash", () =>
		Effect.gen(function* () {
			const auth = yield* AuthManagerTag;
			// No pin set — checkPin should return true (no-pin mode)
			expect(auth.checkPin("anything")).toBe(true);

			// Set a pinHash via DaemonConfigRef
			const configRef = yield* DaemonConfigRefTag;
			const hash = hashPin("1234");
			yield* Ref.update(configRef, (c) => ({ ...c, pinHash: hash }));

			// Now checkPin with wrong pin should fail
			expect(auth.checkPin("9999")).toBe(false);
			// checkPin with correct pin should succeed
			expect(auth.checkPin("1234")).toBe(true);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					AuthManagerFromConfigLive.pipe(
						Layer.provideMerge(DaemonConfigRefLive(noPin)),
					),
				),
			),
		),
	);

	it.effect("getPinHash returns reactive value", () =>
		Effect.gen(function* () {
			const auth = yield* AuthManagerTag;
			expect(auth.getPinHash()).toBeNull();

			const configRef = yield* DaemonConfigRefTag;
			yield* Ref.update(configRef, (c) => ({
				...c,
				pinHash: "updated-hash",
			}));

			expect(auth.getPinHash()).toBe("updated-hash");
		}).pipe(
			Effect.provide(
				Layer.fresh(
					AuthManagerFromConfigLive.pipe(
						Layer.provideMerge(DaemonConfigRefLive(noPin)),
					),
				),
			),
		),
	);
});

// ─── CrashCounterLive tests ─────────────────────────────────────────────────

describe("CrashCounterLive", () => {
	it.effect("records crashes and returns count", () =>
		Effect.gen(function* () {
			const counter = yield* CrashCounterTag;
			const result = yield* counter.record();
			expect(result.count).toBe(1);
			expect(result.shouldAbort).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(CrashCounterLive))),
	);

	it.effect("resets crash counter", () =>
		Effect.gen(function* () {
			const counter = yield* CrashCounterTag;
			yield* counter.record();
			yield* counter.record();
			yield* counter.reset();
			const result = yield* counter.record();
			expect(result.count).toBe(1);
			expect(result.shouldAbort).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(CrashCounterLive))),
	);

	it.effect("shouldAbort returns true after max crashes", () =>
		Effect.gen(function* () {
			const counter = yield* CrashCounterTag;
			// Default max is 3, record 3 times
			yield* counter.record();
			yield* counter.record();
			const result = yield* counter.record();
			expect(result.count).toBe(3);
			expect(result.shouldAbort).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(CrashCounterLive))),
	);
});
