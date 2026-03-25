// src/lib/daemon/port-scanner.ts
import type { ServiceRegistry } from "./service-registry.js";
import { TrackedService } from "./tracked-service.js";

export interface PortScannerConfig {
	portRange: [number, number];
	intervalMs: number;
	probeTimeoutMs: number;
	removalThreshold: number;
}

export interface ScanResult {
	discovered: number[];
	lost: number[];
	/** All ports that responded as alive during this scan. */
	active: number[];
}

export type PortScannerEvents = {
	scan: [result: ScanResult];
};

type ProbeFn = (port: number) => Promise<boolean>;

export class PortScanner extends TrackedService<PortScannerEvents> {
	private config: PortScannerConfig;
	private probeFn: ProbeFn;
	private discovered = new Set<number>();
	private failureCounts = new Map<number, number>();
	private excluded = new Set<number>();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		registry: ServiceRegistry,
		config: PortScannerConfig,
		probeFn: ProbeFn,
	) {
		super(registry);
		this.config = config;
		this.probeFn = probeFn;
	}

	excludePorts(ports: Set<number>): void {
		this.excluded = ports;
	}

	getDiscovered(): Set<number> {
		return new Set(this.discovered);
	}

	async scan(): Promise<ScanResult> {
		const [start, end] = this.config.portRange;
		const ports: number[] = [];
		for (let p = start; p <= end; p++) {
			if (!this.excluded.has(p)) ports.push(p);
		}

		const results = await Promise.all(
			ports.map(async (port) => ({
				port,
				alive: await this.probeFn(port).catch(() => false),
			})),
		);

		const newlyDiscovered: number[] = [];
		const lost: number[] = [];
		const active: number[] = [];

		for (const { port, alive } of results) {
			if (alive) {
				active.push(port);
				if (!this.discovered.has(port)) {
					newlyDiscovered.push(port);
					this.discovered.add(port);
				}
				this.failureCounts.delete(port);
			} else if (this.discovered.has(port)) {
				const count = (this.failureCounts.get(port) ?? 0) + 1;
				if (count >= this.config.removalThreshold) {
					lost.push(port);
					this.discovered.delete(port);
					this.failureCounts.delete(port);
				} else {
					this.failureCounts.set(port, count);
				}
			}
		}

		const result: ScanResult = { discovered: newlyDiscovered, lost, active };
		this.emit("scan", result);
		return result;
	}

	start(): void {
		this.stop();
		this.timer = this.repeating(() => void this.scan(), this.config.intervalMs);
	}

	stop(): void {
		if (this.timer) {
			this.clearTrackedTimer(this.timer);
			this.timer = null;
		}
	}
}
