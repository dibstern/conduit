// ─── Unit Tests: SessionRegistry ──────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../../../src/lib/session/session-registry.js";

describe("SessionRegistry", () => {
	it("tracks client-session associations", () => {
		const reg = new SessionRegistry();
		reg.setClientSession("c1", "s1");
		expect(reg.getClientSession("c1")).toBe("s1");
	});

	it("returns viewers for a session", () => {
		const reg = new SessionRegistry();
		reg.setClientSession("c1", "s1");
		reg.setClientSession("c2", "s1");
		reg.setClientSession("c3", "s2");
		expect(reg.getViewers("s1").sort()).toEqual(["c1", "c2"]);
		expect(reg.getViewers("s2")).toEqual(["c3"]);
	});

	it("returns viewer count", () => {
		const reg = new SessionRegistry();
		reg.setClientSession("c1", "s1");
		reg.setClientSession("c2", "s1");
		expect(reg.getViewerCount("s1")).toBe(2);
		expect(reg.getViewerCount("s2")).toBe(0);
	});

	it("hasViewers returns true/false correctly", () => {
		const reg = new SessionRegistry();
		expect(reg.hasViewers("s1")).toBe(false);
		reg.setClientSession("c1", "s1");
		expect(reg.hasViewers("s1")).toBe(true);
	});

	it("handles session switch: removes from old, adds to new", () => {
		const reg = new SessionRegistry();
		reg.setClientSession("c1", "s1");
		expect(reg.getViewerCount("s1")).toBe(1);

		reg.setClientSession("c1", "s2");
		expect(reg.getViewerCount("s1")).toBe(0);
		expect(reg.getViewerCount("s2")).toBe(1);
	});

	it("removeClient cleans up", () => {
		const reg = new SessionRegistry();
		reg.setClientSession("c1", "s1");
		const sessionId = reg.removeClient("c1");
		expect(sessionId).toBe("s1");
		expect(reg.getViewerCount("s1")).toBe(0);
		expect(reg.getClientSession("c1")).toBeUndefined();
	});

	it("removeClient returns undefined for unknown client", () => {
		const reg = new SessionRegistry();
		expect(reg.removeClient("c999")).toBeUndefined();
	});

	it("clear removes all state", () => {
		const reg = new SessionRegistry();
		reg.setClientSession("c1", "s1");
		reg.setClientSession("c2", "s2");
		reg.clear();
		expect(reg.getClientSession("c1")).toBeUndefined();
		expect(reg.getViewerCount("s1")).toBe(0);
	});

	it("setClientSession is no-op when same session", () => {
		const reg = new SessionRegistry();
		reg.setClientSession("c1", "s1");
		reg.setClientSession("c1", "s1"); // no-op
		expect(reg.getViewerCount("s1")).toBe(1);
	});

	it("getViewers returns empty array for unknown session", () => {
		const reg = new SessionRegistry();
		expect(reg.getViewers("unknown")).toEqual([]);
	});

	it("multiple clients can view different sessions independently", () => {
		const reg = new SessionRegistry();
		reg.setClientSession("c1", "s1");
		reg.setClientSession("c2", "s2");
		reg.setClientSession("c3", "s1");
		reg.setClientSession("c4", "s3");

		expect(reg.getViewerCount("s1")).toBe(2);
		expect(reg.getViewerCount("s2")).toBe(1);
		expect(reg.getViewerCount("s3")).toBe(1);

		// Remove one client from s1
		reg.removeClient("c3");
		expect(reg.getViewerCount("s1")).toBe(1);
		expect(reg.hasViewers("s1")).toBe(true);

		// Remove last client from s1
		reg.removeClient("c1");
		expect(reg.getViewerCount("s1")).toBe(0);
		expect(reg.hasViewers("s1")).toBe(false);
	});

	it("switching sessions updates both old and new counts", () => {
		const reg = new SessionRegistry();
		reg.setClientSession("c1", "s1");
		reg.setClientSession("c2", "s1");

		// c1 switches from s1 to s2
		reg.setClientSession("c1", "s2");
		expect(reg.getViewerCount("s1")).toBe(1);
		expect(reg.getViewerCount("s2")).toBe(1);
		expect(reg.getViewers("s1")).toEqual(["c2"]);
		expect(reg.getViewers("s2")).toEqual(["c1"]);
	});
});
