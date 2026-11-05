import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePath } from "@effect/platform-node";
import {
	type Context,
	Effect,
	Layer,
	ManagedRuntime,
	Ref,
	Result,
} from "effect";
import { loadDaemonConfigStartupResult } from "../../src/lib/daemon/config-persistence.js";
import {
	type SendRPC,
	sendRpcRequest,
} from "../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import {
	type DaemonLiveOptions,
	makeDaemonLive,
} from "../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { AccountDirectory } from "../../src/lib/domain/daemon/Services/account-directory.js";
import {
	DaemonConfigRefTag,
	makeDaemonConfigFromOptions,
} from "../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonOrchestration } from "../../src/lib/domain/daemon/Services/daemon-orchestration.js";
import { OpenCodeInstancesTag } from "../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	addWithoutRelay,
	startRelay,
} from "../../src/lib/domain/daemon/Services/project-registry-service.js";
import { RelayCacheTag } from "../../src/lib/domain/daemon/Services/relay-cache.js";
import { EventRetentionTag } from "../../src/lib/domain/persistence/Services/event-retention.js";
import { verifyReplayParity } from "../../src/lib/persistence/replay-parity.js";
import { sdkDefaultClaudeConfigDir } from "../../src/lib/provider/claude/claude-sdk-env.js";
import type { createProjectRelayLayers } from "../../src/lib/relay/project-relay-layers.js";
import type { ClaudeSdkSeam } from "../../src/lib/types.js";
import type { OpenCodeRecording } from "../e2e/fixtures/recorded/types.js";
import {
	captureExistingChildren,
	stopDaemonAndAssertNoSurvivors,
} from "../e2e/helpers/daemon-survivors.js";
import { loadOpenCodeRecording } from "../e2e/helpers/recorded-loader.js";
import { TestWsClient } from "../integration/helpers/test-ws-client.js";
import { claudeSdk as fakeClaudeSdk } from "./fake-claude-process-sdk.js";
import { MockOpenCodeServer } from "./mock-opencode-server.js";

/** Sequential tests only: foreground startup changes process-wide logging. */
export function createInProcessDaemon() {
	const existingChildren = captureExistingChildren();
	// Keep Unix socket paths short, including on macOS.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ipd-")));
	const configDir = join(root, "config");
	const projectDir = join(root, "process-test");
	const socketPath = join(root, "relay.sock");
	let daemon: ForegroundDaemonHandle | undefined;
	try {
		for (const directory of [configDir, projectDir, join(root, "static")])
			mkdirSync(directory);
		execFileSync("git", ["-C", projectDir, "init", "-b", "main"], {
			stdio: "pipe",
		});
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}

	const rpc: SendRPC = (request) =>
		sendRpcRequest(socketPath, request, { startupRetries: 0 });
	const stop = async () => {
		if (!daemon) return;
		await stopDaemonAndAssertNoSurvivors(async () => {
			await daemon?.stop();
			daemon = undefined;
		}, existingChildren);
	};

	return {
		root,
		configDir,
		projectDir,
		rpc,
		get port() {
			if (!daemon) throw new Error("Daemon is not running");
			return daemon.port;
		},
		stop,
		/** First start or full disposal/reopen, retaining only the fixture files. */
		async restart() {
			await stop();
			daemon = await startForegroundDaemon({
				configDir,
				socketPath,
				port: 0,
				host: "127.0.0.1",
				staticDir: join(root, "static"),
				claudeConfigDir: join(root, "claude"),
				opencodeUrl: "http://127.0.0.1:0",
				smartDefault: false,
				keepAwake: false,
				logLevel: "error",
			});
		},
		async dispose() {
			try {
				await stop();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
}

const makeDaemonRuntime = (options: Parameters<typeof makeDaemonLive>[0]) =>
	ManagedRuntime.make(
		makeDaemonLive(options).pipe(Layer.provide(NodePath.layer)),
	);
type DaemonRuntime = ReturnType<typeof makeDaemonRuntime>;
type DaemonServices = ManagedRuntime.ManagedRuntime.Services<DaemonRuntime>;
/** Everything the project's relay runtime provides, which RPC borrows. */
type ProjectServices = ManagedRuntime.ManagedRuntime.Services<
	ReturnType<typeof createProjectRelayLayers>["relayManagedRuntime"]
>;

export type DaemonProject = Awaited<ReturnType<typeof createDaemonProject>>;

/**
 * One project served by an in-process daemon, its OpenCode a recorded mock.
 * Browsers reach it over the daemon's `/rpc`; effects run on the daemon runtime.
 */
export async function createDaemonProject(
	recording: string | OpenCodeRecording = "chat-simple",
	options: {
		/** Holds daemon.json (accounts, named instances); a temp dir by default. */
		readonly configDir?: string;
		/** Default model ("provider/model"); null leaves the native default in control. */
		readonly defaultModel?: string | null;
		/** More settings.jsonc fields, as the daemon reads them at start. */
		readonly settings?: Readonly<Record<string, unknown>>;
		readonly claudeSdk?: ClaudeSdkSeam;
		readonly titleQuery?: ClaudeSdkSeam["titleQuery"];
		/** A real OpenCode server to use instead of the recording's mock. */
		readonly opencodeUrl?: string;
		readonly slug?: string;
		readonly projectDir?: string;
		readonly extraFolders?: readonly string[];
		/** Stands in for every OpenCode server (the recording's mock goes unused). */
		readonly openCodeInstances?: DaemonLiveOptions["openCodeInstances"];
		/** Stands in for shell environment capture and its readiness. */
		readonly shellEnv?: DaemonLiveOptions["shellEnv"];
	} = {},
) {
	const slug = options.slug ?? "integration-test";
	const mock = new MockOpenCodeServer(
		typeof recording === "string"
			? loadOpenCodeRecording(recording)
			: recording,
	);
	await mock.start();
	const root = realpathSync(mkdtempSync(join(tmpdir(), "dp-")));
	const configDir = options.configDir ?? join(root, "config");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "settings.jsonc"),
		JSON.stringify({
			...(options.defaultModel !== null && {
				defaultModel:
					options.defaultModel ?? "anthropic/claude-opus-4-5-20251101",
			}),
			...options.settings,
		}),
	);
	const loaded = loadDaemonConfigStartupResult(configDir);
	const sdk = options.claudeSdk ?? fakeClaudeSdk;
	const daemon = makeDaemonRuntime({
		configDir,
		socketPath: join(root, "d.sock"),
		staticDir: root,
		launchLogin: sdkDefaultClaudeConfigDir(join(root, "home", ".claude")),
		initialConfig: makeDaemonConfigFromOptions({
			port: 0,
			host: "127.0.0.1",
			tlsEnabled: false,
			hostExplicit: true,
		}),
		smartDefault: false,
		defaultOpencodeUrl: options.opencodeUrl ?? mock.url,
		...(Result.isSuccess(loaded) && {
			persistedConfig: loaded.success.config,
			persistedConfigNeedsMigration: loaded.success.needsMigration,
		}),
		// Stubbed session titles: no test makes a live title call.
		claudeSdk: { ...sdk, titleQuery: options.titleQuery ?? sdk.titleQuery },
		...(options.openCodeInstances && {
			openCodeInstances: options.openCodeInstances,
		}),
		...(options.shellEnv && { shellEnv: options.shellEnv }),
	});
	const clients: TestWsClient[] = [];
	const stop = async () => {
		for (const client of clients) await client.close().catch(() => {});
		await daemon.dispose();
		await mock.stop();
		rmSync(root, { recursive: true, force: true });
	};
	try {
		const { port, projectContext } = await daemon.runPromise(
			Effect.gen(function* () {
				yield* addWithoutRelay(
					{
						slug,
						title: slug,
						folders: [
							options.projectDir ?? process.cwd(),
							...(options.extraFolders ?? []),
						],
					},
					{ silent: true },
				).pipe(
					// A reused configDir is a restart: daemon.json already holds the project.
					Effect.catchTag("ProjectAlreadyExists", () => Effect.void),
				);
				yield* startRelay(slug);
				// Foreground startup starts the provider command outbox once its
				// projects are up; Stop's abort and probe effects run there.
				yield* (yield* DaemonOrchestration).start;
				// The daemon treats an external OpenCode as running only once it is
				// in use; the relay harness found each one live at start.
				const instances = yield* OpenCodeInstancesTag;
				yield* Effect.forEach(
					yield* (yield* AccountDirectory).list,
					(account) =>
						account.driver === "opencode" && !account.managed
							? Effect.scoped(instances.use(account.id)).pipe(Effect.ignore)
							: Effect.void,
					{ discard: true },
				);
				const relay = yield* Effect.flatMap(RelayCacheTag, (cache) =>
					cache.get(slug),
				);
				const context = relay.rpcWsHandler.context;
				if (!context) return yield* Effect.die("Project has no RPC context");
				return {
					port: (yield* Ref.get(yield* DaemonConfigRefTag)).port,
					// Until the relay retires (82tn.16 S6), the project's services
					// are its relay runtime's whole context, which RPC borrows.
					projectContext:
						(yield* context) as unknown as Context.Context<ProjectServices>,
				};
			}),
		);
		const run = <A, E>(
			effect: Effect.Effect<A, E, ProjectServices | DaemonServices>,
		) => daemon.runPromise(Effect.provide(effect, projectContext));
		return {
			slug,
			port,
			baseUrl: `http://127.0.0.1:${port}`,
			configDir,
			eventsDbPath: join(configDir, "events.db"),
			mock,
			daemon,
			run,
			/** The daemon's handle on the project relay (settle, archive, status). */
			relay: () =>
				daemon.runPromise(
					Effect.flatMap(RelayCacheTag, (cache) => cache.get(slug)),
				),
			async connectWsClient() {
				const client = new TestWsClient(`ws://127.0.0.1:${port}/rpc?p=${slug}`);
				clients.push(client);
				await client.waitForOpen();
				return client;
			},
			checkReplayParity: () =>
				Effect.runPromise(
					verifyReplayParity(join(configDir, "events.db"), {
						projectId: slug,
						// Provider reconciliation sets completion outside the event log;
						// replay clears it when rebuilding the read model.
						ignoredColumns: [
							"version",
							"session_sidebar.row.version",
							"sessions.history_complete",
							// A child's drained wake event need not survive its ancestor.
							// These read annotations are outside the log (ADR-0013).
							"sessions.woken_at",
							"sessions.woken_reason",
							"session_sidebar.row.snooze.woken_at",
							"session_sidebar.row.snooze.woken_reason",
						],
					}),
				),
			drainEventRetention: () =>
				run(Effect.flatMap(EventRetentionTag, (r) => r.drain())),
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}
