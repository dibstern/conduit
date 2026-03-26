// ─── MessageCache Unit Tests ─────────────────────────────────────────────────
// Tests for the per-session file-backed event cache.
// Verifies: record/serve roundtrip, JSONL persistence, fallback chain,
// loadFromDisk recovery, session isolation, and deletion.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageCache } from "../../../src/lib/relay/message-cache.js";
import type { RelayMessage } from "../../../src/lib/types.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

let testDir: string;

function createTestDir(): string {
	const dir = join(
		tmpdir(),
		`message-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

beforeEach(() => {
	testDir = createTestDir();
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// Best effort cleanup
	}
});

// ─── recordEvent + getEvents roundtrip ──────────────────────────────────────

describe("recordEvent + getEvents", () => {
	it("returns events after recording them", async () => {
		const cache = new MessageCache(testDir);

		const event1: RelayMessage = { type: "delta", text: "hello " };
		const event2: RelayMessage = { type: "delta", text: "world" };
		const event3: RelayMessage = { type: "done", code: 0 };

		cache.recordEvent("session-1", event1);
		cache.recordEvent("session-1", event2);
		cache.recordEvent("session-1", event3);

		const events = await cache.getEvents("session-1");
		expect(events).toHaveLength(3);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(events![0]).toEqual(event1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(events![1]).toEqual(event2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(events![2]).toEqual(event3);
	});

	it("returns null for unknown sessions", async () => {
		const cache = new MessageCache(testDir);
		expect(await cache.getEvents("nonexistent")).toBeNull();
	});

	it("records different event types correctly", async () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("s1", { type: "user_message", text: "hi" });
		cache.recordEvent("s1", { type: "delta", text: "response" });
		cache.recordEvent("s1", { type: "tool_start", id: "t1", name: "Read" });
		cache.recordEvent("s1", {
			type: "tool_executing",
			id: "t1",
			name: "Read",
			input: { path: "foo.ts" },
		});
		cache.recordEvent("s1", {
			type: "tool_result",
			id: "t1",
			content: "file contents",
			is_error: false,
		});
		cache.recordEvent("s1", { type: "thinking_start" });
		cache.recordEvent("s1", { type: "thinking_delta", text: "let me think" });
		cache.recordEvent("s1", { type: "thinking_stop" });
		cache.recordEvent("s1", {
			type: "result",
			usage: { input: 100, output: 50, cache_read: 0, cache_creation: 0 },
			cost: 0.01,
			duration: 1000,
			sessionId: "s1",
		});
		cache.recordEvent("s1", { type: "done", code: 0 });

		const events = await cache.getEvents("s1");
		expect(events).toHaveLength(10);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(events!.map((e) => e.type)).toEqual([
			"user_message",
			"delta",
			"tool_start",
			"tool_executing",
			"tool_result",
			"thinking_start",
			"thinking_delta",
			"thinking_stop",
			"result",
			"done",
		]);
	});
});

// ─── JSONL file persistence ─────────────────────────────────────────────────

describe("JSONL file persistence", () => {
	it("writes events to a .jsonl file on disk", async () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("session-a", { type: "delta", text: "hello" });
		cache.recordEvent("session-a", { type: "done", code: 0 });
		await cache.flush();

		const filePath = join(testDir, "session-a.jsonl");
		expect(existsSync(filePath)).toBe(true);

		const content = readFileSync(filePath, "utf8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(JSON.parse(lines[0]!)).toEqual({ type: "delta", text: "hello" });
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(JSON.parse(lines[1]!)).toEqual({ type: "done", code: 0 });
	});

	it("appends each event as a new line (not rewriting)", async () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("s1", { type: "delta", text: "a" });
		await cache.flush();
		const contentAfterFirst = readFileSync(join(testDir, "s1.jsonl"), "utf8");
		expect(contentAfterFirst.trim().split("\n")).toHaveLength(1);

		cache.recordEvent("s1", { type: "delta", text: "b" });
		await cache.flush();
		const contentAfterSecond = readFileSync(join(testDir, "s1.jsonl"), "utf8");
		expect(contentAfterSecond.trim().split("\n")).toHaveLength(2);
	});
});

// ─── loadFromDisk ────────────────────────────────────────────────────────────

describe("loadFromDisk", () => {
	it("recovers events from JSONL files", async () => {
		// Manually write a JSONL file
		const filePath = join(testDir, "recovered-session.jsonl");
		const events = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "hi there" },
			{ type: "done", code: 0 },
		];
		writeFileSync(
			filePath,
			`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
		);

		// Create a NEW cache instance and load from disk
		const cache = new MessageCache(testDir);
		cache.loadFromDisk();

		const result = await cache.getEvents("recovered-session");
		expect(result).toHaveLength(3);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(result![0]).toEqual({ type: "user_message", text: "hello" });
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(result![2]).toEqual({ type: "done", code: 0 });
	});

	it("handles empty JSONL files gracefully", async () => {
		writeFileSync(join(testDir, "empty.jsonl"), "");

		const cache = new MessageCache(testDir);
		cache.loadFromDisk();

		expect(await cache.getEvents("empty")).toBeNull();
	});

	it("handles malformed lines gracefully (crash-safe)", async () => {
		const filePath = join(testDir, "partial.jsonl");
		writeFileSync(
			filePath,
			'{"type":"delta","text":"ok"}\n{"type":"done","code":0}\n{"incomplete json',
		);

		const cache = new MessageCache(testDir);
		cache.loadFromDisk();

		const events = await cache.getEvents("partial");
		// Should recover the two good lines, skip the malformed one
		expect(events).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(events![0]).toEqual({ type: "delta", text: "ok" });
	});

	it("loads multiple sessions from disk", async () => {
		writeFileSync(
			join(testDir, "s1.jsonl"),
			'{"type":"delta","text":"s1"}\n{"type":"done","code":0}\n',
		);
		writeFileSync(
			join(testDir, "s2.jsonl"),
			'{"type":"delta","text":"s2"}\n{"type":"done","code":0}\n',
		);

		const cache = new MessageCache(testDir);
		cache.loadFromDisk();

		expect(await cache.getEvents("s1")).toHaveLength(2);
		expect(await cache.getEvents("s2")).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect((await cache.getEvents("s1"))![0]).toEqual({
			type: "delta",
			text: "s1",
		});
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect((await cache.getEvents("s2"))![0]).toEqual({
			type: "delta",
			text: "s2",
		});
	});

	it("ignores non-.jsonl files", async () => {
		writeFileSync(join(testDir, "readme.txt"), "not a session");
		writeFileSync(join(testDir, "real.jsonl"), '{"type":"done","code":0}\n');

		const cache = new MessageCache(testDir);
		cache.loadFromDisk();

		expect(await cache.getEvents("real")).toHaveLength(1);
		expect(await cache.getEvents("readme")).toBeNull();
	});
});

// ─── Fallback chain ─────────────────────────────────────────────────────────

describe("fallback chain: memory → file → null", () => {
	it("serves from memory when available (no disk read)", async () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("s1", { type: "delta", text: "in memory" });
		const events = await cache.getEvents("s1");
		expect(events).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(events![0]).toEqual({ type: "delta", text: "in memory" });
	});

	it("falls back to file when memory is empty", async () => {
		// Write events to file
		writeFileSync(
			join(testDir, "file-only.jsonl"),
			'{"type":"delta","text":"from file"}\n',
		);

		// Create fresh cache (no loadFromDisk called — simulates memory miss)
		const cache = new MessageCache(testDir);
		// Memory is empty, but file exists
		const events = await cache.getEvents("file-only");
		expect(events).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(events![0]).toEqual({ type: "delta", text: "from file" });
	});

	it("returns null when neither memory nor file has data", async () => {
		const cache = new MessageCache(testDir);
		expect(await cache.getEvents("completely-unknown")).toBeNull();
	});

	it("populates memory from file on first access (subsequent reads from memory)", async () => {
		writeFileSync(
			join(testDir, "cached.jsonl"),
			'{"type":"delta","text":"loaded"}\n',
		);

		const cache = new MessageCache(testDir);
		// First call reads from file and caches in memory
		const first = await cache.getEvents("cached");
		expect(first).toHaveLength(1);

		// Verify it's now in memory via has()
		expect(cache.has("cached")).toBe(true);
	});
});

// ─── Session isolation ──────────────────────────────────────────────────────

describe("session isolation", () => {
	it("events are isolated between sessions", async () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("session-a", { type: "delta", text: "A" });
		cache.recordEvent("session-b", { type: "delta", text: "B" });

		expect(await cache.getEvents("session-a")).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect((await cache.getEvents("session-a"))![0]).toEqual({
			type: "delta",
			text: "A",
		});
		expect(await cache.getEvents("session-b")).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect((await cache.getEvents("session-b"))![0]).toEqual({
			type: "delta",
			text: "B",
		});
	});
});

// ─── remove ─────────────────────────────────────────────────────────────────

describe("remove", () => {
	it("clears memory and deletes file", async () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("to-delete", { type: "delta", text: "gone" });
		await cache.flush();
		expect(existsSync(join(testDir, "to-delete.jsonl"))).toBe(true);

		cache.remove("to-delete");
		await cache.flush();

		expect(await cache.getEvents("to-delete")).toBeNull();
		expect(existsSync(join(testDir, "to-delete.jsonl"))).toBe(false);
	});

	it("does not throw when removing nonexistent session", () => {
		const cache = new MessageCache(testDir);
		expect(() => cache.remove("nonexistent")).not.toThrow();
	});

	it("does not affect other sessions", async () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("keep", { type: "delta", text: "kept" });
		cache.recordEvent("delete", { type: "delta", text: "gone" });

		cache.remove("delete");
		await cache.flush();

		expect(await cache.getEvents("keep")).toHaveLength(1);
		expect(await cache.getEvents("delete")).toBeNull();
	});
});

// ─── has ─────────────────────────────────────────────────────────────────────

describe("has", () => {
	it("returns true for sessions with events in memory", () => {
		const cache = new MessageCache(testDir);
		cache.recordEvent("s1", { type: "delta", text: "a" });
		expect(cache.has("s1")).toBe(true);
	});

	it("returns false for sessions not in memory", () => {
		const cache = new MessageCache(testDir);
		expect(cache.has("nonexistent")).toBe(false);
	});
});

// ─── Error resilience (file write failure) ──────────────────────────────────

describe("error resilience", () => {
	it("recordEvent does not throw when file write fails, and event is still in memory", async () => {
		const cache = new MessageCache(testDir);

		// Make the cache directory read-only so file writes fail
		chmodSync(testDir, 0o444);

		const event: RelayMessage = { type: "delta", text: "despite failure" };

		// Should not throw even though file write will fail
		expect(() => cache.recordEvent("write-fail", event)).not.toThrow();

		// Restore permissions before assertions (so afterEach cleanup works)
		chmodSync(testDir, 0o755);

		// Event should still be in memory
		const events = await cache.getEvents("write-fail");
		expect(events).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(events![0]).toEqual(event);
	});
});

// ─── approximateBytes ───────────────────────────────────────────────────────

describe("approximateBytes", () => {
	it("returns 0 when empty", () => {
		const cache = new MessageCache(testDir);
		expect(cache.approximateBytes()).toBe(0);
	});

	it("increases when events are recorded", () => {
		const cache = new MessageCache(testDir);
		expect(cache.approximateBytes()).toBe(0);

		cache.recordEvent("s1", { type: "delta", text: "hello world" });
		const after1 = cache.approximateBytes();
		expect(after1).toBeGreaterThan(0);

		cache.recordEvent("s1", { type: "delta", text: "more text" });
		const after2 = cache.approximateBytes();
		expect(after2).toBeGreaterThan(after1);
	});

	it("tracks bytes across multiple sessions", () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("s1", { type: "delta", text: "session one" });
		const afterS1 = cache.approximateBytes();

		cache.recordEvent("s2", { type: "delta", text: "session two" });
		const afterS2 = cache.approximateBytes();

		expect(afterS2).toBeGreaterThan(afterS1);
	});

	it("decreases when a session is removed", () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("s1", { type: "delta", text: "session one" });
		cache.recordEvent("s2", { type: "delta", text: "session two" });
		const before = cache.approximateBytes();

		cache.remove("s1");
		const after = cache.approximateBytes();

		expect(after).toBeLessThan(before);
	});
});

// ─── evictOldestSession ─────────────────────────────────────────────────────

describe("evictOldestSession", () => {
	it("returns null when empty", () => {
		const cache = new MessageCache(testDir);
		expect(cache.evictOldestSession()).toBeNull();
	});

	it("removes the oldest-accessed session", async () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("s1", { type: "delta", text: "first" });
		cache.recordEvent("s2", { type: "delta", text: "second" });
		cache.recordEvent("s3", { type: "delta", text: "third" });

		const evicted = cache.evictOldestSession();
		expect(evicted).toBe("s1");
		expect(await cache.getEvents("s1")).toBeNull();
		expect(await cache.getEvents("s2")).not.toBeNull();
		expect(await cache.getEvents("s3")).not.toBeNull();
	});

	it("uses access time, not creation time", async () => {
		const cache = new MessageCache(testDir);

		// Create s1 first, then s2
		cache.recordEvent("s1", { type: "delta", text: "first" });
		// Small delay to ensure timestamps differ
		await new Promise((r) => setTimeout(r, 10));
		cache.recordEvent("s2", { type: "delta", text: "second" });

		// Access s1 again — updates its lastAccessedAt to be newer than s2
		await new Promise((r) => setTimeout(r, 10));
		cache.getEvents("s1");

		// Now s2 should be evicted (older access time) even though s1 was created first
		const evicted = cache.evictOldestSession();
		expect(evicted).toBe("s2");
		expect(await cache.getEvents("s1")).not.toBeNull();
		expect(await cache.getEvents("s2")).toBeNull();
	});

	it("reduces approximateBytes after eviction", () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("s1", { type: "delta", text: "data for s1" });
		cache.recordEvent("s2", { type: "delta", text: "data for s2" });
		const before = cache.approximateBytes();

		cache.evictOldestSession();
		const after = cache.approximateBytes();

		expect(after).toBeLessThan(before);
	});

	it("also removes the JSONL file from disk", async () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("s1", { type: "delta", text: "data" });
		await cache.flush();
		expect(existsSync(join(testDir, "s1.jsonl"))).toBe(true);

		cache.evictOldestSession();
		await cache.flush();
		expect(existsSync(join(testDir, "s1.jsonl"))).toBe(false);
	});

	it("recordEvent updates lastAccessedAt", async () => {
		const cache = new MessageCache(testDir);

		cache.recordEvent("s1", { type: "delta", text: "first" });
		await new Promise((r) => setTimeout(r, 10));
		cache.recordEvent("s2", { type: "delta", text: "second" });

		// s1 is older. Now record another event to s1 — should update its access time
		await new Promise((r) => setTimeout(r, 10));
		cache.recordEvent("s1", { type: "delta", text: "more for s1" });

		// s2 should now be oldest
		const evicted = cache.evictOldestSession();
		expect(evicted).toBe("s2");
	});
});

// ─── repairColdSessions ─────────────────────────────────────────────────────

describe("repairColdSessions", () => {
	it("truncates incomplete turn from loaded JSONL and rewrites file", async () => {
		// Simulate a JSONL file with an incomplete assistant turn
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
			{ type: "done", code: 0 },
			{ type: "user_message", text: "next" },
			{ type: "delta", text: "partial" }, // incomplete turn
		];
		const jsonlContent = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
		writeFileSync(join(testDir, "ses_test.jsonl"), jsonlContent);

		const cache = new MessageCache(testDir);
		await cache.loadFromDisk();
		await cache.repairColdSessions();

		// In-memory should be repaired
		const loaded = await cache.getEvents("ses_test");
		expect(loaded).toHaveLength(4); // incomplete delta removed
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(loaded![3]).toEqual({ type: "user_message", text: "next" });

		// JSONL file should be rewritten
		const fileContent = readFileSync(join(testDir, "ses_test.jsonl"), "utf8");
		const fileEvents = fileContent
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(fileEvents).toHaveLength(4);
	});

	it("does not rewrite JSONL for complete sessions", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "response" },
			{ type: "done", code: 0 },
		];
		const jsonlContent = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
		const filePath = join(testDir, "ses_complete.jsonl");
		writeFileSync(filePath, jsonlContent);
		const mtimeBefore = statSync(filePath).mtimeMs;

		const cache = new MessageCache(testDir);
		await cache.loadFromDisk();
		await cache.repairColdSessions();

		// File should not be touched
		const mtimeAfter = statSync(filePath).mtimeMs;
		expect(mtimeAfter).toBe(mtimeBefore);

		const loaded = await cache.getEvents("ses_complete");
		expect(loaded).toHaveLength(3);
	});

	it("repairs session with no terminal events to user_messages only", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
			{ type: "delta", text: "partial" },
		];
		const jsonlContent = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
		writeFileSync(join(testDir, "ses_no_terminal.jsonl"), jsonlContent);

		const cache = new MessageCache(testDir);
		await cache.loadFromDisk();
		await cache.repairColdSessions();

		// In-memory should be repaired
		const loaded = await cache.getEvents("ses_no_terminal");
		expect(loaded).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(loaded![0]).toEqual({ type: "user_message", text: "hello" });

		// JSONL file should be rewritten with only user_message
		const fileContent = readFileSync(
			join(testDir, "ses_no_terminal.jsonl"),
			"utf8",
		);
		const fileEvents = fileContent
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(fileEvents).toHaveLength(1);
		expect(fileEvents[0]).toEqual({ type: "user_message", text: "hello" });
	});
});
