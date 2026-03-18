// ─── Svelte Format Utilities — Unit Tests ────────────────────────────────────
// Tests escapeHtml, formatFileSize, formatTimeAgo, truncateTitle, generateUuid.

import { describe, expect, test } from "vitest";
import {
	escapeHtml,
	formatFileSize,
	formatTimeAgo,
	generateUuid,
	truncateTitle,
} from "../../../src/lib/frontend/utils/format.js";

// ─── escapeHtml ──────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
	test("escapes ampersands", () => {
		expect(escapeHtml("a & b")).toBe("a &amp; b");
	});

	test("escapes less-than signs", () => {
		expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
	});

	test("escapes greater-than signs", () => {
		expect(escapeHtml("a > b")).toBe("a &gt; b");
	});

	test("escapes double quotes", () => {
		expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
	});

	test("escapes all entities in a single string", () => {
		expect(escapeHtml('<div class="x">&</div>')).toBe(
			"&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;",
		);
	});

	test("returns empty string unchanged", () => {
		expect(escapeHtml("")).toBe("");
	});

	test("returns plain text unchanged", () => {
		expect(escapeHtml("hello world")).toBe("hello world");
	});

	test("handles multiple consecutive special characters", () => {
		expect(escapeHtml("<<>>&&")).toBe("&lt;&lt;&gt;&gt;&amp;&amp;");
	});

	test("does not escape single quotes", () => {
		expect(escapeHtml("it's fine")).toBe("it's fine");
	});
});

// ─── formatFileSize ──────────────────────────────────────────────────────────

describe("formatFileSize", () => {
	test("formats 0 bytes", () => {
		expect(formatFileSize(0)).toBe("0 B");
	});

	test("formats bytes (< 1 KB)", () => {
		expect(formatFileSize(512)).toBe("512 B");
	});

	test("formats exactly 1 byte", () => {
		expect(formatFileSize(1)).toBe("1 B");
	});

	test("formats kilobytes", () => {
		expect(formatFileSize(1024)).toBe("1.0 KB");
	});

	test("formats kilobytes with decimal", () => {
		expect(formatFileSize(1536)).toBe("1.5 KB");
	});

	test("formats megabytes", () => {
		expect(formatFileSize(1048576)).toBe("1.0 MB");
	});

	test("formats megabytes with decimal", () => {
		expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
	});

	test("formats gigabytes", () => {
		expect(formatFileSize(1073741824)).toBe("1.0 GB");
	});

	test("formats terabytes", () => {
		expect(formatFileSize(1099511627776)).toBe("1.0 TB");
	});

	test("formats large byte counts correctly", () => {
		// 500 bytes should show without decimal
		expect(formatFileSize(500)).toBe("500 B");
	});
});

// ─── formatTimeAgo ───────────────────────────────────────────────────────────

describe("formatTimeAgo", () => {
	const now = new Date("2026-02-25T12:00:00Z");

	test("returns empty string for undefined timestamp", () => {
		expect(formatTimeAgo(undefined, now)).toBe("");
	});

	test("returns 'just now' for < 60 seconds ago", () => {
		const ts = new Date("2026-02-25T11:59:30Z").toISOString();
		expect(formatTimeAgo(ts, now)).toBe("just now");
	});

	test("returns 'just now' for exactly 0 seconds ago", () => {
		expect(formatTimeAgo(now.toISOString(), now)).toBe("just now");
	});

	test("returns minutes ago", () => {
		const ts = new Date("2026-02-25T11:55:00Z").toISOString();
		expect(formatTimeAgo(ts, now)).toBe("5m ago");
	});

	test("returns 1m ago at exactly 60 seconds", () => {
		const ts = new Date("2026-02-25T11:59:00Z").toISOString();
		expect(formatTimeAgo(ts, now)).toBe("1m ago");
	});

	test("returns hours ago", () => {
		const ts = new Date("2026-02-25T09:00:00Z").toISOString();
		expect(formatTimeAgo(ts, now)).toBe("3h ago");
	});

	test("returns 1h ago at exactly 60 minutes", () => {
		const ts = new Date("2026-02-25T11:00:00Z").toISOString();
		expect(formatTimeAgo(ts, now)).toBe("1h ago");
	});

	test("returns 'Yesterday' for exactly 1 day ago", () => {
		const ts = new Date("2026-02-24T12:00:00Z").toISOString();
		expect(formatTimeAgo(ts, now)).toBe("Yesterday");
	});

	test("returns days ago for 2-29 days", () => {
		const ts = new Date("2026-02-20T12:00:00Z").toISOString();
		expect(formatTimeAgo(ts, now)).toBe("5d ago");
	});

	test("returns locale date for >= 30 days", () => {
		const ts = new Date("2026-01-01T12:00:00Z").toISOString();
		const result = formatTimeAgo(ts, now);
		// Should be a locale date string, not a relative time
		expect(result).not.toMatch(/ago$/);
		expect(result).not.toBe("just now");
		expect(result).not.toBe("Yesterday");
	});

	test("accepts numeric timestamp (epoch ms)", () => {
		const tsMs = new Date("2026-02-25T11:50:00Z").getTime();
		expect(formatTimeAgo(tsMs, now)).toBe("10m ago");
	});

	test("accepts string timestamp", () => {
		expect(formatTimeAgo("2026-02-25T11:50:00Z", now)).toBe("10m ago");
	});

	test("uses current time when now is not provided", () => {
		// Recent timestamp should be "just now"
		const result = formatTimeAgo(new Date().toISOString());
		expect(result).toBe("just now");
	});
});

// ─── truncateTitle ───────────────────────────────────────────────────────────

describe("truncateTitle", () => {
	test("returns short titles unchanged", () => {
		expect(truncateTitle("Hello")).toBe("Hello");
	});

	test("returns title at exactly maxLen unchanged", () => {
		const title = "a".repeat(40);
		expect(truncateTitle(title)).toBe(title);
	});

	test("truncates title longer than default maxLen (40)", () => {
		const title = "a".repeat(50);
		const result = truncateTitle(title);
		expect(result).toHaveLength(40);
		expect(result.endsWith("…")).toBe(true);
		expect(result).toBe(`${"a".repeat(39)}…`);
	});

	test("uses custom maxLen", () => {
		const result = truncateTitle("abcdefghij", 5);
		expect(result).toBe("abcd…");
		expect(result).toHaveLength(5);
	});

	test("returns empty string unchanged", () => {
		expect(truncateTitle("")).toBe("");
	});

	test("handles maxLen of 1", () => {
		const result = truncateTitle("hello", 1);
		expect(result).toBe("…");
	});

	test("handles single character title", () => {
		expect(truncateTitle("x", 40)).toBe("x");
	});
});

// ─── generateUuid ────────────────────────────────────────────────────────────

describe("generateUuid", () => {
	test("returns a non-empty string", () => {
		const id = generateUuid();
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
	});

	test("returns unique values on successive calls", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(generateUuid());
		}
		expect(ids.size).toBe(100);
	});

	test("uses crypto.randomUUID when available", () => {
		// In Node.js test environment, crypto.randomUUID is available
		const id = generateUuid();
		// UUID v4 format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
});
