// ─── Svelte Notifications — Unit Tests ───────────────────────────────────────
// Tests urlBase64ToUint8Array and enablePushSubscription.
// The old getPreferences/setPreferences tests were removed when those functions
// were replaced by getNotifSettings/saveNotifSettings in notif-settings.ts.

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	enablePushSubscription,
	urlBase64ToUint8Array,
} from "../../../src/lib/frontend/utils/notifications.js";

// ─── localStorage mock (still needed for atob in some environments) ──────────

beforeEach(() => {
	vi.unstubAllGlobals();
});

// ─── urlBase64ToUint8Array ───────────────────────────────────────────────────

describe("urlBase64ToUint8Array", () => {
	test("converts a base64url string to Uint8Array", () => {
		// "SGVsbG8" is base64url for "Hello"
		const result = urlBase64ToUint8Array("SGVsbG8");
		expect(result).toBeInstanceOf(Uint8Array);
		expect(result.length).toBe(5);
		expect(result[0]).toBe(72); // 'H'
		expect(result[1]).toBe(101); // 'e'
		expect(result[2]).toBe(108); // 'l'
		expect(result[3]).toBe(108); // 'l'
		expect(result[4]).toBe(111); // 'o'
	});

	test("handles base64url with - and _ characters", () => {
		// base64url uses - instead of + and _ instead of /
		// "f-_w" in base64url is "f+/w" in standard base64 = bytes [0x7f, 0xef, 0xf0]
		const result = urlBase64ToUint8Array("f-_w");
		expect(result).toBeInstanceOf(Uint8Array);
		// Verify it decoded something (the conversion replaces - with + and _ with /)
		expect(result.length).toBeGreaterThan(0);
	});

	test("adds padding when needed", () => {
		// "YQ" needs "==" padding to become "YQ==" (base64 for "a")
		const result = urlBase64ToUint8Array("YQ");
		expect(result.length).toBe(1);
		expect(result[0]).toBe(97); // 'a'
	});

	test("handles already padded input", () => {
		// "YQ==" is already padded base64 for "a"
		const result = urlBase64ToUint8Array("YQ==");
		expect(result.length).toBe(1);
		expect(result[0]).toBe(97); // 'a'
	});

	test("converts a VAPID-like key", () => {
		// Real VAPID keys are 65 bytes when decoded. Use a realistic-length base64url string.
		const vapidKey =
			"BNbxGYNMhEIi5AI7JxKDLMEJHS8HviCj2kfI3eFH1sVz3lf3vy3jGSHBi5F-cVrcVaOrq0K7y_9M1yq_JeUxhIk";
		const result = urlBase64ToUint8Array(vapidKey);
		expect(result).toBeInstanceOf(Uint8Array);
		expect(result.length).toBe(65); // VAPID keys are 65 bytes
	});

	test("returns empty Uint8Array for empty string", () => {
		const result = urlBase64ToUint8Array("");
		expect(result).toBeInstanceOf(Uint8Array);
		expect(result.length).toBe(0);
	});

	test("handles base64url string with no padding needed", () => {
		// "AQID" is base64 for bytes [1, 2, 3] — length % 4 === 0, no padding
		const result = urlBase64ToUint8Array("AQID");
		expect(result.length).toBe(3);
		expect(result[0]).toBe(1);
		expect(result[1]).toBe(2);
		expect(result[2]).toBe(3);
	});

	test("handles single padding character needed", () => {
		// "YWI" needs one "=" padding -> "YWI=" -> base64 for "ab"
		const result = urlBase64ToUint8Array("YWI");
		expect(result.length).toBe(2);
		expect(result[0]).toBe(97); // 'a'
		expect(result[1]).toBe(98); // 'b'
	});
});

// ─── enablePushSubscription ─────────────────────────────────────────────────
// Regression tests for the hang bug: the old code used navigator.serviceWorker.ready
// which never resolves when the SW fails to activate, permanently freezing the
// toggle button.  The rewritten function uses the registration from register()
// directly and never touches .ready.

/** Helper: build a mock registration with an already-active SW. */
function mockActiveReg(pushManager?: Record<string, unknown>) {
	return {
		active: { state: "activated" },
		installing: null,
		waiting: null,
		pushManager: pushManager ?? {
			getSubscription: vi.fn().mockResolvedValue(null),
			subscribe: vi.fn().mockResolvedValue({
				toJSON: () => ({ endpoint: "https://push.example.com/sub/default" }),
			}),
		},
	};
}

/** Helper: build a mock registration with an installing SW that fires statechange. */
function mockInstallingReg(pushManager?: Record<string, unknown>) {
	type Listener = (evt: unknown) => void;
	const listeners: Listener[] = [];
	const sw = {
		state: "installing",
		addEventListener: (_event: string, cb: Listener) => {
			listeners.push(cb);
		},
		removeEventListener: (_event: string, cb: Listener) => {
			const idx = listeners.indexOf(cb);
			if (idx >= 0) listeners.splice(idx, 1);
		},
		/** Simulate the SW transitioning to a new state. */
		transitionTo(newState: string) {
			sw.state = newState;
			for (const cb of [...listeners]) cb({});
		},
	};
	return {
		active: null,
		installing: sw,
		waiting: null,
		pushManager: pushManager ?? {
			getSubscription: vi.fn().mockResolvedValue(null),
			subscribe: vi.fn().mockResolvedValue({
				toJSON: () => ({ endpoint: "https://push.example.com/sub/default" }),
			}),
		},
		/** Expose sw for test control. */
		_sw: sw,
	};
}

describe("enablePushSubscription", () => {
	test("propagates actual browser error when SW registration fails", async () => {
		// The function must let the real error through so the user sees
		// the actual reason (not a generic "requires HTTPS" guess).
		const readySpy = vi.fn();
		vi.stubGlobal("navigator", {
			serviceWorker: {
				register: vi
					.fn()
					.mockRejectedValue(new TypeError("Failed to register")),
				get ready() {
					readySpy();
					return new Promise(() => {}); // never resolves
				},
			},
		});

		await expect(enablePushSubscription()).rejects.toThrow(
			"Failed to register",
		);
		// Critical: navigator.serviceWorker.ready must NOT have been accessed
		expect(readySpy).not.toHaveBeenCalled();
	});

	test("throws when SW not supported at all", async () => {
		vi.stubGlobal("navigator", {});

		await expect(enablePushSubscription()).rejects.toThrow(/service worker/i);
	});

	test("throws when VAPID key fetch fails", async () => {
		vi.stubGlobal("navigator", {
			serviceWorker: {
				register: vi.fn().mockResolvedValue(
					mockActiveReg({
						getSubscription: vi.fn().mockResolvedValue(null),
					}),
				),
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 500 }),
		);

		await expect(enablePushSubscription()).rejects.toThrow(/VAPID/i);
	});

	test("throws when browser push subscription fails", async () => {
		const pushManager = {
			getSubscription: vi.fn().mockResolvedValue(null),
			subscribe: vi.fn().mockRejectedValue(new DOMException("Not allowed")),
		};
		vi.stubGlobal("navigator", {
			serviceWorker: {
				register: vi.fn().mockResolvedValue(mockActiveReg(pushManager)),
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ publicKey: "test-key" }),
			}),
		);

		await expect(enablePushSubscription()).rejects.toThrow("Not allowed");
	});

	test("completes the full subscription flow on success", async () => {
		const mockSubscriptionJSON = {
			endpoint: "https://push.example.com/sub/123",
			keys: { p256dh: "key1", auth: "key2" },
		};
		const mockSubscription = {
			endpoint: "https://push.example.com/sub/123",
			toJSON: () => mockSubscriptionJSON,
		};
		const pushManager = {
			getSubscription: vi.fn().mockResolvedValue(null),
			subscribe: vi.fn().mockResolvedValue(mockSubscription),
		};
		vi.stubGlobal("navigator", {
			serviceWorker: {
				register: vi.fn().mockResolvedValue(mockActiveReg(pushManager)),
			},
		});
		const mockFetch = vi
			.fn()
			// First call: VAPID key fetch
			.mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({ publicKey: "test-vapid-key" }),
			})
			// Second call: server registration
			.mockResolvedValueOnce({ ok: true });
		vi.stubGlobal("fetch", mockFetch);
		const storage: Record<string, string> = {};
		vi.stubGlobal("localStorage", {
			setItem: (k: string, v: string) => {
				storage[k] = v;
			},
			getItem: (k: string) => storage[k] ?? null,
		});

		const result = await enablePushSubscription();
		expect(result).toEqual(mockSubscriptionJSON);
		expect(storage["vapid-public-key"]).toBe("test-vapid-key");
		// Verify server registration was called
		expect(mockFetch).toHaveBeenCalledTimes(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(mockFetch.mock.calls[1]![0]).toBe("/api/push/subscribe");
	});

	// ─── Activation wait tests ──────────────────────────────────────────────

	test("waits for SW activation via statechange events", async () => {
		const mockSubscriptionJSON = {
			endpoint: "https://push.example.com/sub/456",
		};
		const pushManager = {
			getSubscription: vi.fn().mockResolvedValue(null),
			subscribe: vi.fn().mockResolvedValue({
				toJSON: () => mockSubscriptionJSON,
			}),
		};
		const reg = mockInstallingReg(pushManager);
		vi.stubGlobal("navigator", {
			serviceWorker: {
				register: vi.fn().mockResolvedValue(reg),
			},
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ publicKey: "test-key" }),
				})
				.mockResolvedValueOnce({ ok: true }),
		);
		vi.stubGlobal("localStorage", {
			setItem: vi.fn(),
			getItem: vi.fn(),
		});

		// Activate the SW on the next microtask so the statechange listener fires
		const promise = enablePushSubscription();
		await vi.waitFor(() => {
			// Wait until the listener has been added
			if (reg._sw.state !== "installing")
				throw new Error("not ready for transition");
		});
		reg._sw.transitionTo("activated");

		const result = await promise;
		expect(result).toEqual(mockSubscriptionJSON);
	});

	test("rejects when SW becomes redundant during activation", async () => {
		const reg = mockInstallingReg();
		vi.stubGlobal("navigator", {
			serviceWorker: {
				register: vi.fn().mockResolvedValue(reg),
			},
		});

		const promise = enablePushSubscription();
		// Transition to redundant — the function should reject
		await vi.waitFor(() => {
			if (reg._sw.state !== "installing")
				throw new Error("not ready for transition");
		});
		reg._sw.transitionTo("redundant");

		await expect(promise).rejects.toThrow(/failed to activate/i);
	});

	test("throws when registration has no installing or waiting SW", async () => {
		// Edge case: register resolves with neither active, installing, nor waiting
		vi.stubGlobal("navigator", {
			serviceWorker: {
				register: vi.fn().mockResolvedValue({
					active: null,
					installing: null,
					waiting: null,
				}),
			},
		});

		await expect(enablePushSubscription()).rejects.toThrow(
			/not found after registration/i,
		);
	});
});
