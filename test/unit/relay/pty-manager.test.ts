import { describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	PtyManager,
	type PtyUpstream,
} from "../../../src/lib/relay/pty-manager.js";

function createMockUpstream(
	overrides?: Partial<{ readyState: number }>,
): PtyUpstream {
	return {
		readyState: overrides?.readyState ?? 1,
		send: vi.fn(),
		close: vi.fn(),
		terminate: vi.fn(),
	};
}

describe("PtyManager", () => {
	it("starts with no sessions", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		expect(mgr.sessionCount).toBe(0);
		expect(mgr.listSessions()).toEqual([]);
	});

	it("tracks a registered session", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		const mockUpstream = createMockUpstream();
		mgr.registerSession("pty-1", mockUpstream);
		expect(mgr.sessionCount).toBe(1);
		expect(mgr.hasSession("pty-1")).toBe(true);
	});

	it("getSession returns the session state", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		const mockUpstream = createMockUpstream();
		mgr.registerSession("pty-1", mockUpstream);
		const session = mgr.getSession("pty-1");
		expect(session).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(session!.exited).toBe(false);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(session!.exitCode).toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(session!.scrollback).toEqual([]);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(session!.scrollbackSize).toBe(0);
	});

	it("getSession returns undefined for unknown ptyId", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		expect(mgr.getSession("nonexistent")).toBeUndefined();
	});

	it("listSessions returns running and exited sessions", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		mgr.registerSession("pty-1", createMockUpstream());
		mgr.registerSession("pty-2", createMockUpstream());
		mgr.markExited("pty-2", 0);
		const list = mgr.listSessions();
		expect(list).toEqual([
			{ id: "pty-1", status: "running" },
			{ id: "pty-2", status: "exited" },
		]);
	});

	it("closeSession removes and closes (readyState OPEN)", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		const mockUpstream = createMockUpstream({ readyState: 1 });
		mgr.registerSession("pty-1", mockUpstream);
		mgr.closeSession("pty-1");
		expect(mgr.sessionCount).toBe(0);
		expect(mgr.hasSession("pty-1")).toBe(false);
		expect(mockUpstream.close).toHaveBeenCalledWith(1000, "Proxy closed");
		expect(mockUpstream.terminate).not.toHaveBeenCalled();
	});

	it("closeSession terminates when readyState is not OPEN", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		const mockUpstream = createMockUpstream({ readyState: 3 }); // CLOSED
		mgr.registerSession("pty-1", mockUpstream);
		mgr.closeSession("pty-1");
		expect(mgr.sessionCount).toBe(0);
		expect(mockUpstream.terminate).toHaveBeenCalled();
		expect(mockUpstream.close).not.toHaveBeenCalled();
	});

	it("closeSession is a no-op for unknown ptyId", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		// Should not throw
		mgr.closeSession("nonexistent");
	});

	it("closeAll cleans up all sessions", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		const up1 = createMockUpstream();
		const up2 = createMockUpstream();
		mgr.registerSession("pty-1", up1);
		mgr.registerSession("pty-2", up2);
		mgr.closeAll();
		expect(mgr.sessionCount).toBe(0);
		expect(up1.close).toHaveBeenCalled();
		expect(up2.close).toHaveBeenCalled();
	});

	it("sendInput forwards to upstream if open", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		const mockUpstream = createMockUpstream({ readyState: 1 });
		mgr.registerSession("pty-1", mockUpstream);
		mgr.sendInput("pty-1", "ls\n");
		expect(mockUpstream.send).toHaveBeenCalledWith("ls\n");
	});

	it("sendInput does not forward when readyState is not OPEN", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		const mockUpstream = createMockUpstream({ readyState: 3 });
		mgr.registerSession("pty-1", mockUpstream);
		mgr.sendInput("pty-1", "ls\n");
		expect(mockUpstream.send).not.toHaveBeenCalled();
	});

	it("sendInput does nothing for unknown pty", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		// Should not throw
		mgr.sendInput("nonexistent", "ls\n");
	});

	it("appendScrollback records data", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		mgr.registerSession("pty-1", createMockUpstream());
		mgr.appendScrollback("pty-1", "hello ");
		mgr.appendScrollback("pty-1", "world");
		expect(mgr.getScrollback("pty-1")).toBe("hello world");
	});

	it("appendScrollback caps at scrollbackMax", () => {
		const mgr = new PtyManager({
			log: createSilentLogger(),
			scrollbackMax: 100,
		});
		mgr.registerSession("pty-1", createMockUpstream());
		mgr.appendScrollback("pty-1", "a".repeat(60));
		mgr.appendScrollback("pty-1", "b".repeat(60));
		const replay = mgr.getScrollback("pty-1");
		expect(replay.length).toBeLessThanOrEqual(100);
		// The first chunk should have been evicted
		expect(replay).toBe("b".repeat(60));
	});

	it("appendScrollback is a no-op for unknown pty", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		// Should not throw
		mgr.appendScrollback("nonexistent", "data");
	});

	it("getScrollback returns empty string for unknown pty", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		expect(mgr.getScrollback("nonexistent")).toBe("");
	});

	it("getScrollback returns empty string for pty with no scrollback", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		mgr.registerSession("pty-1", createMockUpstream());
		expect(mgr.getScrollback("pty-1")).toBe("");
	});

	it("markExited sets exited flag and exit code", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		mgr.registerSession("pty-1", createMockUpstream());
		mgr.markExited("pty-1", 42);
		const session = mgr.getSession("pty-1");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(session!.exited).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(session!.exitCode).toBe(42);
	});

	it("markExited is a no-op for unknown pty", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		// Should not throw
		mgr.markExited("nonexistent", 1);
	});

	it("uses default scrollbackMax when not specified", () => {
		const mgr = new PtyManager({ log: createSilentLogger() });
		mgr.registerSession("pty-1", createMockUpstream());
		// Default is 50KB — write 60KB and verify it caps
		const chunk = "x".repeat(30 * 1024);
		mgr.appendScrollback("pty-1", chunk);
		mgr.appendScrollback("pty-1", chunk);
		const replay = mgr.getScrollback("pty-1");
		// Should have evicted the first chunk (total would be 60KB > 50KB)
		expect(replay.length).toBeLessThanOrEqual(50 * 1024);
	});
});
