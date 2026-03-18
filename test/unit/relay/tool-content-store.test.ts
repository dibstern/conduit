// ─── ToolContentStore Unit Tests ─────────────────────────────────────────────
// Tests for in-memory store of full tool result content (pre-truncation).
// Verifies: store/retrieve, unknown ID, clearSession, eviction, size.

import { describe, expect, it } from "vitest";
import { ToolContentStore } from "../../../src/lib/relay/tool-content-store.js";

// ─── Store / Retrieve ───────────────────────────────────────────────────────

describe("store and retrieve", () => {
	it("stores and retrieves content by tool ID", () => {
		const store = new ToolContentStore();
		store.store("tool-1", "some content");
		expect(store.get("tool-1")).toBe("some content");
	});

	it("stores multiple entries independently", () => {
		const store = new ToolContentStore();
		store.store("tool-1", "content A");
		store.store("tool-2", "content B");
		expect(store.get("tool-1")).toBe("content A");
		expect(store.get("tool-2")).toBe("content B");
	});

	it("overwrites content for the same tool ID", () => {
		const store = new ToolContentStore();
		store.store("tool-1", "original");
		store.store("tool-1", "updated");
		expect(store.get("tool-1")).toBe("updated");
	});

	it("stores content with optional sessionId", () => {
		const store = new ToolContentStore();
		store.store("tool-1", "session content", "session-abc");
		expect(store.get("tool-1")).toBe("session content");
	});
});

// ─── Unknown ID ─────────────────────────────────────────────────────────────

describe("unknown ID", () => {
	it("returns undefined for unknown tool ID", () => {
		const store = new ToolContentStore();
		expect(store.get("nonexistent")).toBeUndefined();
	});

	it("returns undefined after clearing a session that contained the ID", () => {
		const store = new ToolContentStore();
		store.store("tool-1", "content", "session-1");
		store.clearSession("session-1");
		expect(store.get("tool-1")).toBeUndefined();
	});
});

// ─── clearSession ───────────────────────────────────────────────────────────

describe("clearSession", () => {
	it("removes all entries for a given session", () => {
		const store = new ToolContentStore();
		store.store("tool-1", "a", "session-1");
		store.store("tool-2", "b", "session-1");
		store.store("tool-3", "c", "session-2");

		store.clearSession("session-1");

		expect(store.get("tool-1")).toBeUndefined();
		expect(store.get("tool-2")).toBeUndefined();
		expect(store.get("tool-3")).toBe("c");
	});

	it("does not throw when clearing a nonexistent session", () => {
		const store = new ToolContentStore();
		expect(() => store.clearSession("nonexistent")).not.toThrow();
	});

	it("updates size after clearing session", () => {
		const store = new ToolContentStore();
		store.store("tool-1", "a", "session-1");
		store.store("tool-2", "b", "session-1");
		expect(store.size).toBe(2);

		store.clearSession("session-1");
		expect(store.size).toBe(0);
	});

	it("entries without sessionId are not affected by clearSession", () => {
		const store = new ToolContentStore();
		store.store("tool-no-session", "content");
		store.store("tool-with-session", "content", "session-1");

		store.clearSession("session-1");

		expect(store.get("tool-no-session")).toBe("content");
		expect(store.get("tool-with-session")).toBeUndefined();
	});
});

// ─── Eviction ───────────────────────────────────────────────────────────────

describe("eviction when over capacity", () => {
	it("evicts oldest entry when exceeding maxEntries", () => {
		const store = new ToolContentStore(3);

		store.store("tool-1", "first");
		store.store("tool-2", "second");
		store.store("tool-3", "third");
		// At capacity — all should still be present
		expect(store.size).toBe(3);
		expect(store.get("tool-1")).toBe("first");

		// Adding a 4th should evict the oldest (tool-1)
		store.store("tool-4", "fourth");
		expect(store.size).toBe(3);
		expect(store.get("tool-1")).toBeUndefined();
		expect(store.get("tool-2")).toBe("second");
		expect(store.get("tool-3")).toBe("third");
		expect(store.get("tool-4")).toBe("fourth");
	});

	it("evicts multiple entries when needed (maxEntries = 1)", () => {
		const store = new ToolContentStore(1);

		store.store("tool-1", "a");
		expect(store.size).toBe(1);

		store.store("tool-2", "b");
		expect(store.size).toBe(1);
		expect(store.get("tool-1")).toBeUndefined();
		expect(store.get("tool-2")).toBe("b");
	});

	it("uses default maxEntries of 500", () => {
		const store = new ToolContentStore();
		// Store 501 entries
		for (let i = 0; i < 501; i++) {
			store.store(`tool-${i}`, `content-${i}`);
		}
		expect(store.size).toBe(500);
		// First entry should have been evicted
		expect(store.get("tool-0")).toBeUndefined();
		// Last entry should be present
		expect(store.get("tool-500")).toBe("content-500");
	});
});

// ─── Size ───────────────────────────────────────────────────────────────────

describe("size", () => {
	it("reports 0 for empty store", () => {
		const store = new ToolContentStore();
		expect(store.size).toBe(0);
	});

	it("reports correct count after stores", () => {
		const store = new ToolContentStore();
		store.store("a", "1");
		expect(store.size).toBe(1);
		store.store("b", "2");
		expect(store.size).toBe(2);
	});

	it("does not double-count overwrites", () => {
		const store = new ToolContentStore();
		store.store("a", "1");
		store.store("a", "2");
		expect(store.size).toBe(1);
	});
});
