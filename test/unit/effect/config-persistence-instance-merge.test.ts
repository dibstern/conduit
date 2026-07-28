import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach } from "vitest";
import {
	type DaemonConfig,
	loadDaemonConfig,
	resolveConfiguredInstances,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	ConfigPersistenceLive,
	ConfigPersistenceTag,
	ConfigSnapshotFromEffectStateLive,
	makeConfigWriterLive,
} from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import {
	DaemonConfigRefLive,
	type DaemonRuntimeConfig,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonEventBusLive } from "../../../src/lib/domain/daemon/Services/daemon-pubsub.js";
import type { DaemonInstanceConfig } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	addInstance,
	makeInstanceManagerStateLive,
	persistConfig,
	removeInstance,
	updateInstance,
} from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "config-instance-merge-test-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

const runtimeConfig: DaemonRuntimeConfig = {
	port: 2633,
	host: "127.0.0.1",
	pinHash: null,
	tlsEnabled: false,
	keepAwake: false,
	keepAwakeCommand: undefined,
	keepAwakeArgs: undefined,
	claudeConfigDir: undefined,
	shuttingDown: false,
	dismissedPaths: new Set(),
	startTime: Date.now(),
	hostExplicit: false,
	persistedSessionCounts: new Map(),
};

const baseConfig: DaemonConfig = {
	pid: 1234,
	port: 2633,
	pinHash: null,
	tls: false,
	debug: false,
	keepAwake: false,
	dangerouslySkipPermissions: false,
	projects: [],
};

const makePersistenceLayer = (
	initialInstances: ReadonlyArray<DaemonInstanceConfig>,
	config: DaemonRuntimeConfig = runtimeConfig,
) => {
	const state = Layer.mergeAll(
		DaemonConfigRefLive(config),
		DaemonEventBusLive,
		makeConfigWriterLive(tempDir),
		makeProjectRegistryLive(),
		makeInstanceManagerStateLive(undefined, initialInstances),
	);
	const snapshot = ConfigSnapshotFromEffectStateLive.pipe(
		Layer.provideMerge(state),
	);
	return ConfigPersistenceLive.pipe(Layer.provideMerge(snapshot));
};

const writeConfig = (config: DaemonConfig): void => {
	writeFileSync(join(tempDir, "daemon.json"), JSON.stringify(config), "utf-8");
};

const readConfig = (): DaemonConfig => {
	const config = loadDaemonConfig(tempDir);
	if (config === null) {
		throw new Error("Expected daemon config to load");
	}
	return config;
};

describe("config persistence instance merge", () => {
	it.scoped(
		"preserves persisted instance metadata and a named Claude instance through an OpenCode update",
		() =>
			Effect.gen(function* () {
				writeConfig({
					...baseConfig,
					instances: [
						{
							id: "personal",
							name: "Personal",
							port: 4096,
							managed: true,
							env: { OPENCODE_CONFIG_DIR: "/old/opencode" },
							driver: "opencode",
							configDir: "/persisted/opencode",
						},
						{
							id: "work-claude",
							name: "Work Claude",
							port: 0,
							managed: false,
							env: { CLAUDE_PROFILE: "work" },
							driver: "claude",
							configDir: "/persisted/claude",
						},
					],
				});

				yield* updateInstance("personal", {
					name: "Renamed Personal",
					port: 5096,
					env: { OPENCODE_CONFIG_DIR: "/runtime/opencode" },
				});
				const persistence = yield* ConfigPersistenceTag;
				yield* persistence.flush;

				const saved = readConfig();
				expect(saved.instances).toEqual([
					{
						id: "personal",
						name: "Renamed Personal",
						port: 5096,
						managed: true,
						env: { OPENCODE_CONFIG_DIR: "/runtime/opencode" },
						driver: "opencode",
						configDir: "/persisted/opencode",
					},
					{
						id: "work-claude",
						name: "Work Claude",
						port: 0,
						managed: false,
						env: { CLAUDE_PROFILE: "work" },
						driver: "claude",
						configDir: "/persisted/claude",
					},
				]);
				expect(resolveConfiguredInstances(saved)).toEqual([
					{
						id: "personal",
						driver: "opencode",
						configDir: "/persisted/opencode",
					},
					{
						id: "work-claude",
						driver: "claude",
						configDir: "/persisted/claude",
					},
					{ id: "opencode", driver: "opencode" },
					{ id: "claude", driver: "claude" },
				]);
			}).pipe(
				Effect.provide(
					Layer.fresh(
						makePersistenceLayer([
							{
								id: "personal",
								name: "Personal",
								port: 4096,
								managed: true,
								env: { OPENCODE_CONFIG_DIR: "/old/opencode" },
							},
							{
								id: "work-claude",
								name: "Work Claude",
								port: 0,
								managed: false,
								env: { CLAUDE_PROFILE: "work" },
								driver: "claude",
								configDir: "/persisted/claude",
							},
						]),
					),
				),
			),
	);

	it.scoped(
		"defaults a newly added runtime instance to the OpenCode driver",
		() =>
			Effect.gen(function* () {
				writeConfig({
					...baseConfig,
					instances: [
						{
							id: "work-claude",
							name: "Work Claude",
							port: 0,
							managed: false,
							driver: "claude",
							configDir: "/persisted/claude",
						},
					],
				});

				yield* addInstance({
					id: "new-opencode",
					name: "New OpenCode",
					port: 6096,
					managed: false,
					url: "https://opencode.example.test",
				});
				const persistence = yield* ConfigPersistenceTag;
				yield* persistence.flush;

				expect(readConfig().instances).toEqual([
					{
						id: "work-claude",
						name: "Work Claude",
						port: 0,
						managed: false,
						driver: "claude",
						configDir: "/persisted/claude",
					},
					{
						id: "new-opencode",
						name: "New OpenCode",
						port: 6096,
						managed: false,
						url: "https://opencode.example.test",
						driver: "opencode",
					},
				]);
			}).pipe(
				Effect.provide(
					Layer.fresh(
						makePersistenceLayer([
							{
								id: "work-claude",
								name: "Work Claude",
								port: 0,
								managed: false,
								driver: "claude",
								configDir: "/persisted/claude",
							},
						]),
					),
				),
			),
	);

	it.scoped(
		"removes an absent OpenCode instance without deleting a persisted Claude instance",
		() =>
			Effect.gen(function* () {
				writeConfig({
					...baseConfig,
					instances: [
						{
							id: "retired-opencode",
							name: "Retired OpenCode",
							port: 7096,
							managed: true,
							driver: "opencode",
							configDir: "/persisted/retired-opencode",
						},
						{
							id: "work-claude",
							name: "Work Claude",
							port: 0,
							managed: false,
							driver: "claude",
							configDir: "/persisted/claude",
						},
					],
				});

				yield* removeInstance("retired-opencode");
				const persistence = yield* ConfigPersistenceTag;
				yield* persistence.flush;

				expect(readConfig().instances).toEqual([
					{
						id: "work-claude",
						name: "Work Claude",
						port: 0,
						managed: false,
						driver: "claude",
						configDir: "/persisted/claude",
					},
				]);
			}).pipe(
				Effect.provide(
					Layer.fresh(
						makePersistenceLayer([
							{
								id: "retired-opencode",
								name: "Retired OpenCode",
								port: 7096,
								managed: true,
							},
							{
								id: "work-claude",
								name: "Work Claude",
								port: 0,
								managed: false,
								driver: "claude",
								configDir: "/persisted/claude",
							},
						]),
					),
				),
			),
	);

	it.scoped("removes a configured Claude instance", () =>
		Effect.gen(function* () {
			writeConfig({
				...baseConfig,
				instances: [
					{
						id: "work-claude",
						name: "Work Claude",
						port: 0,
						managed: false,
						driver: "claude",
						configDir: "/persisted/claude",
					},
				],
			});

			yield* removeInstance("work-claude");
			const persistence = yield* ConfigPersistenceTag;
			yield* persistence.flush;

			expect(readConfig().instances).toEqual([]);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					makePersistenceLayer([
						{
							id: "work-claude",
							name: "Work Claude",
							port: 0,
							managed: false,
							driver: "claude",
							configDir: "/persisted/claude",
						},
					]),
				),
			),
		),
	);

	it.scoped("updates a configured Claude instance directory", () =>
		Effect.gen(function* () {
			writeConfig({
				...baseConfig,
				instances: [
					{
						id: "work-claude",
						name: "Work Claude",
						port: 0,
						managed: false,
						driver: "claude",
						configDir: "/profiles/work",
					},
				],
			});

			yield* updateInstance("work-claude", {
				driver: "claude",
				configDir: "/profiles/personal",
			});
			const persistence = yield* ConfigPersistenceTag;
			yield* persistence.flush;

			expect(readConfig().instances).toEqual([
				{
					id: "work-claude",
					name: "Work Claude",
					port: 0,
					managed: false,
					driver: "claude",
					configDir: "/profiles/personal",
				},
			]);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					makePersistenceLayer([
						{
							id: "work-claude",
							name: "Work Claude",
							port: 0,
							managed: false,
							driver: "claude",
							configDir: "/profiles/work",
						},
					]),
				),
			),
		),
	);

	it.scoped("keeps synthesized defaults unchanged after a config save", () =>
		Effect.gen(function* () {
			writeConfig({
				...baseConfig,
				claudeConfigDir: "/default/claude",
			});

			yield* persistConfig;
			const persistence = yield* ConfigPersistenceTag;
			yield* persistence.flush;

			const saved = readConfig();
			expect(saved.instances).toEqual([]);
			expect(resolveConfiguredInstances(saved)).toEqual([
				{ id: "opencode", driver: "opencode" },
				{
					id: "claude",
					driver: "claude",
					configDir: "/default/claude",
				},
			]);
		}).pipe(
			Effect.provide(
				Layer.fresh(
					makePersistenceLayer([], {
						...runtimeConfig,
						claudeConfigDir: "/default/claude",
					}),
				),
			),
		),
	);
});
