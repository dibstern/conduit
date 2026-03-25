import { describe, expect, it, vi } from "vitest";
import { PermissionBridge } from "../../../src/lib/bridges/permission-bridge.js";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { RelayTimers } from "../../../src/lib/relay/relay-timers.js";
import { RateLimiter } from "../../../src/lib/server/rate-limiter.js";

function setup() {
	const registry = new ServiceRegistry();
	const permissionBridge = new PermissionBridge();
	const rateLimiter = new RateLimiter();
	const onTimeout = vi.fn();
	return { registry, permissionBridge, rateLimiter, onTimeout };
}

describe("RelayTimers", () => {
	it("registers with the ServiceRegistry on construction", () => {
		const { registry, permissionBridge, rateLimiter, onTimeout } = setup();
		const _timers = new RelayTimers(
			registry,
			permissionBridge,
			rateLimiter,
			onTimeout,
		);
		expect(registry.size).toBe(1);
	});

	it("creates tracked intervals on start()", async () => {
		vi.useFakeTimers();
		try {
			const { registry, permissionBridge, rateLimiter, onTimeout } = setup();
			const cleanupSpy = vi.spyOn(rateLimiter, "cleanup");
			const checkTimeoutsSpy = vi
				.spyOn(permissionBridge, "checkTimeouts")
				.mockReturnValue([]);

			const timers = new RelayTimers(
				registry,
				permissionBridge,
				rateLimiter,
				onTimeout,
			);
			timers.start();

			// Before any tick, nothing called
			expect(checkTimeoutsSpy).not.toHaveBeenCalled();
			expect(cleanupSpy).not.toHaveBeenCalled();

			// Advance 30s — permission timeout fires
			vi.advanceTimersByTime(30_000);
			expect(checkTimeoutsSpy).toHaveBeenCalledTimes(1);
			expect(cleanupSpy).not.toHaveBeenCalled();

			// Advance another 30s (total 60s) — both fire
			vi.advanceTimersByTime(30_000);
			expect(checkTimeoutsSpy).toHaveBeenCalledTimes(2);
			expect(cleanupSpy).toHaveBeenCalledTimes(1);

			await timers.drain();
		} finally {
			vi.useRealTimers();
		}
	});

	it("drain clears intervals (no more callbacks after drain)", async () => {
		vi.useFakeTimers();
		try {
			const { registry, permissionBridge, rateLimiter, onTimeout } = setup();
			const checkTimeoutsSpy = vi
				.spyOn(permissionBridge, "checkTimeouts")
				.mockReturnValue([]);
			const cleanupSpy = vi.spyOn(rateLimiter, "cleanup");

			const timers = new RelayTimers(
				registry,
				permissionBridge,
				rateLimiter,
				onTimeout,
			);
			timers.start();

			// Let one tick fire
			vi.advanceTimersByTime(30_000);
			expect(checkTimeoutsSpy).toHaveBeenCalledTimes(1);

			await timers.drain();

			// Advance well past both intervals — nothing should fire
			vi.advanceTimersByTime(120_000);
			expect(checkTimeoutsSpy).toHaveBeenCalledTimes(1);
			expect(cleanupSpy).toHaveBeenCalledTimes(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("drainAll on registry clears RelayTimers intervals", async () => {
		vi.useFakeTimers();
		try {
			const { registry, permissionBridge, rateLimiter, onTimeout } = setup();
			const checkTimeoutsSpy = vi
				.spyOn(permissionBridge, "checkTimeouts")
				.mockReturnValue([]);

			const timers = new RelayTimers(
				registry,
				permissionBridge,
				rateLimiter,
				onTimeout,
			);
			timers.start();

			vi.advanceTimersByTime(30_000);
			expect(checkTimeoutsSpy).toHaveBeenCalledTimes(1);

			await registry.drainAll();

			vi.advanceTimersByTime(60_000);
			// No more ticks after registry drain
			expect(checkTimeoutsSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("calls onPermissionTimeout for each timed-out permission", async () => {
		vi.useFakeTimers();
		try {
			const { registry, permissionBridge, rateLimiter, onTimeout } = setup();
			vi.spyOn(permissionBridge, "checkTimeouts").mockReturnValue([
				"perm-1",
				"perm-2",
			]);

			const timers = new RelayTimers(
				registry,
				permissionBridge,
				rateLimiter,
				onTimeout,
			);
			timers.start();

			vi.advanceTimersByTime(30_000);

			expect(onTimeout).toHaveBeenCalledTimes(2);
			expect(onTimeout).toHaveBeenCalledWith("perm-1");
			expect(onTimeout).toHaveBeenCalledWith("perm-2");

			await timers.drain();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not call onPermissionTimeout when no timeouts", async () => {
		vi.useFakeTimers();
		try {
			const { registry, permissionBridge, rateLimiter, onTimeout } = setup();
			vi.spyOn(permissionBridge, "checkTimeouts").mockReturnValue([]);

			const timers = new RelayTimers(
				registry,
				permissionBridge,
				rateLimiter,
				onTimeout,
			);
			timers.start();

			vi.advanceTimersByTime(30_000);

			expect(onTimeout).not.toHaveBeenCalled();

			await timers.drain();
		} finally {
			vi.useRealTimers();
		}
	});
});
