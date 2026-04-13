import { describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { SSEStream } from "../../../src/lib/relay/sse-stream.js";

function makeStubApi(events: Array<{ type: string; properties?: unknown }>) {
	return {
		event: {
			subscribe: vi.fn(async () => ({
				stream: (async function* () {
					for (const e of events) {
						yield e;
					}
				})(),
			})),
		},
	} as any;
}

describe("SSEStream", () => {
	it("registers itself with ServiceRegistry", () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		expect(registry.size).toBe(0);
		new SSEStream(registry, { api });
		expect(registry.size).toBe(1);
	});

	it("emits 'connected' when stream starts", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		const stream = new SSEStream(registry, { api });
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		stream.connect().catch(() => {});
		await connected;
		await stream.disconnect();
	});

	it("emits events from the SDK stream", async () => {
		const registry = new ServiceRegistry();
		const events = [
			{ type: "message.part.updated", properties: { part: { id: "p1" } } },
			{
				type: "session.status",
				properties: { sessionID: "s1", status: { type: "idle" } },
			},
		];
		const api = makeStubApi(events);
		const stream = new SSEStream(registry, { api });
		const received: unknown[] = [];
		stream.on("event", (e) => received.push(e));
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		stream.connect().catch(() => {});
		await connected;
		await new Promise((r) => setTimeout(r, 50));
		await stream.disconnect();
		expect(received).toHaveLength(2);
		expect(received[0]).toEqual(events[0]);
	});

	it("emits heartbeat for server.heartbeat events", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([{ type: "server.heartbeat" }]);
		const stream = new SSEStream(registry, { api });
		let heartbeatSeen = false;
		stream.on("heartbeat", () => {
			heartbeatSeen = true;
		});
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		stream.connect().catch(() => {});
		await connected;
		await new Promise((r) => setTimeout(r, 50));
		await stream.disconnect();
		expect(heartbeatSeen).toBe(true);
	});

	it("emits heartbeat for server.connected events", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([{ type: "server.connected" }]);
		const stream = new SSEStream(registry, { api });
		let heartbeatSeen = false;
		stream.on("heartbeat", () => {
			heartbeatSeen = true;
		});
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		stream.connect().catch(() => {});
		await connected;
		await new Promise((r) => setTimeout(r, 50));
		await stream.disconnect();
		expect(heartbeatSeen).toBe(true);
	});

	it("does not emit heartbeat events as regular events", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([
			{ type: "server.heartbeat" },
			{ type: "message.part.updated", properties: { part: { id: "p1" } } },
			{ type: "server.connected" },
		]);
		const stream = new SSEStream(registry, { api });
		const received: unknown[] = [];
		stream.on("event", (e) => received.push(e));
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		stream.connect().catch(() => {});
		await connected;
		await new Promise((r) => setTimeout(r, 50));
		await stream.disconnect();
		expect(received).toHaveLength(1);
		expect((received[0] as { type: string }).type).toBe("message.part.updated");
	});

	it("reports health state", () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		const stream = new SSEStream(registry, { api });
		const health = stream.getHealth();
		expect(health).toHaveProperty("connected");
		expect(health).toHaveProperty("lastEventAt");
		expect(health).toHaveProperty("reconnectCount");
	});

	it("isConnected returns false before connect", () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		const stream = new SSEStream(registry, { api });
		expect(stream.isConnected()).toBe(false);
	});

	it("isConnected returns true after connect", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([{ type: "message.part.updated", properties: {} }]);
		const stream = new SSEStream(registry, { api });
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		stream.connect().catch(() => {});
		await connected;
		expect(stream.isConnected()).toBe(true);
		await stream.disconnect();
	});

	it("isConnected returns false after disconnect", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		const stream = new SSEStream(registry, { api });
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		stream.connect().catch(() => {});
		await connected;
		await stream.disconnect();
		expect(stream.isConnected()).toBe(false);
	});

	it("drain stops the stream", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		const stream = new SSEStream(registry, { api });
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		stream.connect().catch(() => {});
		await connected;
		await stream.drain();
		expect(stream.isConnected()).toBe(false);
	});

	it("connect is idempotent when already running", async () => {
		const registry = new ServiceRegistry();
		const api = makeStubApi([]);
		const stream = new SSEStream(registry, { api });
		const connected = new Promise<void>((resolve) => {
			stream.on("connected", () => resolve());
		});
		stream.connect().catch(() => {});
		await connected;
		// Second connect should be a no-op
		await stream.connect();
		expect(api.event.subscribe).toHaveBeenCalledTimes(1);
		await stream.disconnect();
	});
});
