import { describe, expect, it, vi } from "vitest";
import { PermissionBridge } from "../../../src/lib/bridges/permission-bridge.js";
import { RelayTimers } from "../../../src/lib/relay/relay-timers.js";

function setup() {
	const permissionBridge = new PermissionBridge();
	const onTimeout = vi.fn();
	return { permissionBridge, onTimeout };
}

describe("RelayTimers", () => {
	it("creates tracked intervals on start()", async () => {
		vi.useFakeTimers();
		try {
			const { permissionBridge, onTimeout } = setup();
			const checkTimeoutsSpy = vi
				.spyOn(permissionBridge, "checkTimeouts")
				.mockReturnValue([]);

			const timers = new RelayTimers(permissionBridge, onTimeout);
			timers.start();

			// Before any tick, nothing called
			expect(checkTimeoutsSpy).not.toHaveBeenCalled();

			// Advance 30s — permission timeout fires
			vi.advanceTimersByTime(30_000);
			expect(checkTimeoutsSpy).toHaveBeenCalledTimes(1);

			// Advance another 30s (total 60s) — fires again
			vi.advanceTimersByTime(30_000);
			expect(checkTimeoutsSpy).toHaveBeenCalledTimes(2);

			await timers.drain();
		} finally {
			vi.useRealTimers();
		}
	});

	it("drain clears intervals (no more callbacks after drain)", async () => {
		vi.useFakeTimers();
		try {
			const { permissionBridge, onTimeout } = setup();
			const checkTimeoutsSpy = vi
				.spyOn(permissionBridge, "checkTimeouts")
				.mockReturnValue([]);

			const timers = new RelayTimers(permissionBridge, onTimeout);
			timers.start();

			// Let one tick fire
			vi.advanceTimersByTime(30_000);
			expect(checkTimeoutsSpy).toHaveBeenCalledTimes(1);

			await timers.drain();

			// Advance well past the interval — nothing should fire
			vi.advanceTimersByTime(120_000);
			expect(checkTimeoutsSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("calls onPermissionTimeout for each timed-out permission", async () => {
		vi.useFakeTimers();
		try {
			const { permissionBridge, onTimeout } = setup();
			vi.spyOn(permissionBridge, "checkTimeouts").mockReturnValue([
				{ id: "perm-1", sessionId: "s1" },
				{ id: "perm-2", sessionId: "s1" },
			]);

			const timers = new RelayTimers(permissionBridge, onTimeout);
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
			const { permissionBridge, onTimeout } = setup();
			vi.spyOn(permissionBridge, "checkTimeouts").mockReturnValue([]);

			const timers = new RelayTimers(permissionBridge, onTimeout);
			timers.start();

			vi.advanceTimersByTime(30_000);

			expect(onTimeout).not.toHaveBeenCalled();

			await timers.drain();
		} finally {
			vi.useRealTimers();
		}
	});
});
