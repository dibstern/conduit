// ─── PIN Hashing Tests (Ticket 8.4) ──────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { AuthManager, hashPin } from "../../../src/lib/auth.js";

describe("PIN hashing", () => {
	it("hashPin returns deterministic hex string", () => {
		const hash1 = hashPin("1234");
		const hash2 = hashPin("1234");
		expect(hash1).toBe(hash2);
	});

	it("hashPin returns different hashes for different PINs", () => {
		const hash1 = hashPin("1234");
		const hash2 = hashPin("5678");
		expect(hash1).not.toBe(hash2);
	});

	it("hashPin output is 64 chars hex", () => {
		const hash = hashPin("1234");
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("authenticate works with hashed storage", () => {
		const auth = new AuthManager({ now: () => 1_000_000 });
		auth.setPin("123456");
		const result = auth.authenticate("123456", "10.0.0.1");
		expect(result.ok).toBe(true);
		expect(result.cookie).toBeDefined();
	});

	it("authenticate rejects wrong PIN with hashed storage", () => {
		const auth = new AuthManager({ now: () => 1_000_000 });
		auth.setPin("123456");
		const result = auth.authenticate("654321", "10.0.0.1");
		expect(result.ok).toBe(false);
		expect(result.cookie).toBeUndefined();
	});

	it("setPinHash accepts pre-hashed value", () => {
		const auth = new AuthManager({ now: () => 1_000_000 });
		const hash = hashPin("1234");
		auth.setPinHash(hash);
		const result = auth.authenticate("1234", "10.0.0.1");
		expect(result.ok).toBe(true);
		expect(result.cookie).toBeDefined();
	});

	it("getPinHash returns stored hash", () => {
		const auth = new AuthManager();
		auth.setPin("5678");
		const hash = auth.getPinHash();
		expect(hash).toBe(hashPin("5678"));
		expect(hash).toHaveLength(64);
	});

	it("round-trip: hashPin → setPinHash → authenticate", () => {
		const auth = new AuthManager({ now: () => 1_000_000 });
		const pin = "99887766";
		const hash = hashPin(pin);

		// Load pre-hashed PIN (as if read from config)
		auth.setPinHash(hash);

		// Authenticate with the original raw PIN
		const result = auth.authenticate(pin, "192.168.1.1");
		expect(result.ok).toBe(true);
		expect(result.cookie).toBeDefined();

		// Wrong PIN should still fail
		const bad = auth.authenticate("11111111", "192.168.1.1");
		expect(bad.ok).toBe(false);

		// getPinHash should return the same hash
		expect(auth.getPinHash()).toBe(hash);
	});
});
