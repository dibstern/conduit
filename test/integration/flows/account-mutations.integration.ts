// Failure modes: invalid requests lose their typed rejection; account retyping
// guards drift or default removal fails; concurrent adds collide or claim a bare
// driver id; Claude accounts remain in the process registry; replies precede disk
// saves; clearing a folder
// resurrects persisted metadata on restart; OpenCode edits lose account metadata;
// disk read-merge overrides owned state; a failed save corrupts daemon.json;
// renaming resets a selected runtime's port or managed mode; a failed stop loses
// the account or its recovery record and prevents a safe retry.
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Result as Either, HashMap, Layer, Ref, Schema } from "effect";
import { RpcTest } from "effect/rpc";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { AccountChangeRejected } from "../../../src/lib/contracts/account.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type DaemonConfig,
	defaultDaemonConfig,
	loadDaemonConfigResult,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	ConfigPersistenceLive,
	ConfigSnapshotFromEffectStateLive,
	makeConfigWriterLive,
} from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import { InstanceManagerStateTag } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { stopManagedOpenCode } from "../../../src/lib/instance/managed-opencode-process.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

vi.mock(
	"../../../src/lib/instance/managed-opencode-process.js",
	async (original) => ({
		...(await original<
			typeof import("../../../src/lib/instance/managed-opencode-process.js")
		>()),
		stopManagedOpenCode: vi.fn(),
		isProcessAlive: vi.fn(() => true),
	}),
);

const fakeManagedRecord = {
	port: 49002,
	pid: 99002,
	version: "test-version",
	processIdentity: {
		supervisorPid: 99001,
		controlPort: 49003,
		token: "a".repeat(64),
	},
	env: {
		ACCOUNT_MARKER: "remote",
		OPENCODE_SERVER_USERNAME: "opencode",
		OPENCODE_SERVER_PASSWORD: "test-password",
	},
};

// Seed the result of runtime port selection and process adoption. Every process
// operation is mocked, so neither the fake PIDs nor their listener ports are used.
const seedManagedRuntime = Effect.gen(function* () {
	const manager = yield* InstanceManagerStateTag;
	yield* Ref.update(manager, (state) => ({
		...state,
		instances: HashMap.modify(state.instances, "remote", (instance) => ({
			...instance,
			port: fakeManagedRecord.port,
			pid: fakeManagedRecord.pid,
			version: fakeManagedRecord.version,
			managed: true,
			status: "healthy" as const,
		})),
		externalUrls: HashMap.remove(state.externalUrls, "remote"),
		managedProcesses: HashMap.set(
			state.managedProcesses ?? HashMap.empty(),
			"remote",
			fakeManagedRecord,
		),
	}));
});

const makeClient = Effect.gen(function* () {
	const handlers = yield* DaemonWsRpcHandlersTag;
	return yield* RpcTest.makeClient(WsRpcGroup).pipe(
		Effect.provide(
			makeRoutedWsRpcServerLayer(
				() => Effect.die("Unexpected project routing"),
				handlers,
			),
		),
	);
});

let directory: string;
let configDir: string;
let initial: DaemonConfig;
let launchLogin: ReturnType<typeof configuredClaudeConfigDir>;
const evidence: Array<{ scenario: string; accounts?: ReadonlyArray<string> }> =
	[];
const artifact = join(
	process.cwd(),
	"test-results/g4zp-6-account-mutations.json",
);

beforeAll(() => rmSync(artifact, { force: true }));

const readSaved = () => {
	const loaded = loadDaemonConfigResult(configDir);
	if (Either.isFailure(loaded)) throw loaded.failure;
	return loaded.success;
};

const makeLayer = (config = initial) =>
	makeDaemonRpcTestLayer([], undefined, {
		configDir,
		launchLogin,
		instances: config.instances ?? [],
		persistence: ConfigPersistenceLive.pipe(
			Layer.provide(
				Layer.merge(
					ConfigSnapshotFromEffectStateLive,
					makeConfigWriterLive(configDir),
				),
			),
		),
	});

beforeEach(async () => {
	vi.mocked(stopManagedOpenCode).mockReset().mockResolvedValue(true);
	directory = mkdtempSync(join(tmpdir(), "g4zp-account-mutations-"));
	configDir = join(directory, "conduit");
	const home = join(directory, "home");
	mkdirSync(home);
	vi.stubEnv("HOME", home);
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(directory, "ambient-login"));
	vi.stubEnv("CONDUIT_CONFIG_DIR", configDir);
	launchLogin = configuredClaudeConfigDir(join(directory, "launch-login"));
	initial = {
		...defaultDaemonConfig(),
		debug: true,
		instances: [
			{
				id: "claude",
				name: "Claude",
				configDir: join(directory, "old-default-folder"),
				driver: "claude",
				port: 0,
				managed: false,
			},
			{
				id: "personal",
				name: "Personal",
				driver: "claude",
				port: 0,
				managed: false,
				configDir: join(directory, "old-personal-folder"),
				env: { ACCOUNT_MARKER: "personal" },
			},
			{
				id: "remote",
				name: "Remote",
				driver: "opencode",
				port: 47001,
				managed: false,
				url: "http://opencode.invalid:47001",
				configDir: join(directory, "remote-folder"),
				env: { ACCOUNT_MARKER: "remote" },
			},
		],
	};
	await saveDaemonConfig(initial, configDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

afterAll(() => {
	if (evidence.length !== 8) return;
	mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
	writeFileSync(
		artifact,
		JSON.stringify(
			{
				ticket: "conduit-test-g4zp.6",
				transport: "RpcTest client through the routed daemon RPC handlers",
				persistence: "real config snapshot and atomic disk writer",
				scenarios: evidence,
			},
			null,
			2,
		),
	);
});

describe("account mutations through daemon RPC", () => {
	it.effect("returns typed rejections and allows default removal", () =>
		Effect.gen(function* () {
			const client = yield* makeClient;
			const invalidAdds: ReadonlyArray<{
				reason: string;
				name: string;
				driver: "claude" | "opencode";
				managed?: boolean;
				port?: number;
				url?: string;
			}> = [
				{
					name: "Bad managed",
					driver: "claude",
					managed: true,
					reason: "must not be managed",
				},
				{
					name: "Bad port",
					driver: "claude",
					port: 47002,
					reason: "must not include 'port'",
				},
				{
					name: "Bad URL",
					driver: "claude",
					url: "http://example.invalid",
					reason: "must not include 'url'",
				},
				{
					name: "Bad port",
					driver: "opencode",
					port: 0,
					reason: "valid 'port'",
				},
				{
					name: "Bad port",
					driver: "opencode",
					port: 1.5,
					reason: "Expected an integer",
				},
				{
					name: "Bad port",
					driver: "opencode",
					port: 65536,
					reason: "valid 'port'",
				},
				{
					name: "Missing port",
					driver: "opencode",
					managed: true,
					reason: "valid 'port'",
				},
				{
					name: "Missing address",
					driver: "opencode",
					managed: false,
					reason: "unmanaged instances require",
				},
				{
					name: "Bad URL",
					driver: "opencode",
					managed: false,
					url: "invalid",
					reason: "'url' must be a valid URL",
				},
				{
					name: "Managed URL",
					driver: "opencode",
					managed: true,
					port: 47002,
					url: "http://example.invalid",
					reason: "'url' is only valid",
				},
				{ name: "   ", driver: "claude", reason: "name is required" },
			];
			const before = readFileSync(join(configDir, "daemon.json"), "utf8");
			for (const { reason, ...request } of invalidAdds) {
				const result = yield* Effect.result(client.AddInstance(request));
				expect(result).toMatchObject({
					_tag: "Left",
					left: {
						_tag: "AccountChangeRejected",
						reason: expect.stringContaining(reason),
					},
				});
				if (Either.isFailure(result)) {
					const rejection = Schema.decodeUnknownSync(AccountChangeRejected)(
						result.failure,
					);
					expect(rejection.reason.length).toBeGreaterThan(0);
					expect(rejection.message).toBe(rejection.reason);
				}
			}
			for (const mutation of [
				client.RenameInstance({ instanceId: "missing", name: "Missing" }),
				client.UpdateInstance({ instanceId: "missing", configDir: "" }),
				client.RemoveInstance({ instanceId: "missing" }),
			]) {
				expect(yield* Effect.result(mutation)).toMatchObject({
					_tag: "Left",
					left: {
						_tag: "AccountChangeRejected",
						id: "missing",
						reason: expect.stringContaining("not found"),
					},
				});
			}
			for (const instanceId of ["claude", "personal", "remote"]) {
				expect(
					yield* Effect.result(
						client.UpdateInstance({
							instanceId,
							driver: instanceId === "remote" ? "claude" : "opencode",
						}),
					),
				).toMatchObject({
					_tag: "Left",
					left: {
						_tag: "AccountChangeRejected",
						id: instanceId,
						reason: expect.stringContaining("type"),
					},
				});
			}
			expect(readFileSync(join(configDir, "daemon.json"), "utf8")).toBe(before);
			const removed = yield* client.RemoveInstance({ instanceId: "claude" });
			expect(removed.instances.some((account) => account.id === "claude")).toBe(
				false,
			);
			expect(removed.instances).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "personal", isDefault: true }),
				]),
			);
			expect(readSaved()).toMatchObject({
				accountDefaults: { claude: "personal" },
				deletedAccounts: [{ id: "claude", driver: "claude" }],
			});
			evidence.push({
				scenario: "typed mutation rejections and durable default removal",
			});
		}).pipe(Effect.provide(makeLayer())),
	);

	it.effect("saves every successful mutation before its reply", () =>
		Effect.gen(function* () {
			const client = yield* makeClient;
			const added = yield* client.AddInstance({
				name: "Work",
				driver: "claude",
				configDir: join(directory, "work-folder"),
			});
			const id = added.addedInstanceId;
			if (id === undefined) throw new Error("Missing added account id");
			expect(readSaved().instances).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id,
						name: "Work",
						configDir: join(directory, "work-folder"),
					}),
				]),
			);
			yield* client.RenameInstance({ instanceId: id, name: " Work renamed " });
			expect(
				readSaved().instances?.find((account) => account.id === id)?.name,
			).toBe("Work renamed");
			yield* client.UpdateInstance({
				instanceId: id,
				env: { ACCOUNT_MARKER: "work" },
				configDir: join(directory, "updated-work-folder"),
			});
			expect(
				readSaved().instances?.find((account) => account.id === id),
			).toMatchObject({
				env: { ACCOUNT_MARKER: "work" },
				configDir: join(directory, "updated-work-folder"),
			});
			yield* client.RemoveInstance({ instanceId: id });
			expect(readSaved().instances?.some((account) => account.id === id)).toBe(
				false,
			);
			expect(
				(yield* client.GetInstances({})).instances.some(
					(account) => account.id === id,
				),
			).toBe(false);
			evidence.push({
				scenario: "add, rename, update and remove are durable before replying",
			});
		}).pipe(Effect.provide(makeLayer())),
	);

	it.effect(
		"keeps cleared default and named Claude folders cleared after restart",
		() =>
			Effect.gen(function* () {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const client = yield* makeClient;
						for (const id of ["claude", "personal"]) {
							yield* client.UpdateInstance({ instanceId: id, configDir: "" });
							const account = (yield* client.GetInstances({})).instances.find(
								(item) => item.id === id,
							);
							expect(account?.configDir).toBeUndefined();
							const resolved = yield* (yield* AccountDirectory).resolve({
								_tag: "Id",
								id,
							});
							expect(resolved).toMatchObject({
								driver: "claude",
								folder: launchLogin,
							});
						}
						yield* (yield* ConfigPersistenceTag).flush;
					}).pipe(Effect.provide(makeLayer())),
				);
				const saved = readSaved();
				expect(saved).not.toHaveProperty("claudeConfigDir");
				expect(
					saved.instances?.find((account) => account.id === "personal")
						?.configDir,
				).toBeUndefined();
				yield* Effect.scoped(
					Effect.gen(function* () {
						const client = yield* makeClient;
						const directory = yield* AccountDirectory;
						for (const id of ["claude", "personal"]) {
							expect(
								(yield* client.GetInstances({})).instances.find(
									(account) => account.id === id,
								)?.configDir,
							).toBeUndefined();
							expect(
								yield* directory.resolve({ _tag: "Id", id }),
							).toMatchObject({ driver: "claude", folder: launchLogin });
						}
					}).pipe(Effect.provide(makeLayer(saved))),
				);
				evidence.push({
					scenario: "cleared folders survive flush and a fresh layered runtime",
				});
			}),
	);

	it.effect(
		"allocates distinct non-driver ids for simultaneous Claude and OpenCode names",
		() =>
			Effect.gen(function* () {
				const client = yield* makeClient;
				const added = yield* Effect.all(
					[
						client.AddInstance({ name: "Claude", driver: "claude" }),
						client.AddInstance({ name: "Claude", driver: "claude" }),
						client.AddInstance({
							name: "OpenCode",
							driver: "opencode",
							managed: false,
							url: "http://opencode.invalid:47002",
						}),
						client.AddInstance({
							name: "OpenCode",
							driver: "opencode",
							managed: false,
							url: "http://opencode.invalid:47003",
						}),
					],
					{ concurrency: 4 },
				);
				const ids = added.map((result) => result.addedInstanceId);
				expect(
					ids.every(
						(id) => id !== undefined && id !== "claude" && id !== "opencode",
					),
				).toBe(true);
				expect(new Set(ids).size).toBe(4);
				expect((yield* client.GetInstances({})).instances).toHaveLength(4);
				expect(
					readSaved()
						.instances?.map((account) => account.id)
						.sort(),
				).toEqual([...ids].sort());
				const runtime = yield* Ref.get(yield* InstanceManagerStateTag);
				expect(
					Array.from(HashMap.values(runtime.instances)).map(
						(instance) => instance.driver,
					),
				).toEqual(["opencode", "opencode"]);
				evidence.push({
					scenario:
						"concurrent reserved-name allocations and OpenCode-only runtime state",
					accounts: (readSaved().instances ?? []).map((account) => account.id),
				});
			}).pipe(
				Effect.provide(makeLayer({ ...defaultDaemonConfig(), instances: [] })),
			),
	);

	it.effect(
		"preserves live account metadata across OpenCode edits and merges only debug from disk",
		() =>
			Effect.gen(function* () {
				const client = yield* makeClient;
				yield* Effect.tryPromise(() =>
					saveDaemonConfig(
						{
							...initial,
							debug: true,
							keepAwake: true,
							instances: (initial.instances ?? []).map((account) => ({
								...account,
								name: "Stale disk name",
								configDir: join(directory, "stale-disk-folder"),
								env: { ACCOUNT_MARKER: "stale" },
							})),
						},
						configDir,
					),
				);
				yield* client.UpdateInstance({
					instanceId: "remote",
					port: 48001,
					env: { ACCOUNT_MARKER: "updated-remote" },
				});
				const saved = readSaved();
				expect(saved.debug).toBe(true);
				expect(saved.keepAwake).toBe(false);
				expect(
					saved.instances?.find((account) => account.id === "remote"),
				).toMatchObject({
					name: "Remote",
					driver: "opencode",
					port: 48001,
					configDir: join(directory, "remote-folder"),
					env: { ACCOUNT_MARKER: "updated-remote" },
				});
				expect(
					saved.instances?.find((account) => account.id === "personal"),
				).toMatchObject({
					name: "Personal",
					driver: "claude",
					configDir: join(directory, "old-personal-folder"),
					env: { ACCOUNT_MARKER: "personal" },
				});
				expect(
					saved.instances?.find(({ id }) => id === "claude")?.configDir,
				).toBe(join(directory, "old-default-folder"));
				evidence.push({
					scenario:
						"account metadata stays authoritative while only debug merges from disk",
				});
			}).pipe(Effect.provide(makeLayer())),
	);

	it.effect(
		"reports a failed mutation save through the typed error and preserves the invalid file",
		() =>
			Effect.gen(function* () {
				const client = yield* makeClient;
				const invalid = "{invalid config kept for repair";
				writeFileSync(join(configDir, "daemon.json"), invalid);
				const result = yield* Effect.result(
					client.RenameInstance({ instanceId: "personal", name: "Renamed" }),
				);
				expect(result).toMatchObject({
					_tag: "Left",
					left: {
						_tag: "AccountChangeRejected",
						id: "personal",
						reason: expect.stringContaining("daemon.json"),
					},
				});
				expect(readFileSync(join(configDir, "daemon.json"), "utf8")).toBe(
					invalid,
				);
				evidence.push({
					scenario:
						"failed persistence retains the invalid file and its typed RPC rejection",
				});
			}).pipe(Effect.provide(makeLayer())),
	);

	it.effect(
		"preserves the selected OpenCode runtime when renaming its account",
		() =>
			Effect.gen(function* () {
				const client = yield* makeClient;
				const manager = yield* InstanceManagerStateTag;
				const selectedUrl = "http://selected-opencode.invalid:49001";
				yield* Ref.update(manager, (state) => ({
					...state,
					instances: HashMap.modify(state.instances, "remote", (instance) => ({
						...instance,
						port: 49001,
						managed: false,
					})),
					externalUrls: HashMap.set(state.externalUrls, "remote", selectedUrl),
				}));
				let renamed = yield* client.RenameInstance({
					instanceId: "remote",
					name: "Selected external",
				});
				expect(
					renamed.instances.find((account) => account.id === "remote"),
				).toMatchObject({
					name: "Selected external",
					port: 49001,
					managed: false,
					url: selectedUrl,
				});
				expect(
					readSaved().instances?.find((account) => account.id === "remote"),
				).toMatchObject({
					name: "Selected external",
					port: 49001,
					managed: false,
					url: selectedUrl,
				});
				yield* seedManagedRuntime;
				renamed = yield* client.RenameInstance({
					instanceId: "remote",
					name: "Selected managed",
				});
				expect(
					renamed.instances.find((account) => account.id === "remote"),
				).toMatchObject({
					name: "Selected managed",
					port: fakeManagedRecord.port,
					managed: true,
					status: "healthy",
				});
				expect(
					readSaved().instances?.find((account) => account.id === "remote"),
				).toMatchObject({
					name: "Selected managed",
					managed: true,
					...fakeManagedRecord,
				});
				expect(stopManagedOpenCode).not.toHaveBeenCalled();
				evidence.push({
					scenario:
						"rename preserves selected external URL, runtime port and managed recovery identity",
					accounts: ["remote"],
				});
			}).pipe(Effect.provide(makeLayer())),
	);

	it.effect(
		"retains the account and recovery record after a failed remove, then accepts a retry",
		() =>
			Effect.gen(function* () {
				const client = yield* makeClient;
				yield* seedManagedRuntime;
				yield* client.RenameInstance({
					instanceId: "remote",
					name: "Active Remote",
				});
				const savedBefore = readSaved().instances?.find(
					(account) => account.id === "remote",
				);
				expect(savedBefore).toMatchObject({
					driver: "opencode",
					managed: true,
					...fakeManagedRecord,
				});
				vi.mocked(stopManagedOpenCode).mockResolvedValue(false);
				const mutate = client.RemoveInstance({ instanceId: "remote" });
				expect(yield* Effect.result(mutate)).toMatchObject({
					_tag: "Left",
					left: {
						_tag: "AccountChangeRejected",
						id: "remote",
						reason: expect.stringContaining("ownership"),
					},
				});
				expect(
					(yield* client.GetInstances({})).instances.find(
						(account) => account.id === "remote",
					),
				).toMatchObject({
					name: "Active Remote",
					driver: "opencode",
					port: fakeManagedRecord.port,
					managed: true,
					status: "healthy",
				});
				expect(
					yield* (yield* AccountDirectory).resolve({
						_tag: "Id",
						id: "remote",
					}),
				).toMatchObject({ id: "remote", driver: "opencode" });
				// An unrelated successful mutation must still persist the rejected
				// account's complete recovery record, allowing another stop attempt.
				yield* client.RenameInstance({
					instanceId: "personal",
					name: "Personal refreshed",
				});
				expect(
					readSaved().instances?.find((account) => account.id === "remote"),
				).toEqual(savedBefore);
				vi.mocked(stopManagedOpenCode).mockResolvedValue(true);
				const retried = yield* mutate;
				expect(stopManagedOpenCode).toHaveBeenLastCalledWith(
					expect.objectContaining({
						pid: fakeManagedRecord.pid,
						processIdentity: fakeManagedRecord.processIdentity,
					}),
				);
				const savedAfter = readSaved().instances?.find(
					(account) => account.id === "remote",
				);
				expect(
					retried.instances.some((account) => account.id === "remote"),
				).toBe(false);
				expect(savedAfter).toBeUndefined();
				evidence.push({
					scenario:
						"failed remove preserves account and recovery metadata; confirmed retry succeeds",
					accounts: ["remote"],
				});
			}).pipe(Effect.provide(makeLayer())),
	);
});
