import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { handleMessageMock, instances, replaceStateMock } = vi.hoisted(() => ({
	handleMessageMock: vi.fn(),
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
	armProtocolVersionCheck: () => {},
	disarmProtocolVersionCheck: () => {},
}));

import { getBrowserClientId } from "../../../src/lib/frontend/stores/client-identity.js";
import {
	dispatch,
	getAttentionSessions,
	resetNotifState,
} from "../../../src/lib/frontend/stores/notification-reducer.svelte.js";
import {
	attachedProjectState,
	getCurrentSlug,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	connect,
	disconnect,
	wsState,
} from "../../../src/lib/frontend/stores/ws.svelte.js";
import {
	clearDebugLog,
	getDebugEvents,
} from "../../../src/lib/frontend/stores/ws-debug.svelte.js";
import { disposeRuntime } from "../../../src/lib/frontend/transport/runtime.js";
import type { RelayMessage } from "../../../src/lib/frontend/types.js";

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

describe("WebSocket reconnect stream lifecycle", () => {
	beforeEach(() => {
		installBrowserGlobals();
		instances.length = 0;
		handleMessageMock.mockReset();
		handleMessageMock.mockImplementation((message: RelayMessage) => {
			if (message.type === "project_attached") {
				attachedProjectState.slug = message.slug;
			}
		});
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		replaceStateMock.mockClear();
		clearDebugLog();
		routerState.path = "/p/conduit/";
		attachedProjectState.slug = null;
		sessionState.currentId = null;
	});

	afterEach(async () => {
		disconnect();
		await disposeRuntime();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		routerState.path = "/";
		attachedProjectState.slug = null;
		sessionState.currentId = null;
	});

	it("opens the daemon socket with the route's session and project hints", () => {
		routerState.path = "/p/project-a/s/session-a";
		connect();
		const params = new URLSearchParams({
			client: getBrowserClientId(),
			session: "session-a",
			p: "project-a",
		});
		expect(instances[0]?.url).toBe(`ws://localhost:3000/ws?${params}`);
	});

	it("uses secure WebSockets and omits absent session and project hints", () => {
		routerState.path = "/";
		window.location.protocol = "https:";
		connect();
		expect(instances[0]?.url).toBe(
			`wss://localhost:3000/ws?client=${getBrowserClientId()}`,
		);
	});

	it("uses the new route on a fresh mount even when the previous attachment is retained", () => {
		connect();
		attachedProjectState.slug = "project-a";
		disconnect();
		routerState.path = "/p/project-b/";
		connect();
		expect(new URL(instances[1]?.url ?? "").searchParams.get("p")).toBe(
			"project-b",
		);
	});

	it("does not open another socket when the route or attached project changes", () => {
		connect();
		attachedProjectState.slug = "conduit";
		routerState.path = "/p/project-b/s/session-b";
		attachedProjectState.slug = "project-b";
		expect(instances).toHaveLength(1);
		expect(instances[0]?.readyState).toBe(MockWebSocket.OPEN);
	});

	it("reconnects with the attached project and current session rather than a pending route", async () => {
		vi.useFakeTimers();
		routerState.path = "/p/project-a/s/session-a";
		connect();
		instances[0]?.open();
		attachedProjectState.slug = "project-b";
		sessionState.currentId = "session-b";
		routerState.path = "/p/project-c/s/session-c";
		instances[0]?.close();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(instances).toHaveLength(2);
		const params = new URLSearchParams({
			client: getBrowserClientId(),
			session: "session-b",
			p: "project-b",
		});
		expect(instances[1]?.url).toBe(`ws://localhost:3000/ws?${params}`);
	});

	it("keeps the route session if the connection drops before the first attachment", async () => {
		vi.useFakeTimers();
		routerState.path = "/p/project-a/s/session-a";
		connect();
		instances[0]?.open();
		instances[0]?.close();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(instances).toHaveLength(2);
		expect(instances[1]?.url).toBe(instances[0]?.url);
	});

	it("waits for attachment before fetching status from the attached project", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ status: "ready" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		connect();
		expect(fetchMock).not.toHaveBeenCalled();
		const ws = instances[0];
		await vi.waitFor(() => expect(ws?.listenerCount("message")).toBe(1));
		ws?.emitMessage(
			JSON.stringify({ type: "project_attached", slug: "project-b" }),
		);

		await vi.waitFor(() => expect(wsState.relayStatus).toBe("ready"));
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
		connect();
		const ws = instances[0];
		await vi.waitFor(() => expect(ws?.listenerCount("message")).toBe(1));
		ws?.emitMessage(
			JSON.stringify({ type: "project_attached", slug: "project-a" }),
		);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		ws?.emitMessage(
			JSON.stringify({ type: "project_attached", slug: "project-b" }),
		);
		await vi.waitFor(() => expect(wsState.relayStatus).toBe("ready"));
		resolveOldStatus(new Response(null, { status: 401 }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(wsState.relayStatus).toBe("ready");
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
		connect();

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
		connect();

		await vi.waitFor(() => expect(wsState.relayStatus).toBe("ready"));
		expect(routerState.path).toBe("/p/conduit/");
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
		connect();
		connect();
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

		await vi.waitFor(() => expect(wsState.relayStatus).toBe("ready"));
		expect(routerState.path).toBe("/p/conduit/");
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
		connect();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		connect();
		await vi.waitFor(() => expect(wsState.relayStatus).toBe("ready"));

		bodyController.enqueue(
			new TextEncoder().encode(
				JSON.stringify({ status: "error", error: "stale response" }),
			),
		);
		bodyController.close();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(wsState.relayStatus).toBe("ready");
		expect(wsState.relayError).toBeUndefined();
	});

	it("disconnect cancels a scheduled reconnect", async () => {
		vi.useFakeTimers();
		connect();
		expect(instances).toHaveLength(1);

		instances[0]?.close();
		disconnect();
		await vi.advanceTimersByTimeAsync(20_000);

		expect(instances).toHaveLength(1);
	});

	// Resolutions can be missed while offline, so the reconnect's roots
	// snapshot is the authority; a still-pending child question survives
	// as its root's rolled-up count.
	it.each([
		["after a disconnect", () => instances[0]?.close()],
		["when a resume replaces a closing socket", () => connect()],
	])("drops attention indicators on the next open %s", (_, reconnect) => {
		resetNotifState();
		connect();
		instances[0]?.open();
		dispatch({ type: "question_appeared", sessionId: "child-c" });

		reconnect();
		connect();
		expect(getAttentionSessions(null, () => new Set()).size).toBe(1);
		instances.at(-1)?.open();

		expect(getAttentionSessions(null, () => new Set()).size).toBe(0);
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
