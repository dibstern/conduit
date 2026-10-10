import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Socket } from "@effect/platform";
import { RpcClient, type RpcGroup, RpcSerialization } from "@effect/rpc";
import {
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	ManagedRuntime,
	Stream,
} from "effect";
import WebSocket from "ws";
import {
	defaultInstanceIdForDriver,
	type ProviderDriverKind,
	ProviderInstanceIdSchema,
} from "../../src/lib/contracts/provider-instance.js";
import {
	GetInstances,
	GetStatus,
	type PtyEnvelope,
	Shutdown,
	WsRpcGroup,
} from "../../src/lib/contracts/ws-rpc.js";
import {
	type DaemonConfig,
	loadDaemonConfig,
} from "../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../src/lib/daemon/daemon-rpc-client.js";
import {
	inspectManagedOpenCodeProcess,
	isProcessAlive,
	type ManagedOpenCodeRecord,
	stopManagedOpenCode,
} from "../../src/lib/instance/managed-opencode-process.js";
import { projectStorageDir } from "../../src/lib/persistence/project-storage.js";
import type {
	ModelInfo,
	ProviderAgentInfo,
} from "../../src/lib/provider/types.js";
import type { PtyInfo } from "../../src/lib/shared-types.js";
import { stopPtyHost } from "../../src/lib/terminal/pty-host-client.js";
import { isRecord } from "../../src/lib/utils.js";
import type { ClaudeTraceName } from "../e2e/helpers/claude-trace-replayer.js";
import { loadOpenCodeRecording } from "../e2e/helpers/recorded-loader.js";
import {
	cleanupTestClaudeRunners,
	testRunnerAlive,
} from "./claude-runner-cleanup.js";
import { type ProcessMark, responseChunks } from "./fake-claude-process-sdk.js";
import { MockOpenCodeServer } from "./mock-opencode-server.js";

export { responseChunks };

const TIMEOUT_MS = 15_000;

class BrowserRpc extends Context.Tag("ProcessHarnessBrowserRpc")<
	BrowserRpc,
	RpcClient.RpcClient<
		RpcGroup.Rpcs<typeof WsRpcGroup>,
		import("@effect/rpc/RpcClientError").RpcClientError
	>
>() {}

function browserRpcRuntime(
	port: number,
	onDisconnect?: (error: Error) => void,
) {
	const protocol = RpcClient.layerProtocolSocket().pipe(
		Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
		Layer.provide(
			Layer.succeed(Socket.WebSocketConstructor, (url) => {
				const socket = new WebSocket(url);
				socket.once("error", (error) => onDisconnect?.(error));
				socket.once("close", () =>
					onDisconnect?.(new Error("Browser RPC socket closed")),
				);
				return socket as unknown as globalThis.WebSocket;
			}),
		),
		Layer.provide(RpcSerialization.layerJson),
	);
	return ManagedRuntime.make(
		Layer.scoped(BrowserRpc, RpcClient.make(WsRpcGroup)).pipe(
			Layer.provide(protocol),
		),
	);
}

interface Generation {
	pid: number;
	port: number;
	projects: string[];
	instances: Array<{ managed: boolean; url?: string }>;
	signal?: NodeJS.Signals | null;
	exitCode?: number | null;
	fakeSdkActive?: boolean;
}

export interface BrowserFrame {
	message: Record<string, unknown>;
	at: bigint;
}

/** The SubscribePtys envelope a `{ type: "pty" }` frame records, if any. */
export function ptyEnvelope(
	message: Record<string, unknown>,
): PtyEnvelope | undefined {
	return message["type"] === "pty"
		? (message as unknown as PtyEnvelope)
		: undefined;
}

export class ProcessHarness {
	readonly root: string;
	readonly projectDir: string;
	readonly configDir: string;
	readonly marks: ProcessMark[] = [];
	readonly generations: Generation[] = [];
	readonly browsers: ProcessBrowser[] = [];
	readonly cliPids: number[] = [];
	private child: ChildProcess | undefined;
	private exit: Promise<void> | undefined;
	private logs = "";
	private port = 0;
	private disposed = false;
	private environment: NodeJS.ProcessEnv = {};
	private defaultOpenCode: Server | undefined;
	private defaultOpenCodeUrl = "http://127.0.0.1:0";
	private opencodeIdleTimeoutMs: number | undefined;
	private recordedOpenCode: MockOpenCodeServer | undefined;
	private readonly ownedOpenCode = new Map<string, ManagedOpenCodeRecord>();
	private readonly ownedOpenCodeProcesses = new Map<string, Set<number>>();
	private readonly observedOpenCodeProcesses = new Set<number>();
	private readonly ownershipErrors: unknown[] = [];
	private readonly ownershipObserver: ReturnType<typeof setInterval>;
	private readonly managedCleanup: Array<{
		supervisorPid: number;
		controlAuthenticated: boolean;
		stopAccepted: boolean;
		pids: number[];
		remainingPids: number[];
	}> = [];
	private runnerCleanup:
		| Awaited<ReturnType<typeof cleanupTestClaudeRunners>>
		| undefined;

	private constructor(
		private readonly dist?: string,
		private readonly enqueueMarkDelayMs = 0,
		private readonly realSdk = false,
		private readonly shellEnvProof = false,
		private readonly managedOpenCode = false,
		ignoreOpenCodeSigterm = false,
		pauseOpenCodeSupervisor = false,
		private readonly runnerLifecycle?: {
			helloDelayMs?: number;
			idleExitDelayMs?: number;
			idleDayMs?: number;
			nonDefaultConfigDir?: boolean;
			idleTimeoutMs?: number | null;
			failureCleanupDelayMs?: number;
			serverProtocolVersion?: number;
			runnerHelloProtocolVersion?: number;
		},
		private readonly queryInitializationDelayMs = 0,
		private readonly queryInitializationFailures = 0,
		private readonly blockCapabilitiesProbe = false,
		capabilityModels?: readonly ModelInfo[],
		private readonly restartProof = false,
		private readonly holdRunnerAck = false,
		private readonly holdRunnerOutput?:
			| "permission-request"
			| "answer-permission"
			| "send-turn",
		private buildId?: string,
		private readonly upgradeSinkProof = false,
		private readonly subagentPollTimeoutMs?: number,
		rootPrefix = "/tmp/conduit-process-",
		private readonly foregroundCli = false,
		private readonly autoStartOpenCode = false,
		private readonly opencodeRecording?: string,
		private readonly claudeReplay?: {
			readonly turns: readonly ClaudeTraceName[];
			readonly delayMs?: number;
		},
		private readonly claudeCaptureDir?: string,
		realOpenCode?: string,
		capabilityAgents?: readonly ProviderAgentInfo[],
		private continuationSweepIntervalMs?: number,
	) {
		this.root = realpathSync(mkdtempSync(rootPrefix));
		this.projectDir = join(this.root, "process-test");
		this.configDir = join(
			this.root,
			runnerLifecycle?.nonDefaultConfigDir ? "active-config" : "config",
		);
		for (const directory of [
			"home",
			"config",
			"claude",
			"process-test",
			"cache",
			"static",
			"data",
			"active-config",
		]) {
			mkdirSync(join(this.root, directory));
		}
		// macOS resolves the login Keychain under HOME, so an isolated HOME hides
		// the Claude login. Link only the Keychains dir for real-SDK runs.
		if (realSdk && process.platform === "darwin") {
			mkdirSync(join(this.root, "home", "Library"));
			symlinkSync(
				join(homedir(), "Library", "Keychains"),
				join(this.root, "home", "Library", "Keychains"),
			);
		}
		if (blockCapabilitiesProbe)
			writeFileSync(join(this.root, "capabilities-probe-gated"), "hold");
		if (capabilityModels || capabilityAgents)
			writeFileSync(
				join(this.root, "capabilities-probe-result.json"),
				JSON.stringify({
					models: capabilityModels ?? [],
					agents: capabilityAgents ?? [],
					commands: [],
				}),
			);
		if (shellEnvProof)
			writeFileSync(
				join(this.root, "home/.zprofile"),
				'export CONDUIT_ENV_PROOF=server-cache\nexport ANTHROPIC_API_KEY=must-remove\nexport ANTHROPIC_MODEL=must-remove\nexport PATH="/tmp/conduit-cached-env-bin:$PATH"\n',
			);
		if (foregroundCli && !dist)
			throw new Error("Foreground CLI coverage requires a build");
		if (managedOpenCode || foregroundCli) {
			mkdirSync(join(this.root, "bin"));
			const executable = join(this.root, "bin", "opencode");
			copyFileSync(
				fileURLToPath(
					new URL(
						realOpenCode
							? "./real-opencode-proxy.mjs"
							: "./fake-opencode-process.mjs",
						import.meta.url,
					),
				),
				executable,
			);
			chmodSync(executable, 0o755);
			if (realOpenCode)
				symlinkSync(realOpenCode, join(this.root, "bin", "opencode-real"));
			const config: DaemonConfig = {
				pid: 0,
				port: 0,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
				projects: foregroundCli
					? [
							{
								path: this.projectDir,
								folders: [this.projectDir],
								slug: "process-test",
								addedAt: Date.now(),
							},
						]
					: [],
				...(managedOpenCode
					? {
							instances: [
								{
									id: "managed-test",
									name: "Managed test",
									port: 0,
									managed: true,
									driver: "opencode",
									env: {
										OPENCODE_SERVER_USERNAME: "test-user",
										CONDUIT_TEST_OPENCODE_IGNORE_SIGTERM: String(
											ignoreOpenCodeSigterm,
										),
										CONDUIT_TEST_OPENCODE_PAUSE_SUPERVISOR: String(
											pauseOpenCodeSupervisor,
										),
									},
								},
							],
						}
					: {}),
			};
			writeFileSync(
				join(this.configDir, "daemon.json"),
				JSON.stringify(config),
			);
		}
		writeFileSync(
			join(this.root, "runner-identity-fixture.mjs"),
			`import childProcess from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const root = ${JSON.stringify(this.root)};
if (process.env.HOME !== join(root, "home")) throw new Error("Runner identity fixture requires isolated HOME");
if (/claude-session-runner\\.(js|ts)$/.test(process.argv[1] ?? "")) {
  writeFileSync(join(root, "runner-argv-" + process.pid + ".json"), JSON.stringify(process.argv));
}
const executeFile = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
  try { return executeFile(command, args, options); }
  catch (cause) {
    if (command !== "ps" || !Array.isArray(args) || !args.includes("command=") || cause.code !== "EPERM") throw cause;
    const path = join(root, "runner-argv-" + args.at(-1) + ".json");
    if (!existsSync(path)) throw cause;
    return process.execPath + " " + JSON.parse(readFileSync(path, "utf8")).slice(1).join(" ");
  }
};
syncBuiltinESMExports();\n`,
		);
		if (foregroundCli && dist) {
			writeFileSync(
				join(this.root, "cli-fixture.mjs"),
				`import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { Effect } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("effect")).href)};
import { ClaudeDriver } from ${JSON.stringify(pathToFileURL(join(dist, "src/lib/provider/claude/claude-provider-instance.js")).href)};
const root = ${JSON.stringify(this.root)};
if (process.env.HOME !== join(root, "home") || !process.send) throw new Error("CLI fixture requires isolated HOME and IPC");
const identitySaveGate = join(root, "managed-identity-save-gated");
const signalSaveGate = join(root, "signal-config-rename-gated");
const rename = fsPromises.rename;
fsPromises.rename = async (source, destination) => {
  if (destination === ${JSON.stringify(join(this.configDir, "daemon.json"))} && (existsSync(identitySaveGate) || existsSync(signalSaveGate))) {
    const pending = JSON.parse(readFileSync(source, "utf8"));
    if (existsSync(identitySaveGate) && pending.instances?.some(instance => instance.processIdentity)) {
      writeFileSync(identitySaveGate + "-started", "identity has not been persisted");
      while (!existsSync(identitySaveGate + "-release")) await new Promise(done => setTimeout(done, 10));
    }
    if (existsSync(signalSaveGate) && existsSync(join(root, "sigint-observed"))) {
      writeFileSync(signalSaveGate + "-started", JSON.stringify({ signalObserved: true, projects: pending.projects.map(project => project.slug) }));
      while (!existsSync(signalSaveGate + "-release")) await new Promise(done => setTimeout(done, 10));
    }
  }
  return rename(source, destination);
};
syncBuiltinESMExports();
process.on("SIGINT", () => writeFileSync(join(root, "sigint-observed"), "observed"));
const create = ClaudeDriver.create;
const waitForGate = (gate, workspaceRoot) => Effect.promise(async () => {
  if (existsSync(gate)) {
    writeFileSync(gate + "-started", workspaceRoot);
    while (!existsSync(gate + "-release")) await new Promise(done => setTimeout(done, 10));
  }
});
Object.assign(ClaudeDriver, { create: deps => {
  const projectGate = join(deps.workspaceRoot, ".conduit", "recovery-gated");
  const gate = existsSync(projectGate) ? projectGate : join(root, "capabilities-probe-gated");
  return waitForGate(gate, deps.workspaceRoot).pipe(
    Effect.zipRight(create({ ...deps, capabilitiesService: { get: () => Effect.succeed(
      existsSync(join(root, "capabilities-probe-result.json"))
        ? JSON.parse(readFileSync(join(root, "capabilities-probe-result.json"), "utf8"))
        : { models: [], agents: [], commands: [] }
    ) } })),
    Effect.map(instance => {
      const recover = instance.recoverEffect.bind(instance);
      Object.assign(instance, { recoverEffect: () => {
        const failureGate = join(deps.workspaceRoot, ".conduit", "recovery-fail-after-adoption");
        return recover().pipe(
          Effect.zipRight(waitForGate(failureGate, deps.workspaceRoot)),
          Effect.tap(() => Effect.sync(() => {
            if (!existsSync(failureGate)) return;
            writeFileSync(failureGate + "-failed", "original recovery completed before fixture failure");
            throw new Error("fixture recovery failed after authenticated runner adoption");
          }))
        );
      } });
      return instance;
    })
  );
} });
`,
			);
		}
		this.ownershipObserver = setInterval(() => {
			try {
				this.rememberManagedOpenCode();
			} catch (cause) {
				this.ownershipErrors.push(cause);
			}
		}, 25);
		this.ownershipObserver.unref();
		this.rememberManagedOpenCode();
	}

	projectStorePath(slug = "process-test"): string {
		return join(projectStorageDir(this.configDir, slug), "events.db");
	}

	static create(
		options: {
			dist?: string;
			enqueueMarkDelayMs?: number;
			realSdk?: boolean;
			shellEnvProof?: boolean;
			managedOpenCode?: boolean;
			ignoreOpenCodeSigterm?: boolean;
			pauseOpenCodeSupervisor?: boolean;
			runnerLifecycle?: ProcessHarness["runnerLifecycle"];
			queryInitializationDelayMs?: number;
			queryInitializationFailures?: number;
			blockCapabilitiesProbe?: boolean;
			capabilityModels?: readonly ModelInfo[];
			capabilityAgents?: readonly ProviderAgentInfo[];
			restartProof?: boolean;
			continuationSweepIntervalMs?: number;
			holdRunnerAck?: boolean;
			holdRunnerOutput?:
				| "permission-request"
				| "answer-permission"
				| "send-turn";
			buildId?: string;
			upgradeSinkProof?: boolean;
			subagentPollTimeoutMs?: number;
			rootPrefix?: string;
			foregroundCli?: boolean;
			autoStartOpenCode?: boolean;
			opencodeRecording?: string;
			claudeReplay?: ProcessHarness["claudeReplay"];
			claudeCaptureDir?: string;
			/** Real OpenCode binary to run, behind a logging proxy, instead of the fake. */
			realOpenCode?: string;
		} = {},
	): ProcessHarness {
		return new ProcessHarness(
			(options.dist ?? process.env["CONDUIT_TEST_DIST"])
				? resolve(options.dist ?? process.env["CONDUIT_TEST_DIST"] ?? "dist")
				: undefined,
			options.enqueueMarkDelayMs,
			options.realSdk,
			options.shellEnvProof,
			options.managedOpenCode,
			options.ignoreOpenCodeSigterm,
			options.pauseOpenCodeSupervisor,
			options.runnerLifecycle,
			options.queryInitializationDelayMs,
			options.queryInitializationFailures,
			options.blockCapabilitiesProbe,
			options.capabilityModels,
			options.restartProof,
			options.holdRunnerAck,
			options.holdRunnerOutput,
			options.buildId,
			options.upgradeSinkProof,
			options.subagentPollTimeoutMs,
			options.rootPrefix,
			options.foregroundCli,
			options.autoStartOpenCode,
			options.opencodeRecording,
			options.claudeReplay,
			options.claudeCaptureDir,
			options.realOpenCode,
			options.capabilityAgents,
			options.continuationSweepIntervalMs,
		);
	}

	static async start(
		options: Parameters<typeof ProcessHarness.create>[0] = {},
	): Promise<ProcessHarness> {
		const harness = ProcessHarness.create(options);
		try {
			await harness.restart();
			return harness;
		} catch (error) {
			await harness.dispose();
			throw error;
		}
	}

	async restart(
		options: {
			skipBrowserProbe?: boolean;
			cliArgs?: string[];
			buildId?: string;
			queryInitializationDelayMs?: number;
			continuationSweepIntervalMs?: number;
			serviceEnvironment?: Partial<
				Pick<
					NodeJS.ProcessEnv,
					| "CONDUIT_SERVICE"
					| "CONDUIT_BUILD_READY_PATH"
					| "CONDUIT_SERVER_BUILD_ID"
					| "XPC_SERVICE_NAME"
				>
			>;
			/** An already-running OpenCode the default instance should point at. */
			opencodeUrl?: string;
			/** OpenCode idle grace, kept for later restarts. */
			opencodeIdleTimeoutMs?: number;
			/** Listen on the previous port, so open tabs reconnect by themselves. */
			keepPort?: boolean;
			/** Record event-loop stalls and read-model reads to this JSON file. */
			metricsFile?: string;
		} = {},
	): Promise<void> {
		if (this.disposed) throw new Error("Harness is disposed");
		if (this.child)
			throw new Error("Kill or stop the current child before restarting");
		this.buildId = options.buildId ?? this.buildId;
		this.continuationSweepIntervalMs =
			options.continuationSweepIntervalMs ?? this.continuationSweepIntervalMs;
		this.logs = "";
		if (options.opencodeUrl) this.defaultOpenCodeUrl = options.opencodeUrl;
		this.opencodeIdleTimeoutMs =
			options.opencodeIdleTimeoutMs ?? this.opencodeIdleTimeoutMs;
		if (this.opencodeRecording && !this.recordedOpenCode) {
			this.recordedOpenCode = new MockOpenCodeServer(
				loadOpenCodeRecording(this.opencodeRecording),
			);
			await this.recordedOpenCode.start();
			this.defaultOpenCodeUrl = this.recordedOpenCode.url;
		}
		const sdkModule = pathToFileURL(
			fileURLToPath(
				new URL(
					this.claudeReplay
						? "./replay-claude-process-sdk.ts"
						: this.realSdk
							? "./real-claude-process-sdk.ts"
							: "./fake-claude-process-sdk.ts",
					import.meta.url,
				),
			),
		).href;
		if (
			this.foregroundCli &&
			!this.autoStartOpenCode &&
			!this.defaultOpenCode &&
			!this.recordedOpenCode &&
			!options.opencodeUrl
		) {
			// Keep CLI smart-default discovery on a reachable, fixture-owned endpoint.
			const server = createHttpServer(async (request, response) => {
				const path = request.url?.split("?")[0];
				const gate = join(this.root, "opencode-path-gated");
				if (path === "/path" && existsSync(gate)) {
					writeFileSync(`${gate}-started`, request.url ?? "/path");
					while (!existsSync(`${gate}-release`) && !response.destroyed)
						await new Promise<void>((done) => setTimeout(done, 10));
					if (response.destroyed) return;
				}
				response.setHeader("Content-Type", "application/json");
				response.end(
					path === "/session"
						? "[]"
						: JSON.stringify({ healthy: true, version: "process-test" }),
				);
			});
			this.defaultOpenCode = server;
			await new Promise<void>((done, fail) => {
				server.once("error", fail);
				server.listen(0, "127.0.0.1", done);
			});
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("No isolated OpenCode placeholder port");
			this.defaultOpenCodeUrl = `http://127.0.0.1:${address.port}`;
			const config = loadDaemonConfig(this.configDir);
			if (!config) throw new Error("Invalid process harness seed config");
			writeFileSync(
				join(this.configDir, "daemon.json"),
				JSON.stringify({
					...config,
					instances: [
						{
							id: defaultInstanceIdForDriver("opencode"),
							name: "External test",
							port: address.port,
							managed: false,
							url: this.defaultOpenCodeUrl,
							driver: "opencode",
						},
						...(config.instances ?? []),
					],
				}),
			);
		}
		if (this.foregroundCli && this.port === 0) {
			this.port = await new Promise<number>((done, fail) => {
				const server = createServer();
				server.once("error", fail);
				server.listen(0, "127.0.0.1", () => {
					const address = server.address();
					if (!address || typeof address === "string") {
						server.close(() => fail(new Error("No isolated CLI port")));
						return;
					}
					server.close(() => done(address.port));
				});
			});
		}
		const child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
				"--import",
				pathToFileURL(join(this.root, "runner-identity-fixture.mjs")).href,
				...(this.foregroundCli
					? ["--import", pathToFileURL(join(this.root, "cli-fixture.mjs")).href]
					: []),
				...(this.foregroundCli && this.dist
					? [
							join(this.dist, "src/bin/cli.js"),
							...(options.cliArgs ?? ["serve"]),
							"--port",
							String(this.port),
							"--host",
							"127.0.0.1",
							"--no-https",
						]
					: [
							fileURLToPath(
								new URL("./process-harness-server.ts", import.meta.url),
							),
							this.root,
							...(this.dist ? [this.dist] : []),
						]),
			],
			{
				cwd: this.projectDir,
				env: (this.environment = {
					...options.serviceEnvironment,
					...(options.keepPort && this.port
						? { CONDUIT_TEST_PORT: String(this.port) }
						: {}),
					...(options.metricsFile
						? { CONDUIT_TEST_SERVER_METRICS: options.metricsFile }
						: {}),
					PATH:
						this.managedOpenCode || this.foregroundCli
							? `${join(this.root, "bin")}:${process.env["PATH"] ?? ""}`
							: (process.env["PATH"] ?? ""),
					HOME: join(this.root, "home"),
					SHELL: "/bin/sh",
					XDG_CONFIG_HOME: join(this.root, "config"),
					XDG_CACHE_HOME: join(this.root, "cache"),
					XDG_DATA_HOME: join(this.root, "data"),
					CONDUIT_CONFIG_DIR: join(this.root, "config"),
					CLAUDE_CONFIG_DIR: this.realSdk
						? (process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"))
						: join(this.root, "claude"),
					OPENCODE_URL: this.defaultOpenCodeUrl,
					...(this.opencodeRecording
						? { CONDUIT_TEST_OPENCODE_URL: this.defaultOpenCodeUrl }
						: {}),
					// An explicit config path must keep the login's original Keychain service.
					...(this.realSdk
						? {
								// Claude reads its Keychain login with USER as the account name.
								USER: userInfo().username,
								CLAUDE_SECURESTORAGE_CONFIG_DIR:
									process.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] ??
									process.env["CLAUDE_CONFIG_DIR"] ??
									"",
							}
						: {}),
					CONDUIT_TEST_CLAUDE_QUERY_MODULE: sdkModule,
					CONDUIT_TEST_CLAUDE_OPTIONS_FILE: join(
						this.root,
						"claude-options.jsonl",
					),
					...(this.claudeCaptureDir
						? { CONDUIT_CLAUDE_SDK_CAPTURE: this.claudeCaptureDir }
						: {}),
					...(this.claudeReplay
						? {
								CONDUIT_TEST_CLAUDE_REPLAY_TURNS: JSON.stringify(
									this.claudeReplay.turns,
								),
								CONDUIT_TEST_CLAUDE_REPLAY_DELAY_MS: String(
									this.claudeReplay.delayMs ?? 0,
								),
							}
						: {}),
					CONDUIT_TEST_ENQUEUE_MARK_DELAY_MS: String(this.enqueueMarkDelayMs),
					...Object.fromEntries(
						[
							[
								"CONDUIT_TEST_RUNNER_HELLO_DELAY_MS",
								this.runnerLifecycle?.helloDelayMs,
							],
							[
								"CONDUIT_TEST_RUNNER_IDLE_EXIT_DELAY_MS",
								this.runnerLifecycle?.idleExitDelayMs,
							],
							[
								"CONDUIT_TEST_RUNNER_IDLE_DAY_MS",
								this.runnerLifecycle?.idleDayMs,
							],
						]
							.filter(([, value]) => value !== undefined)
							.map(([key, value]) => [key, String(value)]),
					),
					...(this.runnerLifecycle?.nonDefaultConfigDir
						? {
								CONDUIT_TEST_DAEMON_CONFIG_DIR: this.configDir,
							}
						: {}),
					...(this.runnerLifecycle?.failureCleanupDelayMs !== undefined
						? {
								CONDUIT_TEST_RUNNER_FAILURE_DELAY_MS: String(
									this.runnerLifecycle.failureCleanupDelayMs,
								),
							}
						: {}),
					...(this.runnerLifecycle?.idleTimeoutMs !== undefined
						? {
								CONDUIT_TEST_RUNNER_IDLE_MS: String(
									this.runnerLifecycle.idleTimeoutMs,
								),
							}
						: {}),
					...(this.runnerLifecycle?.serverProtocolVersion !== undefined
						? {
								CONDUIT_TEST_SERVER_PROTOCOL_VERSION: String(
									this.runnerLifecycle.serverProtocolVersion,
								),
							}
						: {}),
					...(this.runnerLifecycle?.runnerHelloProtocolVersion !== undefined
						? {
								CONDUIT_TEST_RUNNER_HELLO_VERSION: String(
									this.runnerLifecycle.runnerHelloProtocolVersion,
								),
							}
						: {}),
					...(this.opencodeIdleTimeoutMs !== undefined
						? {
								CONDUIT_OPENCODE_IDLE_TIMEOUT_MS: String(
									this.opencodeIdleTimeoutMs,
								),
							}
						: {}),
					CONDUIT_TEST_QUERY_INITIALIZATION_DELAY_MS: String(
						options.queryInitializationDelayMs ??
							this.queryInitializationDelayMs,
					),
					...(this.buildId ? { CONDUIT_TEST_BUILD_ID: this.buildId } : {}),
					...(this.upgradeSinkProof
						? { CONDUIT_TEST_UPGRADE_SINK_PROOF: "1" }
						: {}),
					...(this.subagentPollTimeoutMs !== undefined
						? {
								CONDUIT_TEST_SUBAGENT_POLL_TIMEOUT_MS: String(
									this.subagentPollTimeoutMs,
								),
							}
						: {}),
					CONDUIT_TEST_QUERY_INITIALIZATION_FAILURES: String(
						this.queryInitializationFailures,
					),
					...(this.restartProof
						? {
								CONDUIT_TEST_PROCESS_PROOF: join(this.root, "sdk-proof.ndjson"),
							}
						: {}),
					...(this.continuationSweepIntervalMs !== undefined
						? {
								CONDUIT_CONTINUATION_SWEEP_INTERVAL_MS: String(
									this.continuationSweepIntervalMs,
								),
							}
						: {}),
					...(this.holdRunnerAck
						? { CONDUIT_TEST_HOLD_RUNNER_ACK: "text.delta" }
						: {}),
					...(this.holdRunnerOutput && this.generations.length === 0
						? { CONDUIT_TEST_HOLD_RUNNER_OUTPUT: this.holdRunnerOutput }
						: {}),
					...(this.shellEnvProof
						? { SHELL: "/bin/zsh", ZDOTDIR: join(this.root, "home") }
						: {}),
					NODE_ENV: "test",
					LOG_LEVEL: "error",
				}),
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		this.child = child;
		child.stdout?.on("data", (data: Buffer) => {
			this.logs = (this.logs + data.toString()).slice(-8000);
		});
		child.stderr?.on("data", (data: Buffer) => {
			this.logs = (this.logs + data.toString()).slice(-8000);
		});
		let generation: Generation | undefined;
		let fakeSdkActive = false;
		this.exit = new Promise<void>((done) => {
			child.once("exit", (exitCode, signal) => {
				if (generation) Object.assign(generation, { exitCode, signal });
				done();
			});
			child.once("error", () => done());
		});
		await new Promise<void>((done, fail) => {
			let finished = false;
			const timer = setTimeout(() => {
				finished = true;
				fail(new Error(`Server startup timeout\n${this.logs}`));
			}, TIMEOUT_MS);
			const onExit = () => {
				finished = true;
				clearTimeout(timer);
				fail(new Error(`Server exited before ready\n${this.logs}`));
			};
			const onError = (error: Error) => {
				finished = true;
				clearTimeout(timer);
				fail(error);
			};
			child.once("exit", onExit);
			child.once("error", onError);
			const ready = (value: Generation) => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				child.off("exit", onExit);
				child.off("error", onError);
				generation = { ...value, fakeSdkActive };
				this.port = generation.port;
				this.generations.push(generation);
				done();
			};
			child.on("message", (value: unknown) => {
				if (!isRecord(value) || value["channel"] !== "conduit-process-test")
					return;
				if (value["kind"] === "ready") {
					ready(value as unknown as Generation);
				} else if (value["kind"] === "fake-sdk-active") {
					if (
						value["module"] === sdkModule &&
						value["projectDir"] === this.projectDir
					) {
						fakeSdkActive = true;
						if (generation) generation.fakeSdkActive = true;
					}
				} else {
					this.marks.push(value as unknown as ProcessMark);
				}
			});
			if (this.foregroundCli) {
				void (async () => {
					while (!finished) {
						try {
							const socketPath = join(this.configDir, "relay.sock");
							const status = await sendRpcRequest(
								socketPath,
								new GetStatus({}),
							);
							const instances = await sendRpcRequest(
								socketPath,
								new GetInstances({}),
							);
							if (child.pid && status.port === this.port) {
								ready({
									pid: child.pid,
									port: status.port,
									projects: status.projects.map(
										(project) => project.folders[0],
									),
									instances: instances.instances.map((instance) => ({
										managed: instance.managed,
										...(instance.url !== undefined
											? { url: instance.url }
											: {}),
									})),
								});
							}
						} catch {
							// The socket is absent until this foreground process listens.
						}
						if (!finished)
							await new Promise<void>((resolve) => setTimeout(resolve, 25));
					}
				})();
			}
		});
		this.rememberManagedOpenCode();
		// Project registration is lazy. Attach without sending a prompt so the
		// selected build must acknowledge its live fake factories before use.
		if (options.skipBrowserProbe || this.realSdk) return;
		const probe = await ProcessBrowser.connect(this.port);
		try {
			// With no OpenCode listening, relay startup spends one SDK retry
			// window (~3s) confirming that before it acks. A second window means
			// startup is calling OpenCode again after learning it is down.
			const deadline = Date.now() + 5000;
			while (!this.generations.at(-1)?.fakeSdkActive) {
				if (Date.now() > deadline)
					throw new Error(
						"Fake Claude SDK activation was not acknowledged; refusing to send prompts to this build",
					);
				await new Promise<void>((done) => setTimeout(done, 10));
			}
		} finally {
			await probe.close();
		}
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	rejectNextOpenCodeWorkspaceMove(): void {
		if (!this.recordedOpenCode) throw new Error("No recorded OpenCode server");
		this.recordedOpenCode.rejectNextWorkspaceMove();
	}

	holdNextOpenCodePrompt(): () => void {
		if (!this.recordedOpenCode) throw new Error("No recorded OpenCode server");
		return this.recordedOpenCode.holdNextPrompt();
	}

	holdNextOpenCodePromptRequest(): () => void {
		if (!this.recordedOpenCode) throw new Error("No recorded OpenCode server");
		return this.recordedOpenCode.holdNextPromptRequest();
	}

	injectOpenCodeEvents(
		events: Array<{ type: string; properties: Record<string, unknown> }>,
		directory: string,
	): void {
		if (!this.recordedOpenCode) throw new Error("No recorded OpenCode server");
		this.recordedOpenCode.injectSSEEvents(events, directory);
	}

	opencodeDiagnostics() {
		return this.recordedOpenCode?.diagnostics ?? [];
	}

	opencodeRequestBodies() {
		const file = join(this.configDir, "fake-opencode-request-bodies.jsonl");
		return (
			this.recordedOpenCode?.requestBodies ??
			(existsSync(file)
				? readFileSync(file, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map(
							(line) =>
								JSON.parse(line) as {
									pid?: number;
									method: string;
									path: string;
									body: string;
								},
						)
				: [])
		);
	}

	opencodeRequests() {
		const file = join(this.configDir, "fake-opencode-requests.jsonl");
		return existsSync(file)
			? readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map(
						(line) =>
							JSON.parse(line) as {
								pid: number;
								at: number;
								method: string;
								url: string;
								directory?: string;
							},
					)
			: [];
	}

	opencodeStreamConnections() {
		const file = join(this.configDir, "fake-opencode-stream-connections.jsonl");
		return existsSync(file)
			? readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map(
						(line) =>
							JSON.parse(line) as {
								pid: number;
								at: number;
								action: "open" | "close";
								connectionId: number;
								path: string;
							},
					)
			: [];
	}

	async emitOpenCodeEvent(
		envelope: unknown,
		instanceId: string = defaultInstanceIdForDriver("opencode"),
	): Promise<void> {
		await this.openCodeTestCommand("emit-event", envelope, instanceId);
	}

	async closeOpenCodeStreams(): Promise<void> {
		await this.openCodeTestCommand("close-streams", {});
	}

	/** Serve a status from /session/status and emit it as session.status. */
	async setOpenCodeStatus(
		directory: string,
		sessionID: string,
		status: { type: "busy" | "idle" | "retry"; [key: string]: unknown },
	): Promise<void> {
		await this.openCodeTestCommand("set-status", {
			directory,
			sessionID,
			status,
		});
	}

	/** Serve a pending prompt from /permission or /question and emit it as asked. */
	async addOpenCodePrompt(
		kind: "permission" | "question",
		directory: string,
		item: { id: string; sessionID: string; [key: string]: unknown },
	): Promise<void> {
		await this.openCodeTestCommand(`add-${kind}`, { directory, item });
	}

	/** Record but do not emit matching events from then on. */
	async dropOpenCodeEvents(
		rules: readonly { type: string; status?: string }[],
	): Promise<void> {
		await this.openCodeTestCommand("drop-events", { rules });
	}

	opencodeDroppedEvents(): unknown[] {
		const file = join(this.configDir, "fake-opencode-dropped-events.jsonl");
		return existsSync(file)
			? readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line): unknown => JSON.parse(line))
			: [];
	}

	private async openCodeTestCommand(
		command: string,
		body: unknown,
		instanceId: string = defaultInstanceIdForDriver("opencode"),
	): Promise<void> {
		const instance = loadDaemonConfig(this.configDir)?.instances?.find(
			({ id }) => id === instanceId,
		);
		if (!instance?.port)
			throw new Error(`No fake OpenCode instance ${instanceId}`);
		const response = await fetch(
			`http://127.0.0.1:${instance.port}/test/${command}`,
			{
				method: "POST",
				headers: {
					Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"] ?? "opencode"}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(2000),
			},
		);
		if (!response.ok)
			throw new Error(`Fake OpenCode ${command}: ${response.status}`);
		await response.arrayBuffer();
	}

	claudeOptions(): readonly {
		pid: number;
		options: Record<string, unknown>;
		prompt?: string;
		configDir?: string | null;
		resumeId?: string | null;
	}[] {
		const file = join(this.root, "claude-options.jsonl");
		if (!existsSync(file)) return [];
		return readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map(
				(line) =>
					JSON.parse(line) as {
						pid: number;
						options: Record<string, unknown>;
						prompt?: string;
						configDir?: string | null;
						resumeId?: string | null;
					},
			);
	}

	async connect(
		sessionId?: string,
		originId?: string,
		projectSlug = "process-test",
		/** False keeps a large store's sidebar rows from each opening a detail stream. */
		followRows = true,
	): Promise<ProcessBrowser> {
		const browser = await ProcessBrowser.connect(
			this.port,
			sessionId,
			originId,
			projectSlug,
			followRows,
		);
		this.browsers.push(browser);
		return browser;
	}

	/** Close before any SubscribePtys or ListPtys can discover hosted terminals. */
	async closePtyWithoutBrowser(ptyId: string): Promise<void> {
		const runtime = browserRpcRuntime(this.port);
		try {
			const rpc = await runtime.runPromise(
				BrowserRpc.pipe(Effect.timeout(TIMEOUT_MS)),
			);
			await runtime.runPromise(
				rpc
					.ClosePty({ projectSlug: "process-test", ptyId })
					.pipe(Effect.timeout(TIMEOUT_MS)),
			);
		} finally {
			await runtime.dispose();
		}
	}

	async kill(): Promise<void> {
		await this.stop("SIGKILL");
	}

	async terminate(): Promise<void> {
		// Foreground runtime disposal takes about five seconds even without PTYs.
		await this.stop("SIGTERM", 10_000);
	}

	async signal(signal: "SIGINT" | "SIGTERM"): Promise<void> {
		await this.stop(signal, 10_000);
	}

	async runCli(args: string[]): Promise<{
		pid: number | undefined;
		code: number | null;
		signal: NodeJS.Signals | null;
		output: string;
	}> {
		if (!this.dist) throw new Error("CLI commands require a build");
		const child = spawn(
			process.execPath,
			[
				"--disable-warning=DEP0205",
				"--import",
				pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
				join(this.dist, "src/bin/cli.js"),
				...args,
			],
			{
				cwd: this.projectDir,
				env: this.environment,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		if (child.pid) this.cliPids.push(child.pid);
		for (const stream of [child.stdout, child.stderr])
			stream?.on("data", (data: Buffer) => {
				output = (output + data.toString()).slice(-8000);
			});
		return new Promise((done, fail) => {
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, TIMEOUT_MS);
			child.once("error", (cause) => {
				clearTimeout(timer);
				fail(cause);
			});
			child.once("exit", (code, signal) => {
				clearTimeout(timer);
				if (timedOut) {
					fail(
						new Error(`CLI command did not exit: ${args.join(" ")}\n${output}`),
					);
					return;
				}
				done({ pid: child.pid, code, signal, output });
			});
		});
	}

	async shutdown(): Promise<void> {
		const child = this.child;
		if (!child) return;
		let rpcFailure: unknown;
		if (child.exitCode === null && child.signalCode === null) {
			try {
				await sendRpcRequest(
					join(this.configDir, "relay.sock"),
					new Shutdown({}),
				);
			} catch (cause) {
				// A startup failure can remove IPC before its owned child exits.
				rpcFailure = cause;
			}
		}
		for (const connected of this.browsers) await connected.close();
		const force = setTimeout(() => child?.kill("SIGKILL"), 10_000);
		try {
			await this.exit;
			if (rpcFailure && child.signalCode === "SIGKILL") throw rpcFailure;
		} finally {
			clearTimeout(force);
		}
		this.child = undefined;
		for (const connected of this.browsers) await connected.close();
	}

	async waitForExit(
		options: { keepBrowsersOpen?: boolean } = {},
	): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (!options.keepBrowsersOpen)
				for (const browser of this.browsers) await browser.close();
			await Promise.race([
				this.exit,
				new Promise<never>((_done, fail) => {
					timer = setTimeout(
						() => fail(new Error("Server did not stop")),
						10_000,
					);
				}),
			]);
			this.child = undefined;
			for (const browser of this.browsers) await browser.close();
		} finally {
			clearTimeout(timer);
		}
	}

	async disconnectParent(): Promise<void> {
		const child = this.child;
		if (!child) throw new Error("No server child to disconnect");
		for (const browser of this.browsers) await browser.close();
		child.disconnect();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.exit,
				new Promise<never>((_done, fail) => {
					timer = setTimeout(
						() => fail(new Error("Child did not exit after parent disconnect")),
						8000,
					);
				}),
			]);
			this.child = undefined;
			for (const browser of this.browsers) await browser.close();
		} finally {
			clearTimeout(timer);
		}
	}

	private async stop(signal: NodeJS.Signals, timeoutMs = 6000): Promise<void> {
		const child = this.child;
		if (!child) return;
		// Close clients before graceful disposal: RPC scopes can otherwise hold
		// the server open until the harness deadline kills it before runner cleanup.
		if (signal !== "SIGKILL")
			for (const browser of this.browsers) await browser.close();
		child.kill(signal);
		// Bound server disposal even if an independent runner is unresponsive.
		const force = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		try {
			await this.exit;
		} finally {
			clearTimeout(force);
			this.child = undefined;
			for (const browser of this.browsers) await browser.close();
		}
	}

	get logTail(): string {
		return this.logs;
	}

	proof(): unknown {
		return {
			root: this.root,
			configDir: this.configDir,
			disposed: this.disposed,
			runnerCleanup: this.runnerCleanup,
			managedCleanup: this.managedCleanup,
			ownedOpenCodePids: [...this.ownedOpenCodeProcesses.values()].flatMap(
				(pids) => [...pids],
			),
			observedOpenCodePids: [...this.observedOpenCodeProcesses],
			remainingObservedOpenCodePids: [...this.observedOpenCodeProcesses].filter(
				isProcessAlive,
			),
			generations: this.generations,
			marks: this.marks,
			cliPids: this.cliPids,
			frames: this.browsers.map((browser) =>
				browser.frames.map(({ message, at }) => ({
					message,
					at: at.toString(),
				})),
			),
			logTail: this.logs,
		};
	}

	private rememberManagedOpenCode(): void {
		const config = loadDaemonConfig(this.configDir);
		for (const instance of config?.instances ?? []) {
			if (
				instance.managed &&
				instance.driver !== "claude" &&
				instance.processIdentity
			) {
				const token = instance.processIdentity.token;
				if (this.ownedOpenCode.has(token)) continue;
				this.ownedOpenCode.set(token, instance);
				const pids = new Set<number>();
				pids.add(instance.processIdentity.supervisorPid);
				if (instance.pid !== undefined) pids.add(instance.pid);
				this.ownedOpenCodeProcesses.set(token, pids);
			}
		}
		const ledger = join(this.configDir, "fake-opencode-pids.jsonl");
		if (!existsSync(ledger)) return;
		for (const line of readFileSync(ledger, "utf8").split("\n")) {
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(entry)) continue;
			const pid = entry["pid"];
			const captured =
				typeof pid === "number" &&
				[...this.ownedOpenCode].some(
					([token, record]) =>
						record.processIdentity?.supervisorPid === entry["groupPid"] &&
						this.ownedOpenCodeProcesses.get(token)?.has(pid),
				);
			if (captured || this.ownedOpenCode.size === 0) {
				for (const key of ["pid", "childPid", "groupPid"]) {
					const observed = entry[key];
					if (
						typeof observed === "number" &&
						Number.isSafeInteger(observed) &&
						observed > 0
					)
						// Observations require termination proof without granting authority.
						this.observedOpenCodeProcesses.add(observed);
				}
			}
			if (
				typeof entry["pid"] !== "number" ||
				typeof entry["childPid"] !== "number" ||
				!Number.isSafeInteger(entry["childPid"]) ||
				entry["childPid"] <= 0
			)
				continue;
			for (const [token, record] of this.ownedOpenCode) {
				const pids = this.ownedOpenCodeProcesses.get(token);
				if (
					record.processIdentity?.supervisorPid === entry["groupPid"] &&
					pids?.has(entry["pid"])
				)
					// The isolated ledger adds liveness checks, never signal authority.
					pids.add(entry["childPid"]);
			}
		}
	}

	ownedOpenCodePids(): number[] {
		this.rememberManagedOpenCode();
		return [...this.ownedOpenCodeProcesses.values()].flatMap((pids) => [
			...pids,
		]);
	}

	runnerPids(): number[] {
		const serverPids = new Set(
			this.generations.map((generation) => generation.pid),
		);
		return [
			...new Set([
				...this.marks.flatMap((mark) =>
					(mark.kind === "runner-started" ||
						mark.kind === "runner-spawned" ||
						mark.kind === "query") &&
					Number.isSafeInteger(mark.pid) &&
					mark.pid > 0 &&
					!serverPids.has(mark.pid)
						? [mark.pid]
						: [],
				),
				...(this.runnerCleanup?.runnerPids ?? []),
			]),
		];
	}

	remainingRunnerPids(): number[] {
		return this.runnerPids().filter(testRunnerAlive);
	}

	assertNoRunners(): void {
		const remaining = this.remainingRunnerPids();
		if (remaining.length > 0)
			throw new Error(
				`Claude runners still alive for ${this.configDir}: ${remaining.join(", ")}`,
			);
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			this.assertNoRunners();
			return;
		}
		const failures: unknown[] = [];
		try {
			const signalSaveGate = join(this.root, "signal-config-rename-gated");
			if (existsSync(signalSaveGate))
				writeFileSync(`${signalSaveGate}-release`, "cleanup");
			const pathGate = join(this.root, "opencode-path-gated");
			if (existsSync(pathGate)) writeFileSync(`${pathGate}-release`, "cleanup");
			if (this.blockCapabilitiesProbe) {
				writeFileSync(join(this.root, "capabilities-probe-release"), "release");
				writeFileSync(
					join(this.root, "capabilities-probe-gated-release"),
					"release",
				);
			}
			for (const project of loadDaemonConfig(this.configDir)?.projects ?? []) {
				if (!project.path.startsWith(`${this.root}/`)) continue;
				for (const name of ["recovery-gated", "recovery-fail-after-adoption"]) {
					const gate = join(project.path, ".conduit", name);
					if (existsSync(gate)) writeFileSync(`${gate}-release`, "cleanup");
				}
			}
			this.rememberManagedOpenCode();
		} catch (cause) {
			failures.push(cause);
		}
		try {
			if (this.generations.length > 0) await this.shutdown();
			else await this.stop("SIGTERM");
		} catch (cause) {
			failures.push(cause);
		}
		try {
			await this.stop("SIGKILL");
		} catch (cause) {
			failures.push(cause);
		}
		try {
			this.rememberManagedOpenCode();
		} catch (cause) {
			failures.push(cause);
		}
		// Retain authenticated ownership across deliberately corrupted configs.
		// Historical numeric IDs in the fixture ledger can be reused.
		const managedEvidence = new Map<
			string,
			(typeof this.managedCleanup)[number]
		>();
		let unverifiedManagedOwner = false;
		for (const [token, record] of this.ownedOpenCode) {
			const pids = this.ownedOpenCodeProcesses.get(token);
			if (!record.processIdentity || !pids) {
				failures.push(
					new Error(`Managed fixture identity missing at ${this.root}`),
				);
				continue;
			}
			const evidence = {
				supervisorPid: record.processIdentity.supervisorPid,
				controlAuthenticated: false,
				stopAccepted: false,
				pids: [] as number[],
				remainingPids: [] as number[],
			};
			this.managedCleanup.push(evidence);
			managedEvidence.set(token, evidence);
			try {
				const owned = await inspectManagedOpenCodeProcess(
					record.processIdentity,
				);
				if (owned) {
					evidence.controlAuthenticated = true;
					pids.add(owned.pid);
					pids.add(owned.launchPid);
					this.rememberManagedOpenCode();
					evidence.stopAccepted = await stopManagedOpenCode({
						...record,
						pid: owned.pid,
					});
				} else if (isProcessAlive(record.processIdentity.supervisorPid)) {
					unverifiedManagedOwner = true;
					failures.push(
						new Error(
							`Cannot verify managed fixture cleanup; recovery retained at ${this.root}`,
						),
					);
				}
			} catch (cause) {
				failures.push(
					new Error(
						`Cannot verify managed fixture cleanup; recovery retained at ${this.root}`,
						{ cause },
					),
				);
			}
		}
		const managedDeadline = Date.now() + 15_000;
		while (
			!unverifiedManagedOwner &&
			[...this.ownedOpenCodePids(), ...this.observedOpenCodeProcesses].some(
				isProcessAlive,
			) &&
			Date.now() < managedDeadline
		)
			await new Promise<void>((done) => setTimeout(done, 25));
		for (const [token, evidence] of managedEvidence) {
			evidence.pids = [...(this.ownedOpenCodeProcesses.get(token) ?? [])];
			evidence.remainingPids = evidence.pids.filter(isProcessAlive);
			if (!unverifiedManagedOwner && evidence.remainingPids.length > 0)
				failures.push(
					new Error(
						`Managed fixture processes still alive: ${evidence.remainingPids.join(", ")}; recovery retained at ${this.root}`,
					),
				);
		}
		const remainingObserved = [...this.observedOpenCodeProcesses].filter(
			isProcessAlive,
		);
		if (!unverifiedManagedOwner && remainingObserved.length > 0)
			failures.push(
				new Error(
					`Observed fixture processes still alive: ${remainingObserved.join(", ")}; recovery retained at ${this.root}`,
				),
			);
		clearInterval(this.ownershipObserver);
		failures.push(...this.ownershipErrors);
		// These PIDs came from fixture-owned spawn/query marks. Registration files
		// can disappear and suspended runners cannot answer a shutdown handshake.
		for (const pid of this.remainingRunnerPids()) {
			try {
				process.kill(pid, "SIGKILL");
			} catch (cause) {
				if (!(isRecord(cause) && cause["code"] === "ESRCH"))
					failures.push(cause);
			}
		}
		try {
			this.runnerCleanup = await cleanupTestClaudeRunners(
				this.root,
				this.runnerPids(),
				this.configDir,
				this.projectDir,
			);
		} catch (cause) {
			failures.push(cause);
		}
		try {
			this.assertNoRunners();
		} catch (cause) {
			failures.push(cause);
		}
		try {
			const hostClient = this.dist
				? ((await import(
						pathToFileURL(
							join(this.dist, "src/lib/terminal/pty-host-client.js"),
						).href
					)) as typeof import("../../src/lib/terminal/pty-host-client.js"))
				: { stopPtyHost };
			await hostClient.stopPtyHost({ configDir: this.configDir, force: true });
		} catch (cause) {
			failures.push(cause);
		}
		if (this.defaultOpenCode) {
			const server = this.defaultOpenCode;
			try {
				await new Promise<void>((done, fail) => {
					server.close((error) => (error ? fail(error) : done()));
					server.closeAllConnections();
				});
				this.defaultOpenCode = undefined;
			} catch (cause) {
				failures.push(cause);
			}
		}
		if (this.recordedOpenCode) {
			try {
				await this.recordedOpenCode.stop();
				this.recordedOpenCode = undefined;
			} catch (cause) {
				failures.push(cause);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(
				failures,
				`Harness cleanup failed; recovery retained at ${this.root}`,
			);
		// Keep registration/socket evidence if cleanup cannot prove termination.
		rmSync(this.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
		this.disposed = true;
	}
}

export class ProcessBrowser {
	readonly frames: BrowserFrame[] = [];
	readonly originId: string;
	private readonly waiters = new Set<() => void>();
	private readonly messageListeners = new Set<
		(message: Record<string, unknown>) => void
	>();
	private closed = false;
	private failure: Error | undefined;
	private ptys: Fiber.RuntimeFiber<void, unknown> | undefined;
	private approvals: Fiber.RuntimeFiber<void, unknown> | undefined;
	private projectSettings: Fiber.RuntimeFiber<void, unknown> | undefined;
	private sessions: Fiber.RuntimeFiber<void, unknown> | undefined;
	private sessionsReady: Promise<void> | undefined;
	private readonly details = new Map<string, Promise<void>>();
	private readonly detailFibers = new Set<Fiber.RuntimeFiber<void, unknown>>();
	private readonly families = new Map<string, Promise<void>>();
	private readonly familyFibers = new Set<Fiber.RuntimeFiber<void, unknown>>();
	private constructor(
		private readonly runtime: ManagedRuntime.ManagedRuntime<BrowserRpc, never>,
		readonly rpc: BrowserRpc["Type"],
		originId: string,
		private readonly projectSlug: string,
		private readonly followRows: boolean,
	) {
		this.originId = originId;
	}

	static async connect(
		port: number,
		sessionId?: string,
		originId: string = randomUUID(),
		projectSlug = "process-test",
		followRows = true,
	): Promise<ProcessBrowser> {
		let browser: ProcessBrowser | undefined;
		let connectionFailure: Error | undefined;
		const runtime = browserRpcRuntime(port, (error) => {
			connectionFailure = error;
			browser?.fail(error);
		});
		const rpc = await runtime
			.runPromise(BrowserRpc.pipe(Effect.timeout(TIMEOUT_MS)))
			.catch(async (error: unknown) => {
				await runtime.dispose();
				throw error;
			});
		browser = new ProcessBrowser(
			runtime,
			rpc,
			originId,
			projectSlug,
			followRows,
		);
		if (connectionFailure) browser.fail(connectionFailure);
		try {
			await browser.followPtys();
			await browser.watchApprovals();
			await browser.watchProjectSettings();
			await browser.followSessions();
			if (sessionId) await browser.view(sessionId);
			return browser;
		} catch (error) {
			await browser.close();
			throw error;
		}
	}

	private fail(error: unknown): void {
		if (this.closed) return;
		this.failure = error instanceof Error ? error : new Error(String(error));
		for (const notify of this.waiters) notify();
	}

	private watch<A, E>(
		stream: Stream.Stream<A, E>,
		record: (envelope: A) => Effect.Effect<void, unknown>,
	): Fiber.RuntimeFiber<void, unknown> {
		return this.runtime.runFork(
			Stream.runForEach(stream, record).pipe(
				Effect.onExit((exit) =>
					Effect.sync(() => {
						if (Exit.isFailure(exit)) this.fail(Cause.squash(exit.cause));
						else this.fail(new Error("Browser RPC subscription ended"));
					}),
				),
			),
		);
	}

	private record(message: Record<string, unknown>): void {
		this.frames.push({ message, at: process.hrtime.bigint() });
		for (const notify of this.messageListeners) notify(message);
		for (const notify of this.waiters) notify();
	}

	/**
	 * Follow the project's terminals as the browser does. Each SubscribePtys
	 * envelope is recorded as a `{ type: "pty", ...envelope }` frame.
	 */
	private async followPtys(): Promise<void> {
		const cursor = this.frames.length;
		this.ptys = this.watch(
			this.rpc.SubscribePtys({ projectSlug: this.projectSlug }),
			(envelope) =>
				Effect.sync(() => this.record({ type: "pty", ...envelope })),
		);
		await this.waitFor(
			(message) =>
				message["type"] === "pty" && message["_tag"] === "synchronized",
			cursor,
		);
	}

	// The approvals subscription, recorded as frames in the harness's own
	// vocabulary: `permission_pending` / `question_pending` carry the card, and
	// `approval_removed` its resolution.
	private async watchApprovals(): Promise<void> {
		const cursor = this.frames.length;
		this.approvals = this.watch(
			this.rpc.SubscribeApprovals({ projectSlug: this.projectSlug }),
			(envelope) =>
				Effect.sync(() => {
					this.record({ type: "approvals", ...envelope });
					const items =
						envelope._tag === "snapshot"
							? envelope.rows
							: envelope._tag === "upsert"
								? [envelope.item]
								: [];
					for (const item of items)
						this.record({ ...item, type: `${item._tag}_pending` });
					if (envelope._tag === "remove")
						this.record({ type: "approval_removed", id: envelope.id });
				}),
		);
		await this.waitFor(
			(message) =>
				message["type"] === "approvals" && message["_tag"] === "synchronized",
			cursor,
		);
	}

	// Project settings and live project facts, each row recorded as a
	// `{ type: "project_setting", ...row }` frame.
	private async watchProjectSettings(): Promise<void> {
		const cursor = this.frames.length;
		this.projectSettings = this.watch(
			this.rpc.SubscribeProjectSettings({ projectSlug: this.projectSlug }),
			(envelope) =>
				Effect.sync(() => {
					this.record({ type: "project_settings", ...envelope });
					const rows =
						envelope._tag === "snapshot"
							? envelope.rows
							: envelope._tag === "upsert"
								? [envelope.item]
								: [];
					for (const row of rows)
						this.record({ ...row, type: "project_setting" });
				}),
		);
		await this.waitFor(
			(message) =>
				message["type"] === "project_settings" &&
				message["_tag"] === "synchronized",
			cursor,
		);
	}

	/**
	 * Follow the project's session list as the sidebar does. Each row is
	 * recorded as a `session_row` frame and each removal as `session_removed`.
	 */
	followSessions(): Promise<void> {
		if (this.sessionsReady) return this.sessionsReady;
		this.sessionsReady = (async () => {
			const cursor = this.frames.length;
			this.sessions = this.watch(
				this.rpc.SubscribeShell({ projectSlug: this.projectSlug }),
				(envelope) =>
					Effect.gen(this, function* () {
						this.record({ type: "shell", ...envelope });
						if (envelope._tag === "snapshot")
							this.record({ type: "session_snapshot" });
						const rows =
							envelope._tag === "snapshot"
								? envelope.rows
								: envelope._tag === "upsert"
									? [envelope.item]
									: [];
						for (const row of rows)
							this.record({ ...row, type: "session_row" });
						if (this.followRows)
							yield* Effect.forEach(
								rows,
								(row) => Effect.promise(() => this.followSession(row.id)),
								{ discard: true },
							);
						if (envelope._tag === "remove")
							this.record({ type: "session_removed", id: envelope.id });
					}),
			);
			await this.waitFor(
				(message) =>
					message["type"] === "shell" && message["_tag"] === "synchronized",
				cursor,
			);
		})();
		return this.sessionsReady;
	}

	followSession(sessionId: string): Promise<void> {
		const existing = this.details.get(sessionId);
		if (existing) return existing;
		const ready = (async () => {
			const cursor = this.frames.length;
			this.detailFibers.add(
				this.watch(
					this.rpc.SubscribeSessionDetail({
						projectSlug: this.projectSlug,
						sessionId,
					}),
					(envelope) =>
						Effect.sync(() => {
							this.record({ type: "session_detail", sessionId, ...envelope });
							const items =
								envelope._tag === "snapshot"
									? envelope.rows
									: envelope._tag === "upsert"
										? [envelope.item]
										: [];
							for (const item of items)
								if (item._tag === "event")
									this.record({
										...item.event,
										type: item.event.type,
										sessionId,
									});
								else
									this.record({
										...item.message,
										type: "transcript_message",
										sessionId,
									});
						}),
				),
			);
			await this.waitFor(
				(message) =>
					message["type"] === "session_detail" &&
					message["sessionId"] === sessionId &&
					message["_tag"] === "synchronized",
				cursor,
			);
		})();
		this.details.set(sessionId, ready);
		return ready;
	}

	followFamily(sessionId: string): Promise<void> {
		const existing = this.families.get(sessionId);
		if (existing) return existing;
		const ready = (async () => {
			const cursor = this.frames.length;
			this.familyFibers.add(
				this.watch(
					this.rpc.SubscribeSessionFamily({
						projectSlug: this.projectSlug,
						sessionId,
					}),
					(envelope) =>
						Effect.gen(this, function* () {
							this.record({ type: "family", familyOf: sessionId, ...envelope });
							const rows =
								envelope._tag === "snapshot"
									? envelope.rows
									: envelope._tag === "upsert"
										? [envelope.item]
										: [];
							for (const row of rows)
								this.record({ ...row, type: "session_row" });
							yield* Effect.forEach(
								rows,
								(row) => Effect.promise(() => this.followSession(row.id)),
								{ discard: true },
							);
						}),
				),
			);
			await this.waitFor(
				(message) =>
					message["type"] === "family" &&
					message["familyOf"] === sessionId &&
					message["_tag"] === "synchronized",
				cursor,
			);
		})();
		this.families.set(sessionId, ready);
		return ready;
	}

	private run<A, E>(
		effect: Effect.Effect<A, E>,
		timeoutMs = TIMEOUT_MS,
	): Promise<A> {
		return this.runtime.runPromise(effect.pipe(Effect.timeout(timeoutMs)));
	}

	async shutdown(): Promise<void> {
		await this.run(this.rpc.Shutdown({}));
	}

	async instances() {
		return this.run(this.rpc.GetInstances({}));
	}

	async instanceStatus(instanceId: string) {
		return this.run(this.rpc.GetInstanceStatus({ instanceId }));
	}

	async removeInstance(instanceId: string) {
		return this.run(this.rpc.RemoveInstance({ instanceId }));
	}

	async startInstance(instanceId: string) {
		return this.run(this.rpc.StartInstance({ instanceId }));
	}

	async stopInstance(instanceId: string) {
		return this.run(this.rpc.StopInstance({ instanceId }));
	}

	async getModels(instanceId?: string) {
		return this.run(
			this.rpc.GetModels({
				projectSlug: this.projectSlug,
				...(instanceId ? { instanceId } : {}),
			}),
		);
	}

	async updateInstance(
		instanceId: string,
		updates: { driver?: "opencode" | "claude"; env?: Record<string, string> },
	) {
		return this.run(this.rpc.UpdateInstance({ instanceId, ...updates }));
	}

	async daemonStatus() {
		return this.run(this.rpc.GetStatus({}));
	}

	onMessage(listener: (message: Record<string, unknown>) => void): () => void {
		for (const { message } of this.frames) listener(message);
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	get connected(): boolean {
		return !this.closed && !this.failure;
	}

	async createSession(
		title?: string,
		instanceId?: string,
		providerId: ProviderDriverKind = "claude",
	): Promise<string> {
		const result = await this.run(
			this.rpc.CreateSession({
				projectSlug: this.projectSlug,
				providerId,
				...(instanceId
					? { instanceId: ProviderInstanceIdSchema.make(instanceId) }
					: {}),
				...(title !== undefined ? { title } : {}),
				originId: this.originId,
			}),
		);
		await this.view(result.sessionId);
		return result.sessionId;
	}

	async createPty(): Promise<PtyInfo> {
		const cursor = this.frames.length;
		await this.run(
			this.rpc.CreatePty({
				projectSlug: this.projectSlug,
				originId: this.originId,
			}),
		);
		const message = await this.waitFor(
			(frame) => frame["type"] === "pty" && frame["_tag"] === "upsert",
			cursor,
		);
		return message["item"] as PtyInfo;
	}

	async listPtys(): Promise<readonly PtyInfo[]> {
		return (
			await this.run(
				this.rpc.ListPtys({
					projectSlug: this.projectSlug,
					originId: this.originId,
				}),
			)
		).ptys;
	}

	async inputPty(ptyId: string, data: string): Promise<void> {
		await this.run(
			this.rpc.PtyInput({ projectSlug: this.projectSlug, ptyId, data }),
		);
	}

	async resizePty(ptyId: string, cols: number, rows: number): Promise<void> {
		await this.run(
			this.rpc.ResizePty({
				projectSlug: this.projectSlug,
				originId: this.originId,
				ptyId,
				cols,
				rows,
			}),
		);
	}

	async closePty(ptyId: string): Promise<void> {
		await this.run(this.rpc.ClosePty({ projectSlug: this.projectSlug, ptyId }));
	}

	async view(sessionId: string): Promise<void> {
		await this.followSession(sessionId);
		await this.run(
			this.rpc.ViewSession({
				projectSlug: this.projectSlug,
				sessionId,
				originId: this.originId,
			}),
		);
		await this.followFamily(sessionId);
	}

	async preWarmSession(sessionId: string): Promise<void> {
		await this.followSession(sessionId);
		await this.run(
			this.rpc.PreWarmSession({ projectSlug: this.projectSlug, sessionId }),
		);
	}

	async send(
		sessionId: string,
		prompt: string,
		timeoutMs = TIMEOUT_MS,
	): Promise<{ chunks: string[]; done: Record<string, unknown> }> {
		await this.followSession(sessionId);
		await this.followFamily(sessionId);
		const cursor = this.frames.length;
		const knownMessages = new Map<string, Set<string>>();
		for (const { message } of this.frames) {
			if (message["type"] !== "transcript_message") continue;
			const owner = String(message["sessionId"]);
			const ids = knownMessages.get(owner) ?? new Set<string>();
			ids.add(String(message["id"]));
			knownMessages.set(owner, ids);
		}
		const result = await this.run(
			this.rpc.SendMessage({
				projectSlug: this.projectSlug,
				sessionId,
				originId: this.originId,
				commandId: randomUUID(),
				text: prompt,
			}),
			timeoutMs,
		);
		await this.followSession(result.sessionId);
		const done = await this.waitForTurnEnd(result.sessionId, cursor, timeoutMs);
		// The detail source currently emits projected messages, not StoredEvents.
		// A fresh typed history read fences the final text against shell completion.
		const history = await this.history(result.sessionId);
		const previous = knownMessages.get(result.sessionId);
		const chunks = history
			.filter(
				(message) => message.role === "assistant" && !previous?.has(message.id),
			)
			.flatMap((message) => {
				const texts = (message.parts ?? [])
					.filter(
						(part) => part.type === "text" && typeof part.text === "string",
					)
					.map((part) => String(part.text));
				return texts.length ? texts : message.text ? [message.text] : [];
			});
		return { chunks, done };
	}

	/** Wait for a completed/failed turn's shell version to advance past cursor.
	 * The current read model does not advance this field on interruption. */
	waitForTurnEnd(
		sessionId: string,
		cursor = 0,
		timeoutMs = TIMEOUT_MS,
	): Promise<Record<string, unknown>> {
		const endedBefore = Math.max(
			-1,
			...this.frames
				.slice(0, cursor)
				.filter(
					({ message }) =>
						message["type"] === "session_row" && message["id"] === sessionId,
				)
				.map(({ message }) => Number(message["lastTurnEndVersion"] ?? -1)),
		);
		return this.waitFor(
			(message) =>
				message["type"] === "session_row" &&
				message["id"] === sessionId &&
				(message["status"] === "idle" || message["status"] === "error") &&
				Number(message["lastTurnEndVersion"] ?? -1) > endedBefore,
			cursor,
			timeoutMs,
		);
	}

	async answerApproval(
		request: Record<string, unknown>,
		decision: "allow" | "allow_always" | "deny",
	): Promise<void> {
		await this.run(
			this.rpc.RespondPermission({
				projectSlug: this.projectSlug,
				originId: this.originId,
				commandId: randomUUID(),
				requestId: String(request["requestId"]),
				decision,
				...(decision === "allow_always"
					? { permissionDestination: "session" as const }
					: {}),
			}),
		);
	}

	async rejectQuestion(request: Record<string, unknown>): Promise<void> {
		await this.run(
			this.rpc.RejectQuestion({
				projectSlug: this.projectSlug,
				originId: this.originId,
				commandId: randomUUID(),
				toolId: String(request["toolId"]),
			}),
		);
	}

	async history(sessionId: string) {
		await this.followSession(sessionId);
		return (
			await this.run(
				this.rpc.LoadMoreHistory({ projectSlug: this.projectSlug, sessionId }),
			)
		).messages;
	}

	async setAutoSettle(days: number | null): Promise<void> {
		await this.run(
			this.rpc.SetAutoSettleSetting({ autoSettleAfterDays: days }),
		);
	}

	async restartServer(): Promise<void> {
		await this.run(this.rpc.RestartWithConfig({ config: {} }));
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.followSession(sessionId);
		await this.run(
			this.rpc.DeleteSession({
				projectSlug: this.projectSlug,
				sessionId,
				originId: this.originId,
			}),
		);
	}

	async switchAgent(sessionId: string, agentId: string): Promise<void> {
		await this.followSession(sessionId);
		await this.run(
			this.rpc.SwitchAgent({
				projectSlug: this.projectSlug,
				sessionId,
				agentId,
				originId: this.originId,
			}),
		);
	}

	async reloadSession(sessionId: string, signal?: AbortSignal): Promise<void> {
		await this.followSession(sessionId);
		await this.runtime.runPromise(
			this.rpc
				.ReloadProviderSession({
					projectSlug: this.projectSlug,
					sessionId,
					originId: this.originId,
					commandId: randomUUID(),
				})
				.pipe(Effect.timeout(TIMEOUT_MS)),
			{ signal },
		);
	}

	waitFor(
		predicate: (message: Record<string, unknown>) => boolean,
		cursor = 0,
		timeoutMs = TIMEOUT_MS,
	): Promise<Record<string, unknown>> {
		return new Promise((done, fail) => {
			const timer = setTimeout(() => {
				this.waiters.delete(check);
				fail(new Error("Timed out waiting for browser event"));
			}, timeoutMs);
			const check = () => {
				const frame = this.frames
					.slice(cursor)
					.find(({ message }) => predicate(message));
				if (frame || this.failure || this.closed) {
					clearTimeout(timer);
					this.waiters.delete(check);
					if (frame) done(frame.message);
					else fail(this.failure ?? new Error("Browser socket closed"));
				}
			};
			this.waiters.add(check);
			check();
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const notify of this.waiters) notify();
		if (this.ptys) await Effect.runPromise(Fiber.interrupt(this.ptys));
		if (this.approvals)
			await Effect.runPromise(Fiber.interrupt(this.approvals));
		if (this.projectSettings)
			await Effect.runPromise(Fiber.interrupt(this.projectSettings));
		if (this.sessions) await Effect.runPromise(Fiber.interrupt(this.sessions));
		for (const fiber of this.detailFibers)
			await Effect.runPromise(Fiber.interrupt(fiber));
		for (const fiber of this.familyFibers)
			await Effect.runPromise(Fiber.interrupt(fiber));
		await this.runtime.dispose();
	}
}
