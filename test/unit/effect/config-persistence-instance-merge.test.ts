// Account mutation properties and persistence are covered through the directory
// interface and the account-mutations integration RPC flow. These retain the
// independent legacy config decoding contract.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result as Either } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DaemonConfig,
	defaultDaemonConfig,
	loadDaemonConfigResult,
	migrateLegacyInstanceIds,
} from "../../../src/lib/daemon/config-persistence.js";

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "config-instance-migration-"));
});
afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});
const baseConfig: DaemonConfig = defaultDaemonConfig();
const writeConfig = (config: DaemonConfig): void => {
	writeFileSync(join(tempDir, "daemon.json"), JSON.stringify(config), "utf-8");
};
const readConfig = (): DaemonConfig =>
	Either.getOrThrowWith(loadDaemonConfigResult(tempDir), (error) => error);

describe("migrateLegacyInstanceIds", () => {
	it("rewrites a legacy default OpenCode instance", () => {
		const migrated = migrateLegacyInstanceIds({
			...baseConfig,
			instances: [
				{
					id: "default",
					name: "opencode",
					port: 4096,
					managed: false,
					url: "http://localhost:4096",
					driver: "opencode",
				},
			],
			projects: [
				{
					path: "/tmp/app",
					folders: ["/tmp/app"],
					slug: "app",
					title: "App",
					addedAt: 1,
				},
			],
		});

		expect(migrated.instances).toEqual([
			{
				id: "opencode",
				name: "opencode",
				port: 4096,
				managed: false,
				url: "http://localhost:4096",
				driver: "opencode",
			},
		]);
		expect(migrated.projects[0]).not.toHaveProperty("instanceId");
	});

	it("treats a driverless legacy default as OpenCode", () => {
		const migrated = migrateLegacyInstanceIds({
			...baseConfig,
			instances: [
				{ id: "default", name: "Default", port: 4096, managed: false },
			],
		});
		expect(migrated.instances?.[0]?.id).toBe("opencode");
	});

	it("leaves a Claude instance keyed as default untouched", () => {
		const config: DaemonConfig = {
			...baseConfig,
			instances: [
				{
					id: "default",
					name: "Claude",
					port: 0,
					managed: false,
					driver: "claude",
				},
			],
		};
		expect(migrateLegacyInstanceIds(config)).toBe(config);
	});

	it("is a no-op when a canonical opencode instance already exists", () => {
		const config: DaemonConfig = {
			...baseConfig,
			instances: [
				{
					id: "default",
					name: "Legacy",
					port: 4096,
					managed: false,
					driver: "opencode",
				},
				{
					id: "opencode",
					name: "Canonical",
					port: 4096,
					managed: false,
					driver: "opencode",
				},
			],
		};
		expect(migrateLegacyInstanceIds(config)).toBe(config);
	});

	it("is a no-op when there are no instances", () => {
		expect(migrateLegacyInstanceIds(baseConfig)).toBe(baseConfig);
	});

	it("migrates a persisted legacy default when the config is loaded", () => {
		writeConfig({
			...baseConfig,
			instances: [
				{
					id: "default",
					name: "opencode",
					port: 4096,
					managed: false,
					url: "http://localhost:4096",
					driver: "opencode",
				},
			],
			projects: [
				{
					path: "/tmp/app",
					folders: ["/tmp/app"],
					slug: "app",
					title: "App",
					addedAt: 1,
				},
			],
		});

		const loaded = readConfig();
		expect(loaded.instances?.[0]?.id).toBe("opencode");
		expect(loaded.projects[0]).not.toHaveProperty("instanceId");
	});
});
