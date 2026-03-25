// test/unit/daemon/port-scanner.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PortScanner,
	type PortScannerConfig,
} from "../../../src/lib/daemon/port-scanner.js";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";

describe("PortScanner", () => {
	const defaultConfig: PortScannerConfig = {
		portRange: [4096, 4100],
		intervalMs: 10_000,
		probeTimeoutMs: 2000,
		removalThreshold: 3,
	};

	let scanner: PortScanner;
	let mockProbe: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockProbe = vi.fn().mockResolvedValue(false);
		scanner = new PortScanner(new ServiceRegistry(), defaultConfig, mockProbe);
	});

	afterEach(() => {
		scanner.stop();
		vi.useRealTimers();
	});

	it("probes all ports in range on scan", async () => {
		await scanner.scan();
		expect(mockProbe).toHaveBeenCalledTimes(5); // 4096-4100 inclusive
		expect(mockProbe).toHaveBeenCalledWith(4096);
		expect(mockProbe).toHaveBeenCalledWith(4100);
	});

	it("reports discovered ports", async () => {
		mockProbe.mockImplementation((port: number) =>
			Promise.resolve(port === 4098),
		);
		const result = await scanner.scan();
		expect(result.discovered).toEqual([4098]);
		expect(result.lost).toEqual([]);
	});

	it("reports lost ports after removalThreshold consecutive failures", async () => {
		// First scan: port 4098 is up
		mockProbe.mockImplementation((port: number) =>
			Promise.resolve(port === 4098),
		);
		await scanner.scan();
		expect(scanner.getDiscovered()).toEqual(new Set([4098]));

		// Next 3 scans: port 4098 is down
		mockProbe.mockResolvedValue(false);
		await scanner.scan(); // failure 1
		await scanner.scan(); // failure 2
		const result = await scanner.scan(); // failure 3 = threshold
		expect(result.lost).toEqual([4098]);
		expect(scanner.getDiscovered()).toEqual(new Set());
	});

	it("resets failure count when port comes back", async () => {
		mockProbe.mockImplementation((port: number) =>
			Promise.resolve(port === 4098),
		);
		await scanner.scan(); // discovered

		mockProbe.mockResolvedValue(false);
		await scanner.scan(); // failure 1
		await scanner.scan(); // failure 2

		// Port comes back before threshold
		mockProbe.mockImplementation((port: number) =>
			Promise.resolve(port === 4098),
		);
		await scanner.scan();
		expect(scanner.getDiscovered()).toEqual(new Set([4098]));
	});

	it("skips excluded ports", async () => {
		scanner.excludePorts(new Set([4097, 4098]));
		await scanner.scan();
		expect(mockProbe).toHaveBeenCalledTimes(3); // 4096, 4099, 4100
		expect(mockProbe).not.toHaveBeenCalledWith(4097);
		expect(mockProbe).not.toHaveBeenCalledWith(4098);
	});

	it("start() triggers periodic scans", async () => {
		const onScan = vi.fn();
		scanner.on("scan", onScan);
		scanner.start();

		await vi.advanceTimersByTimeAsync(10_000);
		expect(onScan).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(onScan).toHaveBeenCalledTimes(2);
	});

	it("scan result includes active ports (all currently alive)", async () => {
		// First scan: ports 4097 and 4098 are alive
		mockProbe.mockImplementation((port: number) =>
			Promise.resolve(port === 4097 || port === 4098),
		);
		const first = await scanner.scan();
		expect(first.discovered).toEqual([4097, 4098]);
		expect(first.active).toEqual([4097, 4098]);

		// Second scan: same ports alive — discovered is empty (delta), active still reports them
		const second = await scanner.scan();
		expect(second.discovered).toEqual([]);
		expect(second.active).toEqual([4097, 4098]);
	});

	it("active excludes ports that have gone down", async () => {
		// First scan: port 4098 is alive
		mockProbe.mockImplementation((port: number) =>
			Promise.resolve(port === 4098),
		);
		await scanner.scan();

		// Port goes down, hits removal threshold
		mockProbe.mockResolvedValue(false);
		await scanner.scan();
		await scanner.scan();
		const result = await scanner.scan(); // threshold reached
		expect(result.lost).toEqual([4098]);
		expect(result.active).toEqual([]);
	});

	it("stop() cancels periodic scans", async () => {
		const onScan = vi.fn();
		scanner.on("scan", onScan);
		scanner.start();
		scanner.stop();

		await vi.advanceTimersByTimeAsync(20_000);
		expect(onScan).not.toHaveBeenCalled();
	});

	it("after drain(), interval no longer fires", async () => {
		const onScan = vi.fn();
		scanner.on("scan", onScan);
		scanner.start();

		// Drain cancels the tracked interval
		await scanner.drain();

		await vi.advanceTimersByTimeAsync(30_000);
		expect(onScan).not.toHaveBeenCalled();
	});

	it("in-flight scan() fetch is aborted by drain", async () => {
		// Create a probe that resolves after a microtask so scan is in-flight
		const hangingProbe = vi.fn().mockImplementation(
			() =>
				new Promise<boolean>((_resolve) => {
					// Resolve after a microtask — simulates an in-flight probe
					void Promise.resolve().then(() => _resolve(false));
				}),
		);

		const registry = new ServiceRegistry();
		const drainScanner = new PortScanner(registry, defaultConfig, hangingProbe);
		drainScanner.start();

		// Start a scan (which will call the hanging probe)
		drainScanner.scan().catch(() => {});

		// Drain while scan is in-flight
		await registry.drainAll();

		// After drain, the interval should not fire
		const onScan = vi.fn();
		drainScanner.on("scan", onScan);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(onScan).not.toHaveBeenCalled();
	});
});
