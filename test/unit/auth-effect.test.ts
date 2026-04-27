// ─── Tests: Effect-based Auth Functions ───────────────────────────────────────

import { describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { expect } from "vitest";
import {
	AuthenticationError,
	AuthManager,
	authenticateEffect,
	hashPin,
	hashPinEffect,
	validateCookieEffect,
	verifyPinEffect,
} from "../../src/lib/auth.js";

// ─── hashPinEffect ──────────────────────────────────────────────────────────

describe("hashPinEffect", () => {
	it.effect("produces the same hash as the imperative hashPin", () =>
		Effect.gen(function* () {
			const pin = "1234";
			const effectHash = yield* hashPinEffect(pin);
			const imperativeHash = hashPin(pin);
			expect(effectHash).toBe(imperativeHash);
		}),
	);

	it.effect("produces a deterministic SHA-256 hex string", () =>
		Effect.gen(function* () {
			const hash = yield* hashPinEffect("5678");
			expect(hash).toMatch(/^[a-f0-9]{64}$/);
			// Same input always gives same output
			const hash2 = yield* hashPinEffect("5678");
			expect(hash2).toBe(hash);
		}),
	);
});

// ─── verifyPinEffect ────────────────────────────────────────────────────────

describe("verifyPinEffect", () => {
	it.effect("returns true for a matching pin", () =>
		Effect.gen(function* () {
			const hash = hashPin("4321");
			const result = yield* verifyPinEffect(hash, "4321");
			expect(result).toBe(true);
		}),
	);

	it.effect("returns false for a non-matching pin", () =>
		Effect.gen(function* () {
			const hash = hashPin("4321");
			const result = yield* verifyPinEffect(hash, "9999");
			expect(result).toBe(false);
		}),
	);
});

// ─── authenticateEffect ─────────────────────────────────────────────────────

describe("authenticateEffect", () => {
	const makeManager = () => {
		const manager = new AuthManager({ now: () => 1000 });
		manager.setPin("1234");
		return manager;
	};

	it.effect("succeeds with a valid PIN", () =>
		Effect.gen(function* () {
			const manager = makeManager();
			const result = yield* authenticateEffect(manager, "1234", "127.0.0.1");
			expect(result.ok).toBe(true);
			expect(result.cookie).toBeDefined();
		}),
	);

	it.effect("fails with AuthenticationError for invalid PIN", () =>
		Effect.gen(function* () {
			const manager = makeManager();
			const exit = yield* authenticateEffect(manager, "9999", "127.0.0.1").pipe(
				Effect.exit,
			);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const error = exit.cause;
				// Extract the failure from the cause
				const failure = error as unknown as { _tag: string };
				expect(failure).toBeDefined();
			}
		}),
	);

	it.effect(
		"fails with AuthenticationError reason=invalid_pin for wrong PIN",
		() =>
			Effect.gen(function* () {
				const manager = makeManager();
				const result = yield* authenticateEffect(
					manager,
					"0000",
					"10.0.0.1",
				).pipe(
					Effect.matchEffect({
						onFailure: (e) => Effect.succeed(e),
						onSuccess: () => Effect.fail(new Error("should have failed")),
					}),
				);
				expect(result).toBeInstanceOf(AuthenticationError);
				expect(result.reason).toBe("invalid_pin");
			}),
	);

	it.effect("fails with reason=locked_out after max attempts", () =>
		Effect.gen(function* () {
			const manager = new AuthManager({
				maxAttempts: 3,
				now: () => 1000,
			});
			manager.setPin("1234");

			// Exhaust attempts
			for (let i = 0; i < 3; i++) {
				yield* authenticateEffect(manager, "0000", "10.0.0.2").pipe(
					Effect.catchAll(() => Effect.void),
				);
			}

			// Next attempt should be locked out
			const result = yield* authenticateEffect(
				manager,
				"1234",
				"10.0.0.2",
			).pipe(
				Effect.matchEffect({
					onFailure: (e) => Effect.succeed(e),
					onSuccess: () => Effect.fail(new Error("should have failed")),
				}),
			);
			expect(result).toBeInstanceOf(AuthenticationError);
			expect(result.reason).toBe("locked_out");
			expect(result.retryAfter).toBeDefined();
			expect(typeof result.retryAfter).toBe("number");
		}),
	);

	it.effect("succeeds when no PIN is set (open access)", () =>
		Effect.gen(function* () {
			const manager = new AuthManager({ now: () => 1000 });
			// No PIN set
			const result = yield* authenticateEffect(
				manager,
				"anything",
				"127.0.0.1",
			);
			expect(result.ok).toBe(true);
			expect(result.cookie).toBeDefined();
		}),
	);
});

// ─── validateCookieEffect ───────────────────────────────────────────────────

describe("validateCookieEffect", () => {
	it.effect("returns true for a valid cookie", () =>
		Effect.gen(function* () {
			const manager = new AuthManager({ now: () => 1000 });
			manager.setPin("1234");
			const authResult = manager.authenticate("1234", "127.0.0.1");
			expect(authResult.ok).toBe(true);
			expect(authResult.cookie).toBeDefined();
			const cookie = authResult.cookie as string;

			const valid = yield* validateCookieEffect(manager, cookie);
			expect(valid).toBe(true);
		}),
	);

	it.effect("returns false for an unknown cookie", () =>
		Effect.gen(function* () {
			const manager = new AuthManager({ now: () => 1000 });
			const valid = yield* validateCookieEffect(manager, "bogus-cookie");
			expect(valid).toBe(false);
		}),
	);
});

// ─── AuthenticationError ────────────────────────────────────────────────────

describe("AuthenticationError", () => {
	it("has the correct _tag", () => {
		const err = new AuthenticationError({ reason: "invalid_pin" });
		expect(err._tag).toBe("AuthenticationError");
	});

	it("carries the reason field", () => {
		const err = new AuthenticationError({
			reason: "locked_out",
			retryAfter: 900,
		});
		expect(err.reason).toBe("locked_out");
		expect(err.retryAfter).toBe(900);
	});

	it("is an instance of Error", () => {
		const err = new AuthenticationError({ reason: "no_pin_set" });
		expect(err).toBeInstanceOf(Error);
	});
});
