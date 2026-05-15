import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { handleMessageMock, instances } = vi.hoisted(() => ({
	handleMessageMock: vi.fn(),
	instances: [] as MockWebSocket[],
}));

class MockWebSocket {
	static readonly OPEN = 1;
	static readonly CLOSED = 3;

	readonly url: string;
	readyState = MockWebSocket.OPEN;
	private readonly listeners = new Map<
		string,
		Set<(event?: unknown) => void>
	>();

	constructor(url: string) {
		this.url = url;
		instances.push(this);
	}

	addEventListener(event: string, listener: (event?: unknown) => void): void {
		const existing = this.listeners.get(event);
		if (existing) {
			existing.add(listener);
			return;
		}
		this.listeners.set(event, new Set([listener]));
	}

	removeEventListener(
		event: string,
		listener: (event?: unknown) => void,
	): void {
		this.listeners.get(event)?.delete(listener);
	}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
		this.emit("close");
	}

	emitMessage(data: string): void {
		this.emit("message", new MessageEvent("message", { data }));
	}

	listenerCount(event: string): number {
		return this.listeners.get(event)?.size ?? 0;
	}

	private emit(event: string, payload?: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(payload);
		}
	}
}

vi.mock("../../../src/lib/frontend/stores/ws-dispatch.js", () => ({
	handleMessage: handleMessageMock,
}));

import {
	connect,
	disconnect,
} from "../../../src/lib/frontend/stores/ws.svelte.js";
import {
	clearDebugLog,
	getDebugEvents,
} from "../../../src/lib/frontend/stores/ws-debug.svelte.js";
import { disposeRuntime } from "../../../src/lib/frontend/transport/runtime.js";

function installBrowserGlobals(): void {
	Object.defineProperty(globalThis, "WebSocket", {
		value: MockWebSocket,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(globalThis, "window", {
		value: {
			location: {
				protocol: "http:",
				host: "localhost:3000",
				pathname: "/",
			},
			history: { pushState: () => {}, replaceState: () => {} },
			addEventListener: () => {},
		},
		writable: true,
		configurable: true,
	});
}

describe("WebSocket reconnect stream lifecycle", () => {
	beforeEach(() => {
		installBrowserGlobals();
		instances.length = 0;
		handleMessageMock.mockClear();
		clearDebugLog();
	});

	afterEach(async () => {
		disconnect();
		await disposeRuntime();
	});

	it("removes the old message stream before the replacement stream handles messages", async () => {
		connect();
		const first = instances[0];
		expect(first).toBeDefined();
		await vi.waitFor(() => expect(first?.listenerCount("message")).toBe(1));

		connect();
		const second = instances[1];
		expect(second).toBeDefined();
		await vi.waitFor(() => expect(first?.listenerCount("message")).toBe(0));
		await vi.waitFor(() => expect(second?.listenerCount("message")).toBe(1));

		first?.emitMessage(JSON.stringify({ type: "client_count", count: 1 }));
		second?.emitMessage(JSON.stringify({ type: "client_count", count: 2 }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(handleMessageMock).toHaveBeenCalledTimes(1);
		expect(handleMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({ type: "client_count", count: 2 }),
		);
	});

	it("surfaces malformed known protocol messages without dispatching them", async () => {
		connect();
		const ws = instances[0];
		expect(ws).toBeDefined();
		await vi.waitFor(() => expect(ws?.listenerCount("message")).toBe(1));

		ws?.emitMessage(JSON.stringify({ type: "delta" }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(handleMessageMock).not.toHaveBeenCalled();
		expect(getDebugEvents()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "protocol:error",
					detail: "invalid_message type=delta",
				}),
			]),
		);
	});
});
