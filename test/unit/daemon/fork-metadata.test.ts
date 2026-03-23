import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadForkMetadata,
	saveForkMetadata,
} from "../../../src/lib/daemon/fork-metadata.js";

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "fork-meta-test-"));
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe("fork-metadata persistence", () => {
	it("returns empty map when file does not exist", () => {
		const meta = loadForkMetadata(testDir);
		expect(meta).toEqual(new Map());
	});

	it("saves and loads fork metadata", () => {
		const meta = new Map([
			["ses_1", "msg_a"],
			["ses_2", "msg_b"],
		]);
		saveForkMetadata(meta, testDir);
		const loaded = loadForkMetadata(testDir);
		expect(loaded).toEqual(meta);
	});

	it("saves atomically (tmp + rename)", () => {
		const meta = new Map([["ses_1", "msg_a"]]);
		saveForkMetadata(meta, testDir);
		expect(existsSync(join(testDir, ".fork-metadata.json.tmp"))).toBe(false);
		expect(existsSync(join(testDir, "fork-metadata.json"))).toBe(true);
	});

	it("returns empty map on corrupt file", () => {
		writeFileSync(join(testDir, "fork-metadata.json"), "not json", "utf-8");
		const meta = loadForkMetadata(testDir);
		expect(meta).toEqual(new Map());
	});
});
