// ─── Recent Projects — Regression Tests ──────────────────────────────────────
// Tests for isValidProjectPath, deserializeRecent path validation, and
// filterExistingProjects. These would fail before the commit that added
// path validation and the filterExistingProjects function.

import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	deserializeRecent,
	filterExistingProjects,
	isValidProjectPath,
} from "../../../src/lib/daemon/recent-projects.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn() };
});

const mockedExistsSync = vi.mocked(existsSync);

afterEach(() => {
	vi.restoreAllMocks();
});

// ─── isValidProjectPath ──────────────────────────────────────────────────────

describe("isValidProjectPath", () => {
	it("returns true for absolute path", () => {
		expect(isValidProjectPath("/home/user/project")).toBe(true);
	});

	it("returns false for empty string", () => {
		expect(isValidProjectPath("")).toBe(false);
	});

	it("returns false for relative path", () => {
		expect(isValidProjectPath("relative/path")).toBe(false);
	});

	it("returns false for path with null byte", () => {
		expect(isValidProjectPath("/path/\x00bad")).toBe(false);
	});

	it("returns false for path with tab", () => {
		expect(isValidProjectPath("/path/\ttab")).toBe(false);
	});

	it("returns false for path with newline", () => {
		expect(isValidProjectPath("/path/\nnewline")).toBe(false);
	});

	it("returns true for path with spaces", () => {
		expect(isValidProjectPath("/home/my project")).toBe(true);
	});
});

// ─── deserializeRecent — path validation ─────────────────────────────────────

describe("deserializeRecent — path validation", () => {
	it("rejects entries with empty directory", () => {
		const json = JSON.stringify({
			recentProjects: [{ directory: "", slug: "s", lastUsed: 1 }],
		});
		expect(deserializeRecent(json)).toEqual([]);
	});

	it("rejects entries with relative directory", () => {
		const json = JSON.stringify({
			recentProjects: [{ directory: "rel/path", slug: "s", lastUsed: 1 }],
		});
		expect(deserializeRecent(json)).toEqual([]);
	});

	it("rejects entries with control characters in directory", () => {
		const json = JSON.stringify({
			recentProjects: [{ directory: "/home/\x01bad", slug: "s", lastUsed: 1 }],
		});
		expect(deserializeRecent(json)).toEqual([]);
	});

	it("accepts valid absolute paths", () => {
		const json = JSON.stringify({
			recentProjects: [
				{ directory: "/home/user/proj", slug: "proj", lastUsed: 100 },
			],
		});
		const result = deserializeRecent(json);
		expect(result).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result[0]!.directory).toBe("/home/user/proj");
	});
});

// ─── filterExistingProjects ──────────────────────────────────────────────────

describe("filterExistingProjects", () => {
	it("returns only projects whose directories exist", () => {
		mockedExistsSync.mockImplementation((p) => String(p) === "/existing");

		const projects = [
			{ directory: "/existing", slug: "a", lastUsed: 1 },
			{ directory: "/missing", slug: "b", lastUsed: 2 },
		];
		const result = filterExistingProjects(projects);
		expect(result).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result[0]!.slug).toBe("a");
	});

	it("returns empty array when no directories exist", () => {
		mockedExistsSync.mockReturnValue(false);

		const projects = [
			{ directory: "/gone1", slug: "a", lastUsed: 1 },
			{ directory: "/gone2", slug: "b", lastUsed: 2 },
		];
		expect(filterExistingProjects(projects)).toEqual([]);
	});

	it("handles existsSync throwing an error gracefully", () => {
		mockedExistsSync.mockImplementation(() => {
			throw new Error("permission denied");
		});

		const projects = [{ directory: "/error", slug: "a", lastUsed: 1 }];
		expect(filterExistingProjects(projects)).toEqual([]);
	});
});
