// Tests: Config Persistence Module (Ticket 8.3)

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";

import {
	type CrashInfo,
	clearCrashInfo,
	clearDaemonConfig,
	type DaemonConfig,
	getConfigDir,
	loadDaemonConfig,
	readCrashInfo,
	saveDaemonConfig,
	syncRecentProjects,
	writeCrashInfo,
} from "../../../src/lib/daemon/config-persistence.js";
import { deserializeRecent } from "../../../src/lib/daemon/recent-projects.js";

let tempDir: string;

function makeSampleConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
	return {
		pid: 12345,
		port: 2633,
		pinHash: null,
		tls: false,
		debug: false,
		keepAwake: false,
		autoSettleAfterDays: 3,
		dangerouslySkipPermissions: false,
		projects: [],
		...overrides,
	};
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "config-persist-test-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("getConfigDir", () => {
	it("returns a path ending in conduit", () => {
		const dir = getConfigDir();
		expect(dir).toMatch(/conduit$/);
	});
});

describe("loadDaemonConfig", () => {
	it("defaults legacy configs to three days and preserves Never", async () => {
		const legacy = makeSampleConfig();
		delete legacy.autoSettleAfterDays;
		await saveDaemonConfig(legacy, tempDir);
		expect(loadDaemonConfig(tempDir)?.autoSettleAfterDays).toBe(3);
		await saveDaemonConfig(
			makeSampleConfig({ autoSettleAfterDays: null }),
			tempDir,
		);
		expect(loadDaemonConfig(tempDir)?.autoSettleAfterDays).toBeNull();
	});

	it("round-trips a configured idle window", async () => {
		await saveDaemonConfig(
			makeSampleConfig({ autoSettleAfterDays: 14 }),
			tempDir,
		);
		expect(loadDaemonConfig(tempDir)?.autoSettleAfterDays).toBe(14);
	});

	it.each([
		0, 91, 1.5,
	])("rejects out-of-range or fractional days %s", async (days) => {
		await saveDaemonConfig(
			makeSampleConfig({ autoSettleAfterDays: days }),
			tempDir,
		);
		expect(loadDaemonConfig(tempDir)).toBeNull();
	});
	it("returns parsed config from valid JSON file", () => {
		const config = makeSampleConfig({ pid: 99999, port: 3000 });
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "daemon.json"), JSON.stringify(config));

		const loaded = loadDaemonConfig(tempDir);
		expect(loaded).not.toBeNull();
		assert.exists(loaded, "expected daemon config");
		expect(loaded.pid).toBe(99999);
		expect(loaded.port).toBe(3000);
		expect(loaded.pinHash).toBeNull();
	});

	it("returns null when file doesn't exist", () => {
		const loaded = loadDaemonConfig(tempDir);
		expect(loaded).toBeNull();
	});

	it("returns null when file is corrupt JSON", () => {
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "daemon.json"), "{ not valid json !!!");

		const loaded = loadDaemonConfig(tempDir);
		expect(loaded).toBeNull();
	});

	it("handles missing configDir gracefully", () => {
		const nonExistentDir = join(tempDir, "does", "not", "exist");
		const loaded = loadDaemonConfig(nonExistentDir);
		expect(loaded).toBeNull();
	});
});

describe("saveDaemonConfig", () => {
	it("writes valid JSON that can be loaded back", async () => {
		const config = makeSampleConfig({ pid: 42, debug: true });
		await saveDaemonConfig(config, tempDir);

		const raw = readFileSync(join(tempDir, "daemon.json"), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.pid).toBe(42);
		expect(parsed.debug).toBe(true);
	});

	it("creates directory if it doesn't exist", async () => {
		const nestedDir = join(tempDir, "a", "b", "c");
		expect(existsSync(nestedDir)).toBe(false);

		await saveDaemonConfig(makeSampleConfig(), nestedDir);

		expect(existsSync(nestedDir)).toBe(true);
		expect(existsSync(join(nestedDir, "daemon.json"))).toBe(true);
	});

	it("atomic write: tmp file is cleaned up", async () => {
		await saveDaemonConfig(makeSampleConfig(), tempDir);

		// No tmp files should remain after a successful write
		const files = readdirSync(tempDir);
		const tmpFiles = files.filter((f: string) =>
			f.startsWith(".daemon.json.tmp"),
		);
		expect(tmpFiles).toHaveLength(0);
		// The final file should exist
		expect(existsSync(join(tempDir, "daemon.json"))).toBe(true);
	});

	it("round-trip: save then load returns same data", async () => {
		const config = makeSampleConfig({
			pid: 7777,
			port: 8080,
			pinHash: "abc123",
			tls: true,
			debug: true,
			keepAwake: true,
			dangerouslySkipPermissions: true,
			projects: [
				{
					path: "/home/user/project",
					slug: "project",
					title: "My Project",
					addedAt: 1000,
				},
			],
		});

		await saveDaemonConfig(config, tempDir);
		const loaded = loadDaemonConfig(tempDir);

		expect(loaded).toEqual(config);
	});
});

describe("clearDaemonConfig", () => {
	it("removes daemon.json, relay.sock, and daemon.pid", () => {
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "daemon.json"), "{}");
		writeFileSync(join(tempDir, "relay.sock"), "");
		writeFileSync(join(tempDir, "daemon.pid"), "12345");

		clearDaemonConfig(tempDir);

		expect(existsSync(join(tempDir, "daemon.json"))).toBe(false);
		expect(existsSync(join(tempDir, "relay.sock"))).toBe(false);
		expect(existsSync(join(tempDir, "daemon.pid"))).toBe(false);
	});

	it("handles already-missing files without error", () => {
		// tempDir exists but has none of the files — should not throw
		expect(() => clearDaemonConfig(tempDir)).not.toThrow();
	});
});

describe("CrashInfo", () => {
	it("writeCrashInfo + readCrashInfo round-trip", () => {
		const info: CrashInfo = { reason: "SIGTERM", timestamp: 1700000000000 };
		writeCrashInfo(info, tempDir);

		const loaded = readCrashInfo(tempDir);
		expect(loaded).toEqual(info);
	});

	it("readCrashInfo returns null when missing", () => {
		const loaded = readCrashInfo(tempDir);
		expect(loaded).toBeNull();
	});

	it("readCrashInfo returns null on corrupt JSON", () => {
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "crash.json"), "not json at all");

		const loaded = readCrashInfo(tempDir);
		expect(loaded).toBeNull();
	});

	it("clearCrashInfo removes file", () => {
		writeCrashInfo({ reason: "test", timestamp: 1 }, tempDir);
		expect(readCrashInfo(tempDir)).not.toBeNull();

		clearCrashInfo(tempDir);
		expect(readCrashInfo(tempDir)).toBeNull();
	});
});

describe("syncRecentProjects", () => {
	it("merges new projects with existing", () => {
		// Write an initial recent.json with one entry
		mkdirSync(tempDir, { recursive: true });
		const initial = {
			recentProjects: [
				{ directory: "/existing", slug: "existing", lastUsed: 1000 },
			],
		};
		writeFileSync(join(tempDir, "recent.json"), JSON.stringify(initial));

		// Sync a new project
		syncRecentProjects(
			[{ path: "/new-project", slug: "new-project", title: "New" }],
			tempDir,
		);

		const data = readFileSync(join(tempDir, "recent.json"), "utf-8");
		const projects = deserializeRecent(data);
		expect(projects.length).toBe(2);

		const dirs = projects.map((p) => p.directory);
		expect(dirs).toContain("/existing");
		expect(dirs).toContain("/new-project");
	});

	it("deduplicates by path", () => {
		mkdirSync(tempDir, { recursive: true });
		const initial = {
			recentProjects: [{ directory: "/myapp", slug: "myapp", lastUsed: 1000 }],
		};
		writeFileSync(join(tempDir, "recent.json"), JSON.stringify(initial));

		// Sync the same path again
		syncRecentProjects(
			[{ path: "/myapp", slug: "myapp", title: "Updated Title" }],
			tempDir,
		);

		const data = readFileSync(join(tempDir, "recent.json"), "utf-8");
		const projects = deserializeRecent(data);
		const matches = projects.filter((p) => p.directory === "/myapp");
		expect(matches).toHaveLength(1);
	});

	it("keeps max 20 entries", () => {
		mkdirSync(tempDir, { recursive: true });

		// Create 25 projects to sync
		const projects = Array.from({ length: 25 }, (_, i) => ({
			path: `/project-${i}`,
			slug: `project-${i}`,
		}));

		syncRecentProjects(projects, tempDir);

		const data = readFileSync(join(tempDir, "recent.json"), "utf-8");
		const loaded = deserializeRecent(data);
		expect(loaded.length).toBeLessThanOrEqual(20);
	});

	it("sorts by lastUsed descending", () => {
		mkdirSync(tempDir, { recursive: true });
		const initial = {
			recentProjects: [
				{ directory: "/old", slug: "old", lastUsed: 500 },
				{ directory: "/older", slug: "older", lastUsed: 100 },
			],
		};
		writeFileSync(join(tempDir, "recent.json"), JSON.stringify(initial));

		syncRecentProjects([{ path: "/newest", slug: "newest" }], tempDir);

		const data = readFileSync(join(tempDir, "recent.json"), "utf-8");
		const projects = deserializeRecent(data);

		// The newest entry should be first (highest lastUsed)
		const newestProject = projects[0];
		assert.exists(newestProject, "expected newest project");
		expect(newestProject.directory).toBe("/newest");

		// All entries should be sorted descending
		for (let i = 1; i < projects.length; i++) {
			const previousProject = projects[i - 1];
			const project = projects[i];
			assert.exists(previousProject, "expected previous project");
			assert.exists(project, "expected project");
			expect(previousProject.lastUsed).toBeGreaterThanOrEqual(project.lastUsed);
		}
	});

	it("creates file if it doesn't exist", () => {
		const subDir = join(tempDir, "fresh");
		expect(existsSync(join(subDir, "recent.json"))).toBe(false);

		syncRecentProjects(
			[{ path: "/first", slug: "first", title: "First" }],
			subDir,
		);

		expect(existsSync(join(subDir, "recent.json"))).toBe(true);
		const data = readFileSync(join(subDir, "recent.json"), "utf-8");
		const projects = deserializeRecent(data);
		expect(projects).toHaveLength(1);
		const project = projects[0];
		assert.exists(project, "expected project");
		expect(project.directory).toBe("/first");
	});

	it("updates existing entry's title when path matches", () => {
		mkdirSync(tempDir, { recursive: true });
		const initial = {
			recentProjects: [
				{
					directory: "/myapp",
					slug: "myapp",
					title: "Old Title",
					lastUsed: 1000,
				},
			],
		};
		writeFileSync(join(tempDir, "recent.json"), JSON.stringify(initial));

		syncRecentProjects(
			[{ path: "/myapp", slug: "myapp", title: "New Title" }],
			tempDir,
		);

		const data = readFileSync(join(tempDir, "recent.json"), "utf-8");
		const projects = deserializeRecent(data);
		const entry = projects.find((p) => p.directory === "/myapp");
		expect(entry).toBeDefined();
		assert.exists(entry, "expected recent project");
		expect(entry.title).toBe("New Title");
	});
});

describe("DaemonConfig with instances", () => {
	it("saves and loads config with instances array", async () => {
		const config: DaemonConfig = {
			pid: 1234,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
			instances: [
				{
					id: "personal",
					name: "Personal",
					port: 4096,
					managed: true,
					env: { ANTHROPIC_API_KEY: "sk-test" },
				},
			],
		};
		await saveDaemonConfig(config, tempDir);
		const loaded = loadDaemonConfig(tempDir);
		expect(loaded).not.toBeNull();
		assert.exists(loaded, "expected daemon config");
		assert.exists(loaded.instances, "expected instances");
		expect(loaded.instances).toHaveLength(1);
		const inst = loaded.instances[0];
		assert.exists(inst, "expected instance");
		expect(inst.id).toBe("personal");
		expect(inst.env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
	});

	it("loads config without instances array (backward compat)", async () => {
		const config: DaemonConfig = {
			pid: 1234,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [],
		};
		await saveDaemonConfig(config, tempDir);
		const loaded = loadDaemonConfig(tempDir);
		expect(loaded).not.toBeNull();
		assert.exists(loaded, "expected daemon config");
		expect(loaded.instances).toBeUndefined();
	});

	it("saves config with project instanceId bindings", async () => {
		const config: DaemonConfig = {
			pid: 1234,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			dangerouslySkipPermissions: false,
			projects: [
				{
					path: "/src/myapp",
					slug: "myapp",
					addedAt: Date.now(),
					instanceId: "personal",
				},
			],
			instances: [],
		};
		await saveDaemonConfig(config, tempDir);
		const loaded = loadDaemonConfig(tempDir);
		assert.exists(loaded, "expected daemon config");
		const project = loaded.projects[0];
		assert.exists(project, "expected project");
		expect(project.instanceId).toBe("personal");
	});
});

describe("DaemonConfig with keepAwakeCommand/keepAwakeArgs", () => {
	it("round-trips keepAwakeCommand and keepAwakeArgs through save/load", async () => {
		const config = makeSampleConfig({
			keepAwake: true,
			keepAwakeCommand: "systemd-inhibit",
			keepAwakeArgs: ["--what=idle", "--who=conduit", "--why=active-session"],
		});

		await saveDaemonConfig(config, tempDir);
		const loaded = loadDaemonConfig(tempDir);

		expect(loaded).not.toBeNull();
		assert.exists(loaded, "expected daemon config");
		expect(loaded.keepAwakeCommand).toBe("systemd-inhibit");
		expect(loaded.keepAwakeArgs).toEqual([
			"--what=idle",
			"--who=conduit",
			"--why=active-session",
		]);
	});

	it("backward compat — loading config without these fields returns undefined", async () => {
		// Write a config that does NOT have keepAwakeCommand/keepAwakeArgs
		const config = makeSampleConfig({ keepAwake: false });
		await saveDaemonConfig(config, tempDir);
		const loaded = loadDaemonConfig(tempDir);

		expect(loaded).not.toBeNull();
		assert.exists(loaded, "expected daemon config");
		expect(loaded.keepAwakeCommand).toBeUndefined();
		expect(loaded.keepAwakeArgs).toBeUndefined();
	});
});
