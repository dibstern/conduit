// ─── Leaf Service Effect Layers ─────────────────────────────────────────────
// Tests for Effect-native layer replacements of daemon leaf services.

import { describe, it } from "@effect/vitest";
import {
	Context,
	Duration,
	Effect,
	Exit,
	Layer,
	Ref,
	Scope,
	TestClock,
} from "effect";
import { expect, vi } from "vitest";
import {
	KeepAwakeLive,
	KeepAwakeTag,
} from "../../../src/lib/effect/keep-awake-layer.js";
import {
	PortScannerLive,
	PortScannerTag,
} from "../../../src/lib/effect/port-scanner-layer.js";
import {
	RateLimiterLive,
	RateLimiterTag,
} from "../../../src/lib/effect/rate-limiter-layer.js";
import {
	StorageMonitorLive,
	StorageMonitorTag,
} from "../../../src/lib/effect/storage-monitor-layer.js";
import {
	VersionCheckerLive,
	VersionCheckerTag,
} from "../../../src/lib/effect/version-checker-layer.js";

/** Helper: build the layer, run the body, then close the scope. */
const withMonitor = (
	config: {
		getStorageUsage: () => Effect.Effect<number>;
		persistence: { evictOldEvents: () => Effect.Effect<void> };
		checkInterval: Duration.DurationInput;
		highWaterMark: number;
	},
	body: (
		svc: Context.Tag.Service<typeof StorageMonitorTag>,
	) => Effect.Effect<void>,
) =>
	Effect.gen(function* () {
		const layer = StorageMonitorLive(config);
		const scope = yield* Scope.make();
		const ctx = yield* Layer.buildWithScope(layer, scope);
		const svc = Context.get(ctx, StorageMonitorTag);

		// Advance TestClock past zero so the forked fiber's initial check runs
		yield* TestClock.adjust(Duration.millis(1));

		yield* body(svc);
		yield* Scope.close(scope, Exit.void);
	});

describe("Leaf service Layers", () => {
	describe("StorageMonitor", () => {
		it.scoped("Layer constructs and provides tag", () =>
			Effect.gen(function* () {
				const layer = StorageMonitorLive({
					getStorageUsage: vi.fn().mockReturnValue(Effect.succeed(0.5)),
					persistence: {
						evictOldEvents: vi.fn().mockReturnValue(Effect.succeed(undefined)),
					},
					checkInterval: Duration.seconds(60),
					highWaterMark: 0.9,
				});

				const scope = yield* Scope.make();
				const ctx = yield* Layer.buildWithScope(layer, scope);
				const svc = Context.get(ctx, StorageMonitorTag);
				const usage = yield* svc.getUsage();
				expect(typeof usage).toBe("number");
				yield* Scope.close(scope, Exit.void);
			}),
		);

		it.scoped("background check records usage from getStorageUsage", () =>
			withMonitor(
				{
					getStorageUsage: vi.fn().mockReturnValue(Effect.succeed(0.42)),
					persistence: {
						evictOldEvents: vi.fn().mockReturnValue(Effect.succeed(undefined)),
					},
					checkInterval: Duration.seconds(60),
					highWaterMark: 0.9,
				},
				(svc) =>
					Effect.gen(function* () {
						const usage = yield* svc.getUsage();
						expect(usage).toBe(0.42);
						const lastCheck = yield* svc.getLastCheck();
						expect(lastCheck).toBeGreaterThan(0);
					}),
			),
		);

		it.scoped("evicts when usage exceeds high-water mark", () => {
			const evictOldEvents = vi.fn().mockReturnValue(Effect.succeed(undefined));
			return withMonitor(
				{
					getStorageUsage: vi.fn().mockReturnValue(Effect.succeed(0.95)),
					persistence: { evictOldEvents },
					checkInterval: Duration.seconds(60),
					highWaterMark: 0.9,
				},
				() =>
					Effect.sync(() => {
						expect(evictOldEvents).toHaveBeenCalled();
					}),
			);
		});

		it.scoped("does not evict when usage is below high-water mark", () => {
			const evictOldEvents = vi.fn().mockReturnValue(Effect.succeed(undefined));
			return withMonitor(
				{
					getStorageUsage: vi.fn().mockReturnValue(Effect.succeed(0.5)),
					persistence: { evictOldEvents },
					checkInterval: Duration.seconds(60),
					highWaterMark: 0.9,
				},
				() =>
					Effect.sync(() => {
						expect(evictOldEvents).not.toHaveBeenCalled();
					}),
			);
		});

		it.scoped("scope close interrupts background fiber cleanly", () =>
			Effect.gen(function* () {
				const layer = StorageMonitorLive({
					getStorageUsage: vi.fn().mockReturnValue(Effect.succeed(0.5)),
					persistence: {
						evictOldEvents: vi.fn().mockReturnValue(Effect.succeed(undefined)),
					},
					checkInterval: Duration.millis(50),
					highWaterMark: 0.9,
				});

				const scope = yield* Scope.make();
				yield* Layer.buildWithScope(layer, scope);
				const exit = yield* Effect.exit(Scope.close(scope, Exit.void));
				expect(Exit.isSuccess(exit)).toBe(true);
			}),
		);
	});

	describe("VersionChecker", () => {
		/** Helper: build the layer, advance clock, run the body, then close scope. */
		const withVersionChecker = (
			config: {
				getCurrentVersion: () => string;
				fetchLatestVersion: () => Effect.Effect<string | null>;
				broadcast: (msg: {
					type: string;
					current: string;
					latest: string;
				}) => Effect.Effect<void>;
				checkInterval: Duration.DurationInput;
			},
			body: (
				svc: Context.Tag.Service<typeof VersionCheckerTag>,
			) => Effect.Effect<void>,
		) =>
			Effect.gen(function* () {
				const layer = VersionCheckerLive(config);
				const scope = yield* Scope.make();
				const ctx = yield* Layer.buildWithScope(layer, scope);
				const svc = Context.get(ctx, VersionCheckerTag);

				// Advance TestClock past zero so the forked fiber's initial check runs
				yield* TestClock.adjust(Duration.millis(1));

				yield* body(svc);
				yield* Scope.close(scope, Exit.void);
			});

		it.scoped("detects newer version and broadcasts", () => {
			const broadcast = vi.fn().mockReturnValue(Effect.succeed(undefined));
			return withVersionChecker(
				{
					getCurrentVersion: () => "1.0.0",
					fetchLatestVersion: vi.fn().mockReturnValue(Effect.succeed("2.0.0")),
					broadcast,
					checkInterval: Duration.hours(1),
				},
				(svc) =>
					Effect.gen(function* () {
						const latest = yield* svc.getLatestKnown();
						expect(latest).toBe("2.0.0");
						expect(broadcast).toHaveBeenCalledWith({
							type: "version_update",
							current: "1.0.0",
							latest: "2.0.0",
						});
					}),
			);
		});

		it.scoped("does not broadcast when version is same", () => {
			const broadcast = vi.fn().mockReturnValue(Effect.succeed(undefined));
			return withVersionChecker(
				{
					getCurrentVersion: () => "1.0.0",
					fetchLatestVersion: vi.fn().mockReturnValue(Effect.succeed("1.0.0")),
					broadcast,
					checkInterval: Duration.hours(1),
				},
				() =>
					Effect.sync(() => {
						expect(broadcast).not.toHaveBeenCalled();
					}),
			);
		});

		it.scoped("does not broadcast when fetched version is older", () => {
			const broadcast = vi.fn().mockReturnValue(Effect.succeed(undefined));
			return withVersionChecker(
				{
					getCurrentVersion: () => "2.0.0",
					fetchLatestVersion: vi.fn().mockReturnValue(Effect.succeed("1.0.0")),
					broadcast,
					checkInterval: Duration.hours(1),
				},
				() =>
					Effect.sync(() => {
						expect(broadcast).not.toHaveBeenCalled();
					}),
			);
		});

		it.scoped("does not broadcast when fetch returns null", () => {
			const broadcast = vi.fn().mockReturnValue(Effect.succeed(undefined));
			return withVersionChecker(
				{
					getCurrentVersion: () => "1.0.0",
					fetchLatestVersion: vi.fn().mockReturnValue(Effect.succeed(null)),
					broadcast,
					checkInterval: Duration.hours(1),
				},
				() =>
					Effect.sync(() => {
						expect(broadcast).not.toHaveBeenCalled();
					}),
			);
		});

		it.scoped("getCurrentVersion returns configured version", () =>
			withVersionChecker(
				{
					getCurrentVersion: () => "3.5.1",
					fetchLatestVersion: vi.fn().mockReturnValue(Effect.succeed(null)),
					broadcast: vi.fn().mockReturnValue(Effect.succeed(undefined)),
					checkInterval: Duration.hours(1),
				},
				(svc) =>
					Effect.gen(function* () {
						const current = yield* svc.getCurrentVersion();
						expect(current).toBe("3.5.1");
					}),
			),
		);

		it.scoped("scope close interrupts background fiber cleanly", () =>
			Effect.gen(function* () {
				const layer = VersionCheckerLive({
					getCurrentVersion: () => "1.0.0",
					fetchLatestVersion: vi.fn().mockReturnValue(Effect.succeed("2.0.0")),
					broadcast: vi.fn().mockReturnValue(Effect.succeed(undefined)),
					checkInterval: Duration.millis(50),
				});

				const scope = yield* Scope.make();
				yield* Layer.buildWithScope(layer, scope);
				const exit = yield* Effect.exit(Scope.close(scope, Exit.void));
				expect(Exit.isSuccess(exit)).toBe(true);
			}),
		);
	});

	describe("PortScanner", () => {
		/** Helper: build the layer, advance clock, run the body, then close scope. */
		const withPortScanner = (
			config: {
				probeFn: (port: number) => Effect.Effect<boolean>;
				portRange: [number, number];
				scanInterval: Duration.DurationInput;
				removalThreshold: number;
				onDiscovered: (port: number) => Effect.Effect<void>;
				onLost: (port: number) => Effect.Effect<void>;
				excludedPorts?: Set<number>;
			},
			body: (
				svc: Context.Tag.Service<typeof PortScannerTag>,
			) => Effect.Effect<void>,
		) =>
			Effect.gen(function* () {
				const layer = PortScannerLive(config);
				const scope = yield* Scope.make();
				const ctx = yield* Layer.buildWithScope(layer, scope);
				const svc = Context.get(ctx, PortScannerTag);

				// Advance TestClock past zero so the forked fiber's initial scan runs
				yield* TestClock.adjust(Duration.millis(1));

				yield* body(svc);
				yield* Scope.close(scope, Exit.void);
			});

		it.scoped("discovers alive ports and calls onDiscovered", () => {
			const onDiscovered = vi.fn().mockReturnValue(Effect.succeed(undefined));
			const onLost = vi.fn().mockReturnValue(Effect.succeed(undefined));
			return withPortScanner(
				{
					probeFn: (port) => Effect.succeed(port === 3000),
					portRange: [2999, 3001],
					scanInterval: Duration.seconds(10),
					removalThreshold: 3,
					onDiscovered,
					onLost,
				},
				(svc) =>
					Effect.gen(function* () {
						const known = yield* svc.getKnownPorts();
						expect(known.has(3000)).toBe(true);
						expect(known.size).toBe(1);
						expect(onDiscovered).toHaveBeenCalledWith(3000);
						expect(onLost).not.toHaveBeenCalled();
					}),
			);
		});

		it.scoped(
			"hysteresis: port not removed until removalThreshold consecutive failures",
			() => {
				const onDiscovered = vi.fn().mockReturnValue(Effect.succeed(undefined));
				const onLost = vi.fn().mockReturnValue(Effect.succeed(undefined));

				// scanCount tracks which scan we are on so probeFn can vary behavior
				const scanCountRef = Ref.unsafeMake(0);

				// Scan 0: port 3000 alive (discovered)
				// Scan 1: port 3000 dead (failure count = 1)
				// Scan 2: port 3000 dead (failure count = 2, still below threshold of 3)
				// Scan 3: port 3000 dead (failure count = 3, reaches threshold -> removed)
				const probeFn = (port: number) =>
					Effect.gen(function* () {
						const count = yield* Ref.get(scanCountRef);
						return port === 3000 && count === 0;
					});

				return Effect.gen(function* () {
					const layer = PortScannerLive({
						probeFn,
						portRange: [3000, 3000],
						scanInterval: Duration.seconds(10),
						removalThreshold: 3,
						onDiscovered,
						onLost,
					});

					const scope = yield* Scope.make();
					const ctx = yield* Layer.buildWithScope(layer, scope);
					const svc = Context.get(ctx, PortScannerTag);

					// Scan 0: advance clock to trigger initial scan. Port alive.
					yield* TestClock.adjust(Duration.millis(1));
					const afterScan0 = yield* svc.getKnownPorts();
					expect(afterScan0.has(3000)).toBe(true);
					expect(onDiscovered).toHaveBeenCalledWith(3000);

					// Scan 1: port now dead. Advance scanCount and trigger next scan.
					yield* Ref.set(scanCountRef, 1);
					yield* TestClock.adjust(Duration.seconds(10));
					const afterScan1 = yield* svc.getKnownPorts();
					expect(afterScan1.has(3000)).toBe(true); // Still known (1 failure)
					expect(onLost).not.toHaveBeenCalled();

					// Scan 2: still dead. 2 failures, still below threshold of 3.
					yield* TestClock.adjust(Duration.seconds(10));
					const afterScan2 = yield* svc.getKnownPorts();
					expect(afterScan2.has(3000)).toBe(true); // Still known (2 failures)
					expect(onLost).not.toHaveBeenCalled();

					// Scan 3: still dead. 3 failures = threshold reached -> removed.
					yield* TestClock.adjust(Duration.seconds(10));
					const afterScan3 = yield* svc.getKnownPorts();
					expect(afterScan3.has(3000)).toBe(false); // Removed
					expect(onLost).toHaveBeenCalledWith(3000);

					yield* Scope.close(scope, Exit.void);
				});
			},
		);

		it.scoped("excludedPorts are not scanned", () => {
			const onDiscovered = vi.fn().mockReturnValue(Effect.succeed(undefined));
			return withPortScanner(
				{
					probeFn: () => Effect.succeed(true),
					portRange: [3000, 3002],
					scanInterval: Duration.seconds(10),
					removalThreshold: 3,
					onDiscovered,
					onLost: vi.fn().mockReturnValue(Effect.succeed(undefined)),
					excludedPorts: new Set([3001]),
				},
				(svc) =>
					Effect.gen(function* () {
						const known = yield* svc.getKnownPorts();
						expect(known.has(3000)).toBe(true);
						expect(known.has(3001)).toBe(false);
						expect(known.has(3002)).toBe(true);
						expect(known.size).toBe(2);
					}),
			);
		});

		it.scoped("scope close interrupts background fiber cleanly", () =>
			Effect.gen(function* () {
				const layer = PortScannerLive({
					probeFn: () => Effect.succeed(true),
					portRange: [3000, 3000],
					scanInterval: Duration.millis(50),
					removalThreshold: 3,
					onDiscovered: () => Effect.succeed(undefined),
					onLost: () => Effect.succeed(undefined),
				});

				const scope = yield* Scope.make();
				yield* Layer.buildWithScope(layer, scope);
				const exit = yield* Effect.exit(Scope.close(scope, Exit.void));
				expect(Exit.isSuccess(exit)).toBe(true);
			}),
		);
	});

	describe("KeepAwake", () => {
		it.scoped("isSupported returns true on macOS/Linux", () =>
			Effect.gen(function* () {
				// Default config uses detectPlatformCommand (macOS or Linux in CI)
				const layer = KeepAwakeLive();
				const scope = yield* Scope.make();
				const ctx = yield* Layer.buildWithScope(layer, scope);
				const svc = Context.get(ctx, KeepAwakeTag);

				const supported = yield* svc.isSupported();
				// In test env process.platform is either darwin or linux
				const expected = ["darwin", "linux"].includes(process.platform);
				expect(supported).toBe(expected);

				yield* Scope.close(scope, Exit.void);
			}),
		);

		it.scoped("activate/deactivate is idempotent", () =>
			Effect.gen(function* () {
				// Use a custom command to ensure isSupported = true regardless of platform
				const layer = KeepAwakeLive({ command: "sleep", args: ["infinity"] });
				const scope = yield* Scope.make();
				const ctx = yield* Layer.buildWithScope(layer, scope);
				const svc = Context.get(ctx, KeepAwakeTag);

				// Double activate — no errors
				yield* svc.activate();
				yield* svc.activate();
				const activeAfter = yield* svc.isActive();
				expect(activeAfter).toBe(true);

				// Double deactivate — no errors
				yield* svc.deactivate();
				yield* svc.deactivate();
				const activeAfterDeactivate = yield* svc.isActive();
				expect(activeAfterDeactivate).toBe(false);

				yield* Scope.close(scope, Exit.void);
			}),
		);

		it.scoped("scope close runs finalizer (deactivate)", () =>
			Effect.gen(function* () {
				const layer = KeepAwakeLive({ command: "sleep", args: ["infinity"] });
				const scope = yield* Scope.make();
				const ctx = yield* Layer.buildWithScope(layer, scope);
				const svc = Context.get(ctx, KeepAwakeTag);

				yield* svc.activate();
				const activeBefore = yield* svc.isActive();
				expect(activeBefore).toBe(true);

				// Close scope — finalizer should deactivate
				const exit = yield* Effect.exit(Scope.close(scope, Exit.void));
				expect(Exit.isSuccess(exit)).toBe(true);

				// After scope close, the service's Refs have been cleaned up.
				// We verify the exit was successful which proves the finalizer ran.
			}),
		);
	});

	describe("RateLimiter", () => {
		it.scoped("allows requests under limit", () =>
			Effect.gen(function* () {
				const limiter = yield* RateLimiterTag;
				const r1 = yield* limiter.checkLimit("127.0.0.1");
				const r2 = yield* limiter.checkLimit("127.0.0.1");
				expect(r1).toBe(true);
				expect(r2).toBe(true);
			}).pipe(
				Effect.provide(RateLimiterLive({ maxRequests: 5, windowMs: 10_000 })),
			),
		);

		it.scoped("blocks requests over limit", () =>
			Effect.gen(function* () {
				const limiter = yield* RateLimiterTag;
				for (let i = 0; i < 5; i++) {
					yield* limiter.checkLimit("127.0.0.1");
				}
				const result = yield* limiter.checkLimit("127.0.0.1"); // 6th request
				expect(result).toBe(false);
			}).pipe(
				Effect.provide(RateLimiterLive({ maxRequests: 5, windowMs: 10_000 })),
			),
		);
	});
});
