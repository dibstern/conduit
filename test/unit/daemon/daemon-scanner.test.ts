import { describe, expect, it, vi } from "vitest";
import { PortScanner } from "../../../src/lib/daemon/port-scanner.js";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";

describe("Daemon port scanner integration", () => {
	it("PortScanner wires discovered ports to addInstance pattern", async () => {
		// This test validates the integration pattern without needing the full Daemon.
		// The Daemon creates a PortScanner and wires scan events to InstanceManager calls.
		const mockProbe = vi
			.fn()
			.mockImplementation((port: number) => Promise.resolve(port === 4098));

		const scanner = new PortScanner(
			new ServiceRegistry(),
			{
				portRange: [4096, 4100],
				intervalMs: 10_000,
				probeTimeoutMs: 2000,
				removalThreshold: 3,
			},
			mockProbe,
		);

		const registered: number[] = [];
		const removed: number[] = [];

		scanner.on("scan", (result) => {
			for (const port of result.discovered) {
				registered.push(port);
			}
			for (const port of result.lost) {
				removed.push(port);
			}
		});

		// First scan: discovers port 4098
		await scanner.scan();
		expect(registered).toEqual([4098]);
		expect(removed).toEqual([]);

		// Port goes down for 3 scans
		mockProbe.mockResolvedValue(false);
		await scanner.scan();
		await scanner.scan();
		await scanner.scan();
		expect(removed).toEqual([4098]);
	});

	it("excludePorts prevents probing managed instance ports", async () => {
		const mockProbe = vi.fn().mockResolvedValue(true);

		const scanner = new PortScanner(
			new ServiceRegistry(),
			{
				portRange: [4096, 4100],
				intervalMs: 10_000,
				probeTimeoutMs: 2000,
				removalThreshold: 3,
			},
			mockProbe,
		);

		// Simulate managed instance on port 4096
		scanner.excludePorts(new Set([4096]));
		await scanner.scan();

		expect(mockProbe).not.toHaveBeenCalledWith(4096);
		expect(mockProbe).toHaveBeenCalledWith(4097);
	});
});
