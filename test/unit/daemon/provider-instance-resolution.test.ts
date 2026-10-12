import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CURRENT_CONFIG_VERSION,
	type DaemonConfig,
	DaemonConfigSchema,
	loadDaemonConfig,
	resolveClaudeInstanceConfigDir,
	resolveConfiguredInstances,
	resolveInstanceDriver,
	resolveOpenCodeInstanceUrl,
	resolveProviderRoutingDriver,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "provider-instance-resolution-test-"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

const configWithoutInstances: DaemonConfig = {
	pid: 1234,
	port: 2633,
	pinHash: null,
	tls: false,
	debug: false,
	keepAwake: false,
	projects: [],
};

describe("provider instance resolution", () => {
	it("loads and resolves an old OpenCode-only daemon config with migrated folders", () => {
		const oldConfig = {
			pid: 1234,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			projects: [
				{
					path: "/src/project",
					slug: "project",
					addedAt: 1,
					instanceId: "personal",
				},
			],
			instances: [
				{
					id: "personal",
					name: "Personal",
					port: 4096,
					managed: true,
					env: { OPENCODE_CONFIG_DIR: "/tmp/opencode" },
				},
			],
		};
		writeFileSync(join(tempDir, "daemon.json"), JSON.stringify(oldConfig));

		const decoded = Schema.decodeUnknownSync(DaemonConfigSchema)(oldConfig);
		const loaded = loadDaemonConfig(tempDir);

		const migrated = {
			...oldConfig,
			projects: [
				{
					path: "/src/project",
					slug: "project",
					addedAt: 1,
					folders: ["/src/project"],
				},
			],
		};
		expect(decoded).toEqual(migrated);
		// Loading fills in settings added since the file was written.
		expect(loaded).toEqual({ ...migrated, autoSettleAfterDays: 3 });
		if (loaded === null) {
			throw new Error("Expected old daemon config to load");
		}
		expect(
			resolveConfiguredInstances(loaded).find(
				(instance) => instance.id === "personal",
			),
		).toEqual({ id: "personal", driver: "opencode" });
		expect(resolveInstanceDriver(loaded, "personal")).toBe("opencode");
	});

	it("synthesizes both built-in defaults when instances are absent", () => {
		const config: DaemonConfig = {
			pid: 1234,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			claudeConfigDir: "/tmp/claude",
			projects: [],
		};

		expect(resolveConfiguredInstances(config)).toEqual([
			{ id: "opencode", driver: "opencode" },
			{ id: "claude", driver: "claude", configDir: "/tmp/claude" },
		]);
	});

	it("decodes new instance fields and lets an explicit default-id entry win", () => {
		const config: DaemonConfig = {
			pid: 1234,
			port: 2633,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			claudeConfigDir: "/implicit/claude",
			projects: [],
			instances: [
				{
					id: "claude",
					name: "Work Claude",
					port: 0,
					managed: false,
					driver: "claude",
					configDir: "/explicit/claude",
				},
			],
		};
		const decoded = Schema.decodeUnknownSync(DaemonConfigSchema)(config);

		expect(decoded).toEqual(config);
		expect(resolveConfiguredInstances(config)).toEqual([
			{
				id: "claude",
				driver: "claude",
				configDir: "/explicit/claude",
			},
			{ id: "opencode", driver: "opencode" },
		]);
	});

	it("resolves both synthesized default instance ids to their drivers", () => {
		expect(resolveInstanceDriver(configWithoutInstances, "opencode")).toBe(
			"opencode",
		);
		expect(resolveInstanceDriver(configWithoutInstances, "claude")).toBe(
			"claude",
		);
	});

	it("resolves the explicitly configured driver for a named instance", () => {
		const config: DaemonConfig = {
			...configWithoutInstances,
			instances: [
				{
					id: "work-claude",
					name: "Work Claude",
					port: 0,
					managed: false,
					driver: "claude",
					configDir: "/tmp/work-claude",
				},
			],
		};

		expect(resolveInstanceDriver(config, "work-claude")).toBe("claude");
	});

	it("resolves an explicit default-id entry before the built-in fallback", () => {
		const config: DaemonConfig = {
			...configWithoutInstances,
			instances: [
				{
					id: "claude",
					name: "Claude via OpenCode",
					port: 4096,
					managed: true,
					driver: "opencode",
				},
			],
		};

		expect(resolveInstanceDriver(config, "claude")).toBe("opencode");
	});

	it("returns the historical driver default for an unknown instance id", () => {
		expect(() =>
			resolveInstanceDriver(configWithoutInstances, "missing"),
		).not.toThrow();
		expect(resolveInstanceDriver(configWithoutInstances, "missing")).toBe(
			"opencode",
		);
	});

	it("resolves routing drivers without defaulting an unknown instance to OpenCode", () => {
		const config: DaemonConfig = {
			...configWithoutInstances,
			instances: [
				{
					id: "work-claude",
					name: "Work Claude",
					port: 0,
					managed: false,
					driver: "claude",
				},
				{
					id: "work-opencode",
					name: "Work OpenCode",
					port: 4096,
					managed: true,
					driver: "opencode",
				},
			],
		};

		expect(resolveProviderRoutingDriver(config, "work-claude")).toBe("claude");
		expect(resolveProviderRoutingDriver(config, "work-opencode")).toBe(
			"opencode",
		);
		expect(resolveProviderRoutingDriver(config, "deleted-instance")).toBe(
			undefined,
		);
		expect(resolveProviderRoutingDriver(null, "claude")).toBe("claude");
		expect(resolveProviderRoutingDriver(null, "opencode")).toBe("opencode");
	});

	it("uses the running environment for the default Claude folder until restart", () => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/running-claude");
		const config: DaemonConfig = {
			...configWithoutInstances,
			claudeConfigDir: "/tmp/default-claude",
			instances: [
				{
					id: "work-claude",
					name: "Work Claude",
					port: 0,
					managed: false,
					driver: "claude",
					configDir: "/tmp/work-claude",
				},
				{
					id: "work-opencode",
					name: "Work OpenCode",
					port: 4096,
					managed: true,
					driver: "opencode",
					configDir: "/tmp/work-opencode",
				},
			],
		};

		expect(resolveClaudeInstanceConfigDir(config, "work-claude")).toBe(
			"/tmp/work-claude",
		);
		expect(resolveClaudeInstanceConfigDir(config, "claude")).toBe(
			"/tmp/running-claude",
		);
		expect(resolveClaudeInstanceConfigDir(config, "work-opencode")).toBe(
			undefined,
		);
		expect(resolveClaudeInstanceConfigDir(config, "opencode")).toBe(undefined);
		expect(
			resolveClaudeInstanceConfigDir(configWithoutInstances, "claude"),
		).toBe(undefined);
		expect(resolveClaudeInstanceConfigDir(null, "claude")).toBe(undefined);
	});

	it("keeps the default folder after its label is stored without a folder", () => {
		const config: DaemonConfig = {
			...configWithoutInstances,
			claudeConfigDir: "/tmp/default-claude",
			instances: [
				{
					id: "claude",
					name: "Personal",
					port: 0,
					managed: false,
					driver: "claude",
				},
			],
		};
		expect(
			resolveConfiguredInstances(config).find(({ id }) => id === "claude"),
		).toEqual({
			id: "claude",
			driver: "claude",
			configDir: "/tmp/default-claude",
		});
	});

	it("loads and saves a legacy explicit default folder in one stored home", async () => {
		writeFileSync(
			join(tempDir, "daemon.json"),
			JSON.stringify({
				...configWithoutInstances,
				claudeConfigDir: "/implicit/claude",
				instances: [
					{
						id: "claude",
						name: "Personal",
						port: 0,
						managed: false,
						driver: "claude",
						configDir: "/explicit/claude",
					},
				],
			}),
		);
		const config = loadDaemonConfig(tempDir);
		if (!config) throw new Error("Missing daemon config");
		expect(config.claudeConfigDir).toBe("/explicit/claude");
		expect(config.instances?.[0]).not.toHaveProperty("configDir");
		await saveDaemonConfig(config, tempDir);
		expect(loadDaemonConfig(tempDir)).toEqual({
			...config,
			configVersion: CURRENT_CONFIG_VERSION,
		});
	});

	it("resolves server URLs only for named OpenCode instances", () => {
		const config: DaemonConfig = {
			...configWithoutInstances,
			instances: [
				{
					id: "oc-managed",
					name: "Managed OpenCode",
					port: 4197,
					managed: true,
					driver: "opencode",
				},
				{
					id: "oc-external",
					name: "External OpenCode",
					port: 0,
					managed: false,
					url: "http://127.0.0.1:5011",
					driver: "opencode",
				},
				{
					id: "oc-external-no-url",
					name: "External without URL",
					port: 0,
					managed: false,
					driver: "opencode",
				},
				{
					id: "work-claude",
					name: "Work Claude",
					port: 0,
					managed: false,
					driver: "claude",
				},
			],
		};

		// Managed → local URL derived from the configured port.
		expect(resolveOpenCodeInstanceUrl(config, "oc-managed")).toBe(
			"http://localhost:4197",
		);
		// Unmanaged → the user-provided external URL.
		expect(resolveOpenCodeInstanceUrl(config, "oc-external")).toBe(
			"http://127.0.0.1:5011",
		);
		// Unmanaged without a URL cannot be routed.
		expect(resolveOpenCodeInstanceUrl(config, "oc-external-no-url")).toBe(
			undefined,
		);
		// The default id always falls back to the project-default client.
		expect(resolveOpenCodeInstanceUrl(config, "opencode")).toBe(undefined);
		// Non-opencode drivers and unknown ids resolve to nothing.
		expect(resolveOpenCodeInstanceUrl(config, "work-claude")).toBe(undefined);
		expect(resolveOpenCodeInstanceUrl(config, "missing")).toBe(undefined);
		expect(resolveOpenCodeInstanceUrl(null, "oc-managed")).toBe(undefined);
	});
});
