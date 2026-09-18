import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/frontend/utils/notif-settings.js", () => ({
	getNotifSettings: () => ({ sound: true, browser: true, push: true }),
}));
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => "project",
	navigate: vi.fn(),
}));

let state = "suspended";
let resume: () => Promise<void>;
let play: ReturnType<typeof vi.fn>;
let receive: (event: { data: { type: string }; ports: MessagePort[] }) => void;
const ports: MessagePort[] = [];

beforeEach(async () => {
	vi.resetModules();
	state = "suspended";
	resume = async () => {
		state = "running";
	};
	play = vi.fn();
	vi.stubGlobal(
		"AudioContext",
		class {
			get state() {
				return state;
			}
			resume() {
				return resume();
			}
			currentTime = 0;
			destination = {};
			createOscillator() {
				return {
					frequency: { value: 0 },
					connect() {},
					start: play,
					stop() {},
				};
			}
			createGain() {
				return {
					gain: { value: 0, exponentialRampToValueAtTime() {} },
					connect() {},
				};
			}
		},
	);
	vi.stubGlobal("navigator", {
		serviceWorker: {
			addEventListener: (_type: string, listener: typeof receive) => {
				receive = listener;
			},
		},
	});
	const page = await import(
		"../../../src/lib/frontend/stores/ws-notifications.js"
	);
	page.initSWMessageListener();
});

afterEach(() => {
	for (const port of ports) port.close();
	vi.unstubAllGlobals();
});

function offer(grant = true) {
	const channel = new MessageChannel();
	ports.push(channel.port1, channel.port2);
	const messages: unknown[] = [];
	channel.port1.onmessage = (event) => {
		messages.push(event.data);
		if (event.data.ready && grant) channel.port1.postMessage({ granted: true });
	};
	receive({ data: { type: "prepare_in_app_alert" }, ports: [channel.port2] });
	return messages;
}

it("waits for AudioContext resume and a grant before playback and acknowledgement", async () => {
	let wake = () => {};
	resume = () =>
		new Promise<void>((resolve) => {
			wake = () => {
				state = "running";
				resolve();
			};
		});
	const messages = offer();
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(messages).toEqual([]);
	expect(play).not.toHaveBeenCalled();
	wake();
	await vi.waitFor(() =>
		expect(messages).toEqual([{ ready: true }, { handled: true }]),
	);
	expect(play).toHaveBeenCalledOnce();
});

it("declines when resume fails", async () => {
	resume = async () => {
		throw new Error("autoplay denied");
	};
	const messages = offer();
	await vi.waitFor(() => expect(messages).toEqual([{ handled: false }]));
	expect(play).not.toHaveBeenCalled();
});

it("declines when resume resolves but audio remains suspended", async () => {
	resume = async () => {};
	const messages = offer();
	await vi.waitFor(() => expect(messages).toEqual([{ handled: false }]));
	expect(play).not.toHaveBeenCalled();
});

it("never plays a late offer after the worker has chosen the OS", async () => {
	state = "running";
	const messages = offer(false);
	await vi.waitFor(() => expect(messages).toEqual([{ ready: true }]));
	await new Promise((resolve) => setTimeout(resolve, 180));
	expect(play).not.toHaveBeenCalled();
});

it("chooses only the OS when the real page handler wakes audio after the offer timed out", async () => {
	let wake = () => {};
	resume = () =>
		new Promise<void>((resolve) => {
			wake = () => {
				state = "running";
				resolve();
			};
		});
	let push:
		| ((event: {
				data: { json: () => object };
				waitUntil: (work: Promise<unknown>) => void;
		  }) => void)
		| undefined;
	const showNotification = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal("self", {
		addEventListener: (type: string, listener: typeof push) => {
			if (type === "push") push = listener;
		},
		clients: {
			matchAll: async () => [
				{
					focused: true,
					visibilityState: "visible",
					postMessage: (data: { type: string }, transfer: MessagePort[]) => {
						ports.push(...transfer);
						receive({ data, ports: transfer });
					},
				},
			],
		},
		registration: { showNotification },
	});
	await import("../../../src/lib/frontend/sw.js");
	let finished: Promise<unknown> = Promise.resolve();
	push?.({
		data: { json: () => ({ type: "done", title: "Done" }) },
		waitUntil: (work) => {
			finished = work;
		},
	});
	await finished;
	expect(showNotification).toHaveBeenCalledOnce();
	wake();
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(play).not.toHaveBeenCalled();
});
