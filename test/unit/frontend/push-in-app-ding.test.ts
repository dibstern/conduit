// ─── The ding, delivered (ni8.23, decision 3.1 = F) ──────────────────────────
// The ding goes out through push, which means the service worker decides how it
// is heard. An OS notification for a session you are staring at is noise, so the
// SW offers the alert to a focused tab first — but only an explicit ack counts.
// Silence from the page (no listener, a thrown handler, a tab mid-navigation)
// falls through to the OS notification: the failure mode of this split must be
// an extra popup, never a ding nobody ever hears.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── ws-notifications module mocks (hoisted) ────────────────────────────────

const playDoneSoundMock = vi.fn();
const readyDoneSoundMock = vi.fn().mockResolvedValue(undefined);
const notifSettings = { push: true, browser: true, sound: true };

vi.mock("../../../src/lib/frontend/utils/sound.js", () => ({
	emitDoneSound: playDoneSoundMock,
	readyDoneSound: readyDoneSoundMock,
}));

vi.mock("../../../src/lib/frontend/utils/notif-settings.js", () => ({
	getNotifSettings: vi.fn(() => ({ ...notifSettings })),
}));

vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: vi.fn(() => "test-project"),
	navigate: vi.fn(),
}));

vi.mock("../../../src/lib/notification-content.js", () => ({
	notificationContent: vi.fn(() => null),
}));

// ─── Service worker half ────────────────────────────────────────────────────

type EventHandler = (...args: never[]) => unknown;

interface FakeClient {
	focused: boolean;
	visibilityState: string;
	postMessage: (message: unknown, transfer?: unknown[]) => void;
}

let pushListener: ((event: unknown) => void) | null = null;
let showNotification: ReturnType<typeof vi.fn>;
let windowClients: FakeClient[] = [];
let delivered: unknown[] = [];
let receiptCache: Map<string, Response>;
let activateListener: ((event: unknown) => void) | null = null;
let deleteCache: ReturnType<typeof vi.fn>;
let openCache: ReturnType<typeof vi.fn>;

/** A tab. `reply` is what its in-app handler does when offered the alert. */
function fakeClient(
	focused: boolean,
	reply: "ack" | "decline" | "silent",
): FakeClient {
	return {
		focused,
		visibilityState: focused ? "visible" : "hidden",
		postMessage: vi.fn((message: unknown, transfer?: unknown[]) => {
			delivered.push(message);
			const port = transfer?.[0] as MessagePort | undefined;
			if (!port || reply === "silent") return;
			if (reply === "decline") port.postMessage({ handled: false });
			else {
				port.onmessage = () => port.postMessage({ handled: true });
				port.postMessage({ ready: true });
			}
		}),
	};
}

/** Fire the push listener and wait for everything it kept alive. */
async function push(data: unknown): Promise<void> {
	if (!pushListener) throw new Error("push listener not registered");
	const waiting: Promise<unknown>[] = [];
	pushListener({
		data: { json: () => data },
		waitUntil: (p: Promise<unknown>) => void waiting.push(p),
	});
	await Promise.all(waiting);
}

beforeEach(async () => {
	vi.resetModules();
	pushListener = null;
	activateListener = null;
	receiptCache = new Map();
	windowClients = [];
	delivered = [];
	playDoneSoundMock.mockClear();
	readyDoneSoundMock.mockReset().mockResolvedValue(undefined);
	notifSettings.sound = true;
	showNotification = vi.fn().mockResolvedValue(undefined);

	vi.stubGlobal("self", {
		addEventListener: vi.fn((type: string, handler: EventHandler) => {
			if (type === "push") pushListener = handler as (event: unknown) => void;
			if (type === "activate")
				activateListener = handler as (event: unknown) => void;
		}),
		skipWaiting: vi.fn(),
		clients: {
			claim: vi.fn().mockResolvedValue(undefined),
			matchAll: vi.fn(async () => windowClients),
			openWindow: vi.fn(),
		},
		registration: { showNotification, scope: "/" },
		location: { origin: "http://localhost:2633" },
	});
	deleteCache = vi.fn();
	openCache = vi.fn(async () => ({
		match: async (key: string) => receiptCache.get(key),
		put: async (key: string, response: Response) => {
			receiptCache.set(key, response);
		},
	}));
	vi.stubGlobal("caches", {
		keys: vi.fn(async () => ["conduit-alert-receipts-v1", "old-assets"]),
		delete: deleteCache,
		open: openCache,
	});

	await import("../../../src/lib/frontend/sw.js");
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const doneAlert = {
	type: "done",
	title: "Task Complete",
	body: "Agent has finished",
	tag: "opencode-done",
	sessionId: "s1",
};

describe("SW push: in-app ding vs OS notification", () => {
	it.each([
		"tab",
		"OS",
	])("deduplicates concurrent and restarted %s delivery", async (recipient) => {
		if (recipient === "tab") windowClients = [fakeClient(true, "ack")];
		const identified = {
			...doneAlert,
			slug: "project",
			alertId: "turn-1:done",
		};
		await Promise.all([push(identified), push(identified)]);
		expect(
			recipient === "tab"
				? delivered.length
				: showNotification.mock.calls.length,
		).toBe(1);
		vi.resetModules();
		await import("../../../src/lib/frontend/sw.js");
		await push(identified);
		expect(
			recipient === "tab"
				? delivered.length
				: showNotification.mock.calls.length,
		).toBe(1);
		await push({ ...identified, alertId: "turn-2:done" });
		expect(
			recipient === "tab"
				? delivered.length
				: showNotification.mock.calls.length,
		).toBe(2);
	});

	it("retains successful receipts when a new worker activates", async () => {
		if (!activateListener) throw new Error("activate listener not registered");
		const pending: Promise<unknown>[] = [];
		activateListener({
			waitUntil: (work: Promise<unknown>) => pending.push(work),
		});
		await Promise.all(pending);
		expect(deleteCache).toHaveBeenCalledExactlyOnceWith("old-assets");
	});

	it("retries a failed OS delivery without retaining a receipt", async () => {
		const identified = { ...doneAlert, alertId: "turn-1:done" };
		showNotification.mockRejectedValueOnce(
			new Error("notification unavailable"),
		);
		await push(identified);
		expect(receiptCache.size).toBe(0);
		await push(identified);
		expect(showNotification).toHaveBeenCalledTimes(2);
		expect(receiptCache.size).toBe(1);
	});

	it("waits for live delivery before deciding whether a retry is needed", async () => {
		let finish: (() => void) | undefined;
		showNotification.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const identified = { ...doneAlert, alertId: "turn-1:done" };
		const first = push(identified);
		await vi.waitFor(() => expect(showNotification).toHaveBeenCalledOnce());
		const retry = push(identified);
		expect(receiptCache.size).toBe(0);
		finish?.();
		await Promise.all([first, retry]);
		expect(showNotification).toHaveBeenCalledOnce();
		expect(receiptCache.size).toBe(1);
	});

	it.each([
		"read",
		"write",
	])("delivers again when receipt %s fails", async (failure) => {
		openCache.mockResolvedValue({
			match: async () => {
				if (failure === "read") throw new Error("storage unavailable");
				return undefined;
			},
			put: async () => {
				throw new Error("storage unavailable");
			},
		});
		const identified = { ...doneAlert, alertId: "turn-1:done" };
		await push(identified);
		await push(identified);
		expect(showNotification).toHaveBeenCalledTimes(2);
	});

	it("hands the alert to a focused tab instead of the OS", async () => {
		windowClients = [fakeClient(true, "ack")];

		await push(doneAlert);

		expect(delivered).toEqual([
			expect.objectContaining({
				type: "prepare_in_app_alert",
				payload: doneAlert,
			}),
		]);
		expect(showNotification).not.toHaveBeenCalled();
	});

	it("accepts a delayed playback acknowledgement within the delivery deadline", async () => {
		windowClients = [
			{
				focused: true,
				visibilityState: "visible",
				postMessage: (_message, ports) => {
					const port = ports?.[0] as MessagePort;
					port.onmessage = () =>
						setTimeout(() => port.postMessage({ handled: true }), 50);
					port.postMessage({ ready: true });
				},
			},
		];
		await push(doneAlert);
		expect(showNotification).not.toHaveBeenCalled();
	});

	it("shows the OS notification when the tab vanishes after ownership is granted", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const granted = new Promise<void>((resolve) => {
			windowClients = [
				{
					focused: true,
					visibilityState: "visible",
					postMessage: (_message, ports) => {
						const port = ports?.[0] as MessagePort;
						port.onmessage = () => {
							port.close();
							resolve();
						};
						port.postMessage({ ready: true });
					},
				},
			];
		});
		const delivery = push(doneAlert);
		await granted;
		expect(showNotification).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		expect(showNotification).toHaveBeenCalledWith(
			"Task Complete",
			expect.objectContaining({ tag: "opencode-done" }),
		);
		await delivery;
	});

	it("shows the OS notification when the focused tab never answers", async () => {
		// A page with no listener, or one that threw before acking. Nothing else
		// in the system would ever mention the ding again, so it must not vanish.
		windowClients = [fakeClient(true, "silent")];

		await push(doneAlert);

		expect(showNotification).toHaveBeenCalledWith(
			"Task Complete",
			expect.objectContaining({ tag: "opencode-done" }),
		);
	});

	it("shows the OS notification when the focused tab declines", async () => {
		windowClients = [fakeClient(true, "decline")];

		await push(doneAlert);

		expect(showNotification).toHaveBeenCalledTimes(1);
	});

	it("does not bother a tab that is not focused", async () => {
		const background = fakeClient(false, "ack");
		windowClients = [background];

		await push(doneAlert);

		expect(background.postMessage).not.toHaveBeenCalled();
		expect(showNotification).toHaveBeenCalledTimes(1);
	});

	it("still says nothing for a silent validation push", async () => {
		windowClients = [fakeClient(true, "ack")];

		await push({ type: "test" });

		expect(delivered).toEqual([]);
		expect(showNotification).not.toHaveBeenCalled();
	});
});

// ─── Page half ──────────────────────────────────────────────────────────────

describe("page: answering the service worker's offer", () => {
	/** Deliver an in_app_alert to the page listener and read its answer. */
	async function offer(): Promise<unknown> {
		const listeners: Array<(event: unknown) => void> = [];
		vi.stubGlobal("navigator", {
			serviceWorker: {
				addEventListener: (type: string, fn: (event: unknown) => void) => {
					if (type === "message") listeners.push(fn);
				},
			},
		});
		const mod = await import(
			"../../../src/lib/frontend/stores/ws-notifications.js"
		);
		mod.initSWMessageListener();

		const channel = new MessageChannel();
		const answer = new Promise<unknown>((resolve) => {
			channel.port1.onmessage = (event: MessageEvent) => {
				if (event.data.ready) channel.port1.postMessage({ granted: true });
				else resolve(event.data);
			};
			setTimeout(() => resolve("no answer"), 200);
		});
		for (const fn of listeners)
			fn({
				data: { type: "prepare_in_app_alert", payload: { type: "done" } },
				ports: [channel.port2],
			});
		return answer;
	}

	it("dings in the page and says it handled it", async () => {
		expect(await offer()).toEqual({ handled: true });
		expect(playDoneSoundMock).toHaveBeenCalled();
	});

	it("declines when the user turned the sound off, rather than going quiet", async () => {
		// Nothing perceptible would happen here, so claiming the alert would eat
		// it. Declining hands it back to the OS notification the user still has on.
		notifSettings.sound = false;

		expect(await offer()).toEqual({ handled: false });
		expect(playDoneSoundMock).not.toHaveBeenCalled();
	});
});
