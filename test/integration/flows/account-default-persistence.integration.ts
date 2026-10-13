/*
 * Persistence failure modes, through daemon RPC and the real config writer:
 * - A default change or deleted-account record is lost across runtime restart.
 * - Missing, dangling or wrong-driver pointers ignore usage order or remain on disk.
 * - A save changes the former built-in account's folder to the new default's folder.
 * - A removed id is reused after restart, capturing that account's old sessions.
 * - Removing the default promotes by insertion/name rather than usage order.
 * - Removing the last Claude account routes to OpenCode or is undone on restart.
 * - Adding after an empty state fails to establish a new default.
 * - A second migration rewrites an already materialised current-version config.
 * HOME, launch login and all config reads belong to a temporary fixture.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { Effect, Either, Layer, ManagedRuntime } from "effect";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import {
	GetInstances,
	RemoveInstance,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { accountsStateFromConfig } from "../../../src/lib/daemon/account-directory.js";
import {
	type DaemonConfig,
	defaultDaemonConfig,
	loadDaemonConfigResult,
	loadDaemonConfigStartupResult,
	migrateDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	ConfigPersistenceLive,
	ConfigSnapshotFromEffectStateLive,
	makeConfigWriterLive,
} from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import { startForegroundDaemon } from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { makeRoutedWsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

let root: string;
let configDir: string;
let initial: DaemonConfig;
const evidence: Array<{
	scenario: string;
	defaultId?: string | undefined;
	deletedIds?: string[] | undefined;
}> = [];
const artifact = "test-results/g4zp-15-account-persistence.json";

beforeAll(() => rmSync(artifact, { force: true }));
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "g4zp-15-persistence-"));
	configDir = join(root, "conduit");
	mkdirSync(join(root, "home"));
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "ambient-login"));
	vi.stubEnv("CONDUIT_CONFIG_DIR", configDir);
	initial = {
		...defaultDaemonConfig(),
		usageLimits: {
			autoResume: false,
			autoSwitch: false,
			warnAt: 80,
			order: ["remote", "work", "personal", "claude"],
		},
		instances: [
			{
				id: "claude",
				name: "Claude",
				configDir: join(root, "original-login"),
				driver: "claude",
				port: 0,
				managed: false,
			},
			{
				id: "personal",
				name: "Personal",
				driver: "claude",
				configDir: join(root, "personal-login"),
				port: 0,
				managed: false,
			},
			{
				id: "work",
				name: "Work",
				driver: "claude",
				configDir: join(root, "work-login"),
				port: 0,
				managed: false,
			},
			{
				id: "remote",
				name: "Remote",
				driver: "opencode",
				url: "http://opencode.invalid:49001",
				port: 49001,
				managed: false,
			},
		],
	};
	await saveDaemonConfig(initial, configDir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
	if (evidence.length !== 6) return;
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		artifact,
		`${JSON.stringify({ ticket: "conduit-test-g4zp.15", cases: evidence }, null, 2)}\n`,
	);
});

const readSaved = () =>
	Either.getOrThrowWith(loadDaemonConfigResult(configDir), (error) => error);
const makeLayer = (config: DaemonConfig) => {
	const launchLogin = configuredClaudeConfigDir(join(root, "captured-login"));
	return makeDaemonRpcTestLayer([], undefined, {
		configDir,
		launchLogin,
		instances: config.instances ?? [],
		accountsState: accountsStateFromConfig(config, launchLogin),
		config: {
			...(config.usageLimits === undefined
				? {}
				: { usageLimits: config.usageLimits }),
		},
		persistence: ConfigPersistenceLive.pipe(
			Layer.provide(
				Layer.merge(
					ConfigSnapshotFromEffectStateLive,
					makeConfigWriterLive(configDir),
				),
			),
		),
	});
};
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

describe("account defaults and deletions survive persistence", () => {
	it("retains the pointer and deleted records through foreground daemon stop and startup", async () => {
		writeFileSync(
			join(configDir, "daemon.json"),
			JSON.stringify({
				...initial,
				accountDefaults: { claude: "personal" },
				deletedAccounts: [{ id: "work", driver: "claude" }],
				instances: initial.instances?.filter(
					(account) => account.id !== "work",
				),
			}),
		);
		const staticDir = join(root, "static");
		mkdirSync(staticDir);
		writeFileSync(join(staticDir, "index.html"), "<html>fixture</html>");
		const socketPath = join(root, "relay.sock");
		for (let start = 0; start < 2; start++) {
			const daemon = await startForegroundDaemon({
				port: 0,
				configDir,
				socketPath,
				staticDir,
				tlsEnabled: false,
				smartDefault: false,
				logLevel: "error",
				logFormat: "json",
			});
			try {
				if (start === 0)
					await sendRpcRequest(
						socketPath,
						new RemoveInstance({ instanceId: "claude" }),
					);
				const rows = (await sendRpcRequest(socketPath, new GetInstances({})))
					.instances;
				expect(
					rows
						.filter(
							(account) => account.driver === "claude" && account.isDefault,
						)
						.map((account) => account.id),
				).toEqual(["personal"]);
				expect(
					rows.find((account) => account.id === "personal")?.configDir,
				).toBe(join(root, "personal-login"));
				expect(rows.some((account) => account.id === "claude")).toBe(false);
				expect(rows.some((account) => account.id === "work")).toBe(false);
			} finally {
				await daemon.stop();
			}
			expect(readSaved().accountDefaults).toEqual({ claude: "personal" });
			expect(readSaved().deletedAccounts).toEqual([
				{ id: "work", driver: "claude" },
				{ id: "claude", driver: "claude" },
			]);
		}
		evidence.push({
			scenario:
				"former built-in removed over IPC stays deleted after foreground daemon restart",
			defaultId: "personal",
			deletedIds: ["work", "claude"],
		});
	});

	it("promotes in usage order and restores a default after the last account is removed", async () => {
		const config: DaemonConfig = {
			...initial,
			accountDefaults: { claude: AccountIdSchema.make("claude") },
			instances: [
				...(initial.instances ?? []).filter(
					(account) => account.driver === "claude",
				),
				{
					id: "alpha",
					name: "Alpha",
					driver: "claude",
					port: 0,
					managed: false,
				},
			],
			usageLimits: {
				autoResume: false,
				autoSwitch: false,
				warnAt: 80,
				order: ["opencode", "work", "alpha", "personal", "claude"],
			},
		};
		await saveDaemonConfig(config, configDir);
		const runtime = ManagedRuntime.make(makeLayer(readSaved()));
		try {
			await runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* makeClient;
						const directory = yield* AccountDirectory;
						const removed = yield* client.RemoveInstance({
							instanceId: "claude",
						});
						const survivors = removed.instances.filter(
							(account) => account.driver === "claude",
						);
						expect(survivors.map(({ id }) => id)).toEqual([
							"personal",
							"work",
							"alpha",
						]);
						expect(
							[...survivors]
								.sort((a, b) => a.name.localeCompare(b.name))
								.map(({ id }) => id),
						).toEqual(["alpha", "personal", "work"]);
						expect(
							survivors
								.filter(({ isDefault }) => isDefault)
								.map(({ id }) => id),
						).toEqual(["work"]);
						expect(
							(yield* directory.resolve({ _tag: "Id", id: "claude" })).id,
						).toBe("work");
						for (const instanceId of ["personal", "work", "alpha"])
							yield* client.RemoveInstance({ instanceId });
						expect(
							(yield* client.GetInstances({})).instances.filter(
								({ driver }) => driver === "claude",
							),
						).toEqual([]);
						expect(
							yield* Effect.either(
								directory.resolve({ _tag: "DriverDefault", driver: "claude" }),
							),
						).toMatchObject({
							_tag: "Left",
							left: { _tag: "AccountUnroutable" },
						});
						expect(
							(yield* directory.resolve({
								_tag: "DriverDefault",
								driver: "opencode",
							})).driver,
						).toBe("opencode");
					}),
				),
			);
		} finally {
			await runtime.dispose();
		}
		const empty = readSaved();
		expect(empty.accountDefaults).toEqual({});
		expect(empty.deletedAccounts?.map(({ id }) => id)).toEqual([
			"claude",
			"personal",
			"work",
			"alpha",
		]);
		const restarted = ManagedRuntime.make(makeLayer(empty));
		try {
			await restarted.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* makeClient;
						const directory = yield* AccountDirectory;
						expect(
							(yield* client.GetInstances({})).instances.filter(
								({ driver }) => driver === "claude",
							),
						).toEqual([]);
						const added = yield* client.AddInstance({
							name: "Alpha",
							driver: "claude",
						});
						expect(added.addedInstanceId).toBe("alpha-2");
						expect(
							added.instances
								.filter(
									({ driver, isDefault }) => driver === "claude" && isDefault,
								)
								.map(({ id }) => id),
						).toEqual(["alpha-2"]);
						for (const id of ["claude", "personal", "work", "alpha"])
							expect((yield* directory.resolve({ _tag: "Id", id })).id).toBe(
								"alpha-2",
							);
					}),
				),
			);
		} finally {
			await restarted.dispose();
		}
		evidence.push({
			scenario:
				"usage order beats insertion and name; zero accounts survives restart; new default skips tombstones",
			defaultId: readSaved().accountDefaults?.claude,
			deletedIds: empty.deletedAccounts?.map(({ id }) => id),
		});
	});

	it("round-trips a selected default and deleted account through a fresh daemon runtime", async () => {
		const runtime = ManagedRuntime.make(makeLayer(readSaved()));
		try {
			await runtime.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* makeClient;
						const directory = yield* AccountDirectory;
						yield* directory.apply({ _tag: "SetDefault", id: "personal" });
						const persistence = yield* ConfigPersistenceTag;
						yield* persistence.requestSave;
						yield* persistence.flush;
						yield* client.RemoveInstance({ instanceId: "work" });
						expect(
							(yield* directory.resolve({ _tag: "Id", id: "work" })).id,
						).toBe("personal");
					}),
				),
			);
		} finally {
			await runtime.dispose();
		}
		const saved = readSaved();
		expect(saved.accountDefaults).toEqual({ claude: "personal" });
		expect(saved.deletedAccounts).toContainEqual({
			id: "work",
			driver: "claude",
		});
		expect(saved.instances?.some((account) => account.id === "work")).toBe(
			false,
		);
		expect(saved.instances?.find(({ id }) => id === "claude")?.configDir).toBe(
			join(root, "original-login"),
		);
		const restarted = ManagedRuntime.make(makeLayer(saved));
		try {
			await restarted.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* makeClient;
						const directory = yield* AccountDirectory;
						expect(
							(yield* directory.resolve({
								_tag: "DriverDefault",
								driver: "claude",
							})).id,
						).toBe("personal");
						expect(
							yield* directory.resolve({ _tag: "Id", id: "work" }),
						).toMatchObject({
							id: "personal",
							folder: configuredClaudeConfigDir(join(root, "personal-login")),
						});
						expect(
							yield* directory.resolve({ _tag: "Id", id: "claude" }),
						).toMatchObject({
							folder: configuredClaudeConfigDir(join(root, "original-login")),
						});
						const added = yield* client.AddInstance({
							name: "Work",
							driver: "claude",
						});
						expect(added.addedInstanceId).toBe("work-2");
						expect(
							(yield* directory.resolve({ _tag: "Id", id: "work" })).id,
						).toBe("personal");
					}),
				),
			);
		} finally {
			await restarted.dispose();
		}
		evidence.push({
			scenario: "restart retains default, deleted routing and allocation",
			defaultId: saved.accountDefaults?.claude,
			deletedIds: saved.deletedAccounts?.map((record) => record.id),
		});
	});

	it.each([
		undefined,
		"missing",
		"remote",
	])("materialises and saves a current-version pointer %s once", async (pointer) => {
		const path = join(configDir, "daemon.json");
		writeFileSync(
			path,
			JSON.stringify({
				...initial,
				accountDefaults: pointer === undefined ? {} : { claude: pointer },
				deletedAccounts: [{ id: "retired", driver: "claude" }],
			}),
		);
		const startup = Either.getOrThrowWith(
			loadDaemonConfigStartupResult(configDir),
			(error) => error,
		);
		const loaded = startup.config;
		expect(loaded.accountDefaults).toEqual({ claude: "work" });
		expect(startup.needsMigration).toBe(true);
		await Effect.runPromise(
			migrateDaemonConfig(loaded, configDir, startup.needsMigration),
		);
		const persisted: unknown = JSON.parse(readFileSync(path, "utf8"));
		expect(persisted).toMatchObject({
			accountDefaults: { claude: "work" },
			deletedAccounts: [{ id: "retired", driver: "claude" }],
		});
		const inode = statSync(path).ino;
		const nextStartup = Either.getOrThrowWith(
			loadDaemonConfigStartupResult(configDir),
			(error) => error,
		);
		expect(nextStartup.needsMigration).toBe(false);
		await Effect.runPromise(
			migrateDaemonConfig(
				nextStartup.config,
				configDir,
				nextStartup.needsMigration,
			),
		);
		expect(statSync(path).ino).toBe(inode);
		const runtime = ManagedRuntime.make(makeLayer(readSaved()));
		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					const directory = yield* AccountDirectory;
					expect(
						(yield* directory.resolve({ _tag: "Id", id: "retired" })).id,
					).toBe("work");
					expect(
						(yield* directory.resolve({
							_tag: "DriverDefault",
							driver: "claude",
						})).id,
					).toBe("work");
				}),
			);
		} finally {
			await runtime.dispose();
		}
		evidence.push({
			scenario: `materialised ${pointer ?? "missing"} pointer`,
			defaultId: loaded.accountDefaults?.claude,
		});
	});
});
