// ─── Property-Based Tests: PIN Auth & Rate Limiting (Ticket 2.4) ────────────
//
// Properties tested:
// P1: Correct PIN always succeeds (when not locked) → AC2
// P2: Incorrect PIN always fails → AC3
// P3: Rate limit: N+1th attempt locks, even correct PIN → AC4
// P4: Lockout expires after timeout → AC4
// P5: Valid cookies validate, expired cookies don't → AC2, AC5
// P6: setPin accepts 4-8 digit PINs, rejects others → AC6
// P7: No PIN mode always grants access → AC7
// P8: Different IPs have independent lockout states → AC4
// P9: getRemainingAttempts returns correct count at each stage
// P10: PIN re-setting: only latest PIN works
// P11: Lockout expiry in authenticate(): correct PIN succeeds after lockout expires

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AuthManager, hashPin } from "../../../src/lib/auth.js";
import {
	edgeCaseString,
	invalidPin,
	ipAddress,
	validPin,
} from "../../helpers/arbitraries.js";

const SEED = 42;
const NUM_RUNS = 300;

describe("Ticket 2.4 — PIN Auth & Rate Limiting PBT", () => {
	// ─── P1: Correct PIN always succeeds ──────────────────────────────────

	describe("P1: Correct PIN always succeeds when not locked (AC2)", () => {
		it("property: correct PIN → ok=true with cookie", () => {
			fc.assert(
				fc.property(validPin, ipAddress, (pin, ip) => {
					const auth = new AuthManager({ now: () => 1_000_000 });
					auth.setPin(pin);
					const result = auth.authenticate(pin, ip);
					expect(result.ok).toBe(true);
					expect(result.cookie).toBeDefined();
					expect(typeof result.cookie).toBe("string");
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
					expect(result.cookie!.length).toBeGreaterThan(0);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P2: Incorrect PIN always fails ───────────────────────────────────

	describe("P2: Incorrect PIN always fails (AC3)", () => {
		it("property: wrong PIN → ok=false, no cookie", () => {
			fc.assert(
				fc.property(
					validPin,
					validPin.filter((p) => p.length >= 4), // ensure different
					ipAddress,
					(correctPin, wrongPin, ip) => {
						fc.pre(correctPin !== wrongPin);
						const auth = new AuthManager({ now: () => 1_000_000 });
						auth.setPin(correctPin);
						const result = auth.authenticate(wrongPin, ip);
						expect(result.ok).toBe(false);
						expect(result.cookie).toBeUndefined();
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P3: Rate limiting state machine ──────────────────────────────────

	describe("P3: Rate limit locks after maxAttempts failures (AC4)", () => {
		it("property: maxAttempts+1 incorrect → locked, even correct PIN blocked", () => {
			fc.assert(
				fc.property(
					validPin,
					ipAddress,
					fc.integer({ min: 1, max: 10 }),
					(pin, ip, maxAttempts) => {
						const time = 1_000_000;
						const auth = new AuthManager({
							maxAttempts,
							lockoutMinutes: 15,
							now: () => time,
						});
						auth.setPin(pin);

						const wrongPin = pin === "9999" ? "1111" : "9999";

						// Make maxAttempts incorrect attempts
						for (let i = 0; i < maxAttempts; i++) {
							const result = auth.authenticate(wrongPin, ip);
							if (i < maxAttempts - 1) {
								expect(result.ok).toBe(false);
								expect(result.locked).toBeUndefined();
							}
						}

						// IP should now be locked
						expect(auth.isLocked(ip)).toBe(true);

						// Even correct PIN should fail
						const lockedResult = auth.authenticate(pin, ip);
						expect(lockedResult.ok).toBe(false);
						expect(lockedResult.locked).toBe(true);
						expect(lockedResult.retryAfter).toBeGreaterThan(0);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P4: Lockout expiry ───────────────────────────────────────────────

	describe("P4: Lockout expires after timeout (AC4)", () => {
		it("property: after lockout period, correct PIN succeeds again", () => {
			fc.assert(
				fc.property(
					validPin,
					ipAddress,
					fc.integer({ min: 1, max: 60 }),
					(pin, ip, lockoutMinutes) => {
						let time = 1_000_000;
						const auth = new AuthManager({
							maxAttempts: 3,
							lockoutMinutes,
							now: () => time,
						});
						auth.setPin(pin);

						const wrongPin = pin === "9999" ? "1111" : "9999";

						// Lock the IP
						for (let i = 0; i < 3; i++) {
							auth.authenticate(wrongPin, ip);
						}
						expect(auth.isLocked(ip)).toBe(true);

						// Advance time past lockout
						time += lockoutMinutes * 60_000 + 1;

						// Should be unlocked now
						expect(auth.isLocked(ip)).toBe(false);

						// Correct PIN should work
						const result = auth.authenticate(pin, ip);
						expect(result.ok).toBe(true);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P5: Cookie validation ────────────────────────────────────────────

	describe("P5: Cookie validation (AC2, AC5)", () => {
		it("property: freshly issued cookie validates; after expiry it doesn't", () => {
			fc.assert(
				fc.property(
					validPin,
					ipAddress,
					fc.integer({ min: 1000, max: 86_400_000 }),
					(pin, ip, cookieExpiryMs) => {
						let time = 1_000_000;
						const auth = new AuthManager({
							cookieExpiryMs,
							now: () => time,
						});
						auth.setPin(pin);

						const result = auth.authenticate(pin, ip);
						expect(result.ok).toBe(true);
						// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
						const cookie = result.cookie!;

						// Immediately valid
						expect(auth.validateCookie(cookie)).toBe(true);

						// Still valid just before expiry
						time += cookieExpiryMs - 1;
						expect(auth.validateCookie(cookie)).toBe(true);

						// Expired
						time += 2;
						expect(auth.validateCookie(cookie)).toBe(false);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: random strings are never valid cookies", () => {
			fc.assert(
				fc.property(validPin, edgeCaseString, (pin, fakeCookie) => {
					const auth = new AuthManager();
					auth.setPin(pin);
					expect(auth.validateCookie(fakeCookie)).toBe(false);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P6: PIN format validation ────────────────────────────────────────

	describe("P6: setPin validates 4-8 digit format (AC6)", () => {
		it("property: valid PINs (4-8 digits) are accepted", () => {
			fc.assert(
				fc.property(validPin, (pin) => {
					const auth = new AuthManager();
					expect(auth.setPin(pin)).toBe(true);
					expect(auth.hasPin()).toBe(true);
					expect(auth.getPin()).toBe(hashPin(pin));
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: invalid PINs are rejected", () => {
			fc.assert(
				fc.property(invalidPin, (pin) => {
					const auth = new AuthManager();
					expect(auth.setPin(pin)).toBe(false);
					expect(auth.hasPin()).toBe(false);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P7: No-PIN mode ─────────────────────────────────────────────────

	describe("P7: No PIN mode always grants access (AC7)", () => {
		it("property: without PIN, any attempt succeeds", () => {
			fc.assert(
				fc.property(edgeCaseString, ipAddress, (anyPin, ip) => {
					const auth = new AuthManager();
					// No PIN set
					const result = auth.authenticate(anyPin, ip);
					expect(result.ok).toBe(true);
					expect(result.cookie).toBeDefined();
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P8: Independent IP lockouts ──────────────────────────────────────

	describe("P8: Different IPs have independent lockout state (AC4)", () => {
		it("property: locking IP-A does not affect IP-B", () => {
			fc.assert(
				fc.property(validPin, ipAddress, ipAddress, (pin, ipA, ipB) => {
					fc.pre(ipA !== ipB);

					const auth = new AuthManager({
						maxAttempts: 3,
						now: () => 1_000_000,
					});
					auth.setPin(pin);

					const wrongPin = pin === "9999" ? "1111" : "9999";

					// Lock IP-A
					for (let i = 0; i < 3; i++) {
						auth.authenticate(wrongPin, ipA);
					}
					expect(auth.isLocked(ipA)).toBe(true);

					// IP-B should still work
					expect(auth.isLocked(ipB)).toBe(false);
					const result = auth.authenticate(pin, ipB);
					expect(result.ok).toBe(true);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── P9: getRemainingAttempts ─────────────────────────────────────────

	describe("P9: getRemainingAttempts returns correct count at each stage", () => {
		it("returns maxAttempts when no failures have occurred", () => {
			fc.assert(
				fc.property(
					validPin,
					ipAddress,
					fc.integer({ min: 1, max: 10 }),
					(pin, ip, maxAttempts) => {
						const auth = new AuthManager({ maxAttempts, now: () => 1_000_000 });
						auth.setPin(pin);
						expect(auth.getRemainingAttempts(ip)).toBe(maxAttempts);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("returns maxAttempts - 1 after one failure", () => {
			fc.assert(
				fc.property(
					validPin,
					ipAddress,
					fc.integer({ min: 2, max: 10 }),
					(pin, ip, maxAttempts) => {
						const auth = new AuthManager({ maxAttempts, now: () => 1_000_000 });
						auth.setPin(pin);

						const wrongPin = pin === "9999" ? "1111" : "9999";
						auth.authenticate(wrongPin, ip);

						expect(auth.getRemainingAttempts(ip)).toBe(maxAttempts - 1);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("returns 0 after lockout (maxAttempts failures)", () => {
			fc.assert(
				fc.property(
					validPin,
					ipAddress,
					fc.integer({ min: 1, max: 10 }),
					(pin, ip, maxAttempts) => {
						const auth = new AuthManager({ maxAttempts, now: () => 1_000_000 });
						auth.setPin(pin);

						const wrongPin = pin === "9999" ? "1111" : "9999";
						for (let i = 0; i < maxAttempts; i++) {
							auth.authenticate(wrongPin, ip);
						}

						expect(auth.getRemainingAttempts(ip)).toBe(0);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: remaining attempts decreases by 1 with each failure", () => {
			fc.assert(
				fc.property(
					validPin,
					ipAddress,
					fc.integer({ min: 2, max: 8 }),
					fc.integer({ min: 1, max: 7 }),
					(pin, ip, maxAttempts, failures) => {
						fc.pre(failures < maxAttempts);
						const auth = new AuthManager({ maxAttempts, now: () => 1_000_000 });
						auth.setPin(pin);

						const wrongPin = pin === "9999" ? "1111" : "9999";
						for (let i = 0; i < failures; i++) {
							auth.authenticate(wrongPin, ip);
						}

						expect(auth.getRemainingAttempts(ip)).toBe(maxAttempts - failures);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("returns maxAttempts for an unknown IP address", () => {
			const auth = new AuthManager({ maxAttempts: 5, now: () => 1_000_000 });
			auth.setPin("1234");
			expect(auth.getRemainingAttempts("10.0.0.1")).toBe(5);
			expect(auth.getRemainingAttempts("192.168.1.1")).toBe(5);
		});
	});

	// ─── P10: PIN re-setting ──────────────────────────────────────────────

	describe("P10: PIN re-setting: only latest PIN works", () => {
		it("setting PIN twice means only the latest PIN authenticates", () => {
			fc.assert(
				fc.property(validPin, validPin, ipAddress, (pin1, pin2, ip) => {
					fc.pre(pin1 !== pin2);
					const auth = new AuthManager({ now: () => 1_000_000 });

					auth.setPin(pin1);
					expect(auth.getPin()).toBe(hashPin(pin1));

					// First PIN works
					const result1 = auth.authenticate(pin1, ip);
					expect(result1.ok).toBe(true);

					// Now re-set to a different PIN
					auth.setPin(pin2);
					expect(auth.getPin()).toBe(hashPin(pin2));

					// Old PIN no longer works
					const resultOld = auth.authenticate(pin1, ip);
					expect(resultOld.ok).toBe(false);

					// New PIN works
					const resultNew = auth.authenticate(pin2, ip);
					expect(resultNew.ok).toBe(true);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("re-setting PIN does not clear lockout state", () => {
			const time = 1_000_000;
			const auth = new AuthManager({
				maxAttempts: 3,
				lockoutMinutes: 15,
				now: () => time,
			});

			auth.setPin("1234");
			const wrongPin = "9999";

			// Lock the IP
			for (let i = 0; i < 3; i++) {
				auth.authenticate(wrongPin, "10.0.0.1");
			}
			expect(auth.isLocked("10.0.0.1")).toBe(true);

			// Re-set PIN — lockout should persist
			auth.setPin("5678");
			expect(auth.isLocked("10.0.0.1")).toBe(true);

			// Even new correct PIN should fail during lockout
			const result = auth.authenticate("5678", "10.0.0.1");
			expect(result.ok).toBe(false);
			expect(result.locked).toBe(true);
		});
	});

	// ─── P11: Lockout expiry in authenticate() ────────────────────────────

	describe("P11: Lockout expiry in authenticate(): correct PIN succeeds after lockout expires", () => {
		it("authenticate() auto-clears expired lockout and succeeds with correct PIN", () => {
			fc.assert(
				fc.property(
					validPin,
					ipAddress,
					fc.integer({ min: 1, max: 60 }),
					(pin, ip, lockoutMinutes) => {
						let time = 1_000_000;
						const auth = new AuthManager({
							maxAttempts: 3,
							lockoutMinutes,
							now: () => time,
						});
						auth.setPin(pin);

						const wrongPin = pin === "9999" ? "1111" : "9999";

						// Trigger lockout
						for (let i = 0; i < 3; i++) {
							auth.authenticate(wrongPin, ip);
						}
						expect(auth.isLocked(ip)).toBe(true);

						// Verify locked during lockout period
						const lockedResult = auth.authenticate(pin, ip);
						expect(lockedResult.ok).toBe(false);
						expect(lockedResult.locked).toBe(true);
						expect(lockedResult.retryAfter).toBeGreaterThan(0);

						// Advance time past lockout
						time += lockoutMinutes * 60_000 + 1;

						// authenticate() should auto-clear the expired lockout
						// and succeed with the correct PIN
						const result = auth.authenticate(pin, ip);
						expect(result.ok).toBe(true);
						expect(result.cookie).toBeDefined();

						// IP should no longer be locked
						expect(auth.isLocked(ip)).toBe(false);

						// Remaining attempts should be reset to maxAttempts
						expect(auth.getRemainingAttempts(ip)).toBe(3);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("authenticate() with wrong PIN after lockout expiry starts fresh failure counter", () => {
			let time = 1_000_000;
			const maxAttempts = 3;
			const lockoutMinutes = 15;
			const auth = new AuthManager({
				maxAttempts,
				lockoutMinutes,
				now: () => time,
			});
			auth.setPin("1234");

			// Trigger lockout
			for (let i = 0; i < maxAttempts; i++) {
				auth.authenticate("9999", "10.0.0.1");
			}
			expect(auth.isLocked("10.0.0.1")).toBe(true);
			expect(auth.getRemainingAttempts("10.0.0.1")).toBe(0);

			// Advance time past lockout
			time += lockoutMinutes * 60_000 + 1;

			// Wrong PIN after lockout expiry: lockout is cleared, then failure is recorded
			const result = auth.authenticate("9999", "10.0.0.1");
			expect(result.ok).toBe(false);
			expect(result.locked).toBeUndefined();

			// Should have maxAttempts - 1 remaining (one failure recorded)
			expect(auth.getRemainingAttempts("10.0.0.1")).toBe(maxAttempts - 1);
		});
	});
});
