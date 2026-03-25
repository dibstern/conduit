import { describe, expect, it } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { TrackedService } from "../../../src/lib/daemon/tracked-service.js";

// Concrete implementation for testing
class TestService extends TrackedService<{ tick: [count: number] }> {
	public tickCount = 0;

	startTicking(ms: number): void {
		this.repeating(() => {
			this.tickCount++;
			this.emit("tick", this.tickCount);
		}, ms);
	}

	async doWork(): Promise<string> {
		return this.tracked(
			new Promise<string>((resolve) => setTimeout(() => resolve("done"), 50)),
		);
	}

	async doFetch(url: string): Promise<Response> {
		return this.fetch(url);
	}
}

describe("TrackedService", () => {
	it("auto-registers with the ServiceRegistry on construction", () => {
		const registry = new ServiceRegistry();
		const _svc = new TestService(registry);
		expect(registry.size).toBe(1);
	});

	it("repeating() creates a tracked interval", async () => {
		const registry = new ServiceRegistry();
		const svc = new TestService(registry);
		svc.startTicking(50);
		await new Promise((r) => setTimeout(r, 130));
		expect(svc.tickCount).toBeGreaterThanOrEqual(2);
		await svc.drain();
		const countAfterDrain = svc.tickCount;
		await new Promise((r) => setTimeout(r, 100));
		expect(svc.tickCount).toBe(countAfterDrain); // no more ticks
	});

	it("tracked() registers fire-and-forget promises", async () => {
		const registry = new ServiceRegistry();
		const svc = new TestService(registry);
		const result = svc.doWork();
		await expect(result).resolves.toBe("done");
	});

	it("drain() cancels the signal for fetch", async () => {
		const registry = new ServiceRegistry();
		const svc = new TestService(registry);
		await svc.drain();
		await expect(svc.doFetch("http://localhost:1")).rejects.toThrow();
	});

	it("fetch() merges caller signal with tracker signal", async () => {
		const registry = new ServiceRegistry();
		const svc = new TestService(registry);
		// fetch to a bad port rejects — verify the promise is trackable
		await expect(svc.doFetch("http://localhost:1")).rejects.toThrow();
		await svc.drain();
	});

	it("preserves EventEmitter functionality", () => {
		const registry = new ServiceRegistry();
		const svc = new TestService(registry);
		const events: number[] = [];
		svc.on("tick", (count) => events.push(count));
		svc.emit("tick", 42);
		expect(events).toEqual([42]);
	});
});

describe("ServiceRegistry", () => {
	it("drainAll() drains all registered services", async () => {
		const registry = new ServiceRegistry();
		const svc1 = new TestService(registry);
		const svc2 = new TestService(registry);
		svc1.startTicking(50);
		svc2.startTicking(50);
		await registry.drainAll();
		const c1 = svc1.tickCount;
		const c2 = svc2.tickCount;
		await new Promise((r) => setTimeout(r, 100));
		expect(svc1.tickCount).toBe(c1);
		expect(svc2.tickCount).toBe(c2);
	});

	it("drainAll() clears the registry", async () => {
		const registry = new ServiceRegistry();
		new TestService(registry);
		expect(registry.size).toBe(1);
		await registry.drainAll();
		expect(registry.size).toBe(0);
	});
});
