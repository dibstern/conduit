import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { instances, replaceStateMock } = vi.hoisted(() => ({
	instances: [] as MockWebSocket[],
	replaceStateMock: vi.fn(),
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

	open(): void {
		this.emit("open");
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

import {
	attachedProjectState,
	getCurrentSlug,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import { setAttachedProject } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	connectionState,
	trackControlSocket,
} from "../../../src/lib/frontend/transport/connection-status.svelte.js";

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
			history: { pushState: () => {}, replaceState: replaceStateMock },
			addEventListener: () => {},
		},
		writable: true,
		configurable: true,
	});
}

describe("RPC connection status recovery", () => {
	beforeEach(() => {
		installBrowserGlobals();
		instances.length = 0;
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		replaceStateMock.mockClear();
		routerState.path = "/";
		routerState.search = "?p=conduit";
		attachedProjectState.slug = null;
		connectionState.status = "";
		connectionState.statusText = "";
		connectionState.attempts = 0;
		connectionState.relayStatus = undefined;
		connectionState.relayError = undefined;
	});

	afterEach(() => {
		for (const socket of instances) socket.close();
		vi.unstubAllGlobals();
		routerState.path = "/";
		attachedProjectState.slug = null;
	});

	it("waits for attachment before fetching status from the attached project", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ status: "ready" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		trackControlSocket(new WebSocket("ws://localhost:3000/rpc"));
		expect(fetchMock).not.toHaveBeenCalled();
		const ws = instances[0];
		await vi.waitFor(() => expect(ws?.listenerCount("message")).toBe(1));
		setAttachedProject("project-b");

		await vi.waitFor(() => expect(connectionState.relayStatus).toBe("ready"));
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
			"/p/project-b/api/status",
		);
		expect(instances).toHaveLength(1);
	});

	it("ignores an old project's pending status response after reattachment", async () => {
		let resolveOldStatus!: (response: Response) => void;
		const oldStatus = new Promise<Response>((resolve) => {
			resolveOldStatus = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(() => oldStatus)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ status: "ready" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		trackControlSocket(new WebSocket("ws://localhost:3000/rpc"));
		const ws = instances[0];
		await vi.waitFor(() => expect(ws?.listenerCount("message")).toBe(1));
		setAttachedProject("project-a");
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		setAttachedProject("project-b");
		await vi.waitFor(() => expect(connectionState.relayStatus).toBe("ready"));
		resolveOldStatus(new Response(null, { status: 401 }));
		// Flush the stale response handler before asserting it did not replace the new status.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(connectionState.relayStatus).toBe("ready");
		expect(replaceStateMock).not.toHaveBeenCalled();
		expect(fetchMock.mock.calls).toEqual([
			["/p/project-a/api/status"],
			["/p/project-b/api/status"],
		]);
	});

	it("routes an unauthenticated relay status response to the PIN page", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						error: { code: "AUTH_REQUIRED", message: "PIN required" },
					}),
					{
						status: 401,
						headers: { "content-type": "application/json" },
					},
				),
			),
		);

		attachedProjectState.slug = "conduit";
		trackControlSocket(new WebSocket("ws://localhost:3000/rpc"));
		// An expired PIN session can reject the upgrade before the probe replies.
		instances[0]?.close();

		await vi.waitFor(() => expect(routerState.path).toBe("/auth"));
		expect(getCurrentSlug()).toBe("conduit");
		expect(replaceStateMock).toHaveBeenCalledOnce();
	});

	it("applies a successful relay status without replacing the route", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ status: "ready" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);

		attachedProjectState.slug = "conduit";
		trackControlSocket(new WebSocket("ws://localhost:3000/rpc"));

		await vi.waitFor(() => expect(connectionState.relayStatus).toBe("ready"));
		expect(routerState.path).toBe("/");
		expect(replaceStateMock).not.toHaveBeenCalled();
	});

	it("ignores an unauthenticated response from an obsolete connection", async () => {
		let resolveFirst!: (response: Response) => void;
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(() => firstResponse)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ status: "ready" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		attachedProjectState.slug = "conduit";
		trackControlSocket(new WebSocket("ws://localhost:3000/rpc"));
		trackControlSocket(new WebSocket("ws://localhost:3000/rpc"));
		resolveFirst(
			new Response(
				JSON.stringify({
					error: { code: "AUTH_REQUIRED", message: "PIN required" },
				}),
				{
					status: 401,
					headers: { "content-type": "application/json" },
				},
			),
		);

		await vi.waitFor(() => expect(connectionState.relayStatus).toBe("ready"));
		instances[1]?.open();
		expect(connectionState.status).toBe("connected");
		expect(connectionState.attempts).toBe(0);
		expect(connectionState.relayStatus).toBeUndefined();
		instances[0]?.open();
		instances[0]?.close();
		expect(connectionState.status).toBe("connected");
		expect(routerState.path).toBe("/");
		expect(replaceStateMock).not.toHaveBeenCalled();
	});

	it("ignores a parsed status body from an obsolete connection", async () => {
		let bodyController!: ReadableStreamDefaultController<Uint8Array>;
		const delayedResponse = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					bodyController = controller;
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(delayedResponse)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ status: "ready" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		attachedProjectState.slug = "conduit";
		trackControlSocket(new WebSocket("ws://localhost:3000/rpc"));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		trackControlSocket(new WebSocket("ws://localhost:3000/rpc"));
		await vi.waitFor(() => expect(connectionState.relayStatus).toBe("ready"));

		bodyController.enqueue(
			new TextEncoder().encode(
				JSON.stringify({ status: "error", error: "stale response" }),
			),
		);
		bodyController.close();
		// Flush the closed stale stream before asserting it did not change relay state.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(connectionState.relayError).toBeUndefined();
	});
});
