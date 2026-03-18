// ─── PIN Authentication & Rate Limiting (Ticket 2.4, 8.4) ───────────────────

import { createHash, randomBytes } from "node:crypto";

export interface AuthResult {
	ok: boolean;
	cookie?: string;
	locked?: boolean;
	retryAfter?: number;
}

interface AttemptRecord {
	count: number;
	firstAttemptAt: number;
	lockedUntil: number | null;
}

export interface AuthManagerOptions {
	maxAttempts?: number;
	lockoutMinutes?: number;
	cookieExpiryMs?: number;
	/** Injectable clock for testing */
	now?: () => number;
}

/** Hash a PIN with a domain-specific prefix (one-way, deterministic). */
export function hashPin(pin: string): string {
	return createHash("sha256").update(`opencode-relay:${pin}`).digest("hex");
}

export class AuthManager {
	private pin: string | null = null;
	private attempts: Map<string, AttemptRecord> = new Map();
	private cookies: Map<string, number> = new Map(); // cookie → expiry timestamp
	private readonly maxAttempts: number;
	private readonly lockoutMs: number;
	private readonly cookieExpiryMs: number;
	private readonly now: () => number;

	constructor(options: AuthManagerOptions = {}) {
		this.maxAttempts = options.maxAttempts ?? 5;
		this.lockoutMs = (options.lockoutMinutes ?? 15) * 60_000;
		this.cookieExpiryMs = options.cookieExpiryMs ?? 24 * 60 * 60_000; // 24 hours
		this.now = options.now ?? Date.now;
	}

	/** Set or update the PIN. Validates 4-8 digit format. Stores as SHA-256 hash. */
	setPin(pin: string): boolean {
		if (!/^\d{4,8}$/.test(pin)) return false;
		this.pin = hashPin(pin);
		return true;
	}

	/**
	 * Get the stored PIN hash.
	 * @deprecated Use getPinHash() instead — this now returns a hash, not the raw PIN.
	 */
	getPin(): string | null {
		return this.pin;
	}

	/** Get the stored PIN hash (for saving to config). */
	getPinHash(): string | null {
		return this.pin;
	}

	/** Set a pre-hashed PIN directly (e.g. loaded from config). No re-hashing. */
	setPinHash(hash: string): void {
		this.pin = hash;
	}

	/** Whether a PIN is set */
	hasPin(): boolean {
		return this.pin !== null;
	}

	/** Authenticate a PIN attempt from an IP address */
	authenticate(pin: string, ip: string): AuthResult {
		if (!this.pin) {
			// No PIN mode — always succeed
			return { ok: true, cookie: this.createCookie() };
		}

		const currentTime = this.now();

		// Check lockout
		const record = this.attempts.get(ip);
		if (record?.lockedUntil && currentTime < record.lockedUntil) {
			return {
				ok: false,
				locked: true,
				retryAfter: Math.ceil((record.lockedUntil - currentTime) / 1000),
			};
		}

		// Reset expired lockout
		if (record?.lockedUntil && currentTime >= record.lockedUntil) {
			this.attempts.delete(ip);
		}

		// Check PIN — hash the incoming PIN before comparing
		if (hashPin(pin) === this.pin) {
			// Correct — reset attempts and issue cookie
			this.attempts.delete(ip);
			return { ok: true, cookie: this.createCookie() };
		}

		// Incorrect — record attempt
		const existing = this.attempts.get(ip) ?? {
			count: 0,
			firstAttemptAt: currentTime,
			lockedUntil: null,
		};
		existing.count += 1;

		if (existing.count >= this.maxAttempts) {
			existing.lockedUntil = currentTime + this.lockoutMs;
		}

		this.attempts.set(ip, existing);

		if (existing.lockedUntil) {
			return {
				ok: false,
				locked: true,
				retryAfter: Math.ceil(this.lockoutMs / 1000),
			};
		}

		return { ok: false };
	}

	/** Validate a session cookie */
	validateCookie(cookie: string): boolean {
		const expiry = this.cookies.get(cookie);
		if (expiry === undefined) return false;
		if (this.now() >= expiry) {
			this.cookies.delete(cookie);
			return false;
		}
		return true;
	}

	/** Check if an IP is currently locked out */
	isLocked(ip: string): boolean {
		const record = this.attempts.get(ip);
		if (!record?.lockedUntil) return false;
		if (this.now() >= record.lockedUntil) {
			this.attempts.delete(ip);
			return false;
		}
		return true;
	}

	/** Get remaining attempts for an IP */
	getRemainingAttempts(ip: string): number {
		const record = this.attempts.get(ip);
		if (!record) return this.maxAttempts;
		return Math.max(0, this.maxAttempts - record.count);
	}

	private createCookie(): string {
		const cookie = randomBytes(32).toString("hex");
		this.cookies.set(cookie, this.now() + this.cookieExpiryMs);
		return cookie;
	}
}
