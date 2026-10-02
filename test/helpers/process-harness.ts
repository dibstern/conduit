import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Socket } from "@effect/platform";
import { RpcClient, type RpcGroup, RpcSerialization } from "@effect/rpc";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import WebSocket from "ws";
import { ProviderInstanceIdSchema } from "../../src/lib/contracts/provider-instance.js";
import { Shutdown, WsRpcGroup } from "../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfig } from "../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../src/lib/daemon/daemon-rpc-client.js";
import {
	inspectManagedOpenCodeProcess,
	isProcessAlive,
	type ManagedOpenCodeRecord,
	stopManagedOpenCode,
} from "../../src/lib/instance/managed-opencode-process.js";
import type { ModelInfo } from "../../src/lib/provider/types.js";
import type { PtyInfo } from "../../src/lib/shared-types.js";
import { stopPtyHost } from "../../src/lib/terminal/pty-host-client.js";
import { isRecord } from "../../src/lib/utils.js";
import {
	cleanupTestClaudeRunners,
	testRunnerAlive,
} from "./claude-runner-cleanup.js";
import { type ProcessMark, responseChunks } from "./fake-claude-process-sdk.js";

export { responseChunks };

const TIMEOUT_MS = 15_000;

class BrowserRpc extends Context.Tag("ProcessHarnessBrowserRpc")<
	BrowserRpc,
	RpcClient.RpcClient<
		RpcGroup.Rpcs<typeof WsRpcGroup>,
		import("@effect/rpc/RpcClientError").RpcClientError
	>
>() {}

function browserRpcRuntime(port: number) {
	const protocol = RpcClient.layerProtocolSocket().pipe(
		Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
		Layer.provide(
			Layer.succeed(
				Socket.WebSocketConstructor,
				(url) => new WebSocket(url) as unknown as globalThis.WebSocket,
			),
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
	instances: Array<{ managed: boolean; url: string }>;
	signal?: NodeJS.Signals | null;
	exitCode?: number | null;
	fakeSdkActive?: boolean;
}

export interface BrowserFrame {
	message: Record<string, unknown>;
	at: bigint;
}

export class ProcessHarness {
	readonly root = mkdtempSync("/tmp/conduit-process-");
	readonly projectDir = join(this.root, "project");
	readonly configDir: string;
	readonly marks: ProcessMark[] = [];
	readonly generations: Generation[] = [];
	readonly browsers: ProcessBrowser[] = [];
	private child: ChildProcess | undefined;
	private exit: Promise<void> | undefined;
	private logs = "";
	private port = 0;
	private disposed = false;
	private readonly ownedOpenCode = new Map<string, ManagedOpenCodeRecord>();
	private runnerCleanup:
		| Awaited<ReturnType<typeof cleanupTestClaudeRunners>>
		| undefined;

	private constructor(
		private readonly dist?: string,
		private readonly enqueueMarkDelayMs = 0,
		private readonly claudeRunner?: "process",
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
			| "answer-permission",
		private readonly runnerReattachGraceMs?: number,
		private buildId?: string,
		private readonly upgradeSinkProof = false,
		private readonly subagentPollTimeoutMs?: number,
	) {
		this.configDir = join(
			this.root,
			runnerLifecycle?.nonDefaultConfigDir ? "active-config" : "config",
		);
		for (const directory of [
			"home",
			"config",
			"claude",
			"project",
			"cache",
			"static",
			"data",
			"active-config",
		]) {
			mkdirSync(join(this.root, directory));
		}
		if (blockCapabilitiesProbe)
			writeFileSync(join(this.root, "capabilities-probe-gated"), "hold");
		if (capabilityModels)
			writeFileSync(
				join(this.root, "capabilities-probe-result.json"),
				JSON.stringify({ models: capabilityModels, agents: [], commands: [] }),
			);
		if (shellEnvProof)
			writeFileSync(
				join(this.root, "home/.zprofile"),
				'export CONDUIT_ENV_PROOF=server-cache\nexport ANTHROPIC_API_KEY=must-remove\nexport ANTHROPIC_MODEL=must-remove\nexport PATH="/tmp/conduit-cached-env-bin:$PATH"\n',
			);
		if (managedOpenCode) {
			mkdirSync(join(this.root, "bin"));
			const executable = join(this.root, "bin", "opencode");
			copyFileSync(
				fileURLToPath(new URL("./fake-opencode-process.mjs", import.meta.url)),
				executable,
			);
			chmodSync(executable, 0o755);
			writeFileSync(
				join(this.configDir, "daemon.json"),
				JSON.stringify({
					pid: 0,
					port: 0,
					pinHash: null,
					tls: false,
					debug: false,
					keepAwake: false,
					dangerouslySkipPermissions: false,
					projects: [],
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
				}),
			);
		}
	}

	static async start(
		options: {
			dist?: string;
			enqueueMarkDelayMs?: number;
			claudeRunner?: "process";
			shellEnvProof?: boolean;
			managedOpenCode?: boolean;
			ignoreOpenCodeSigterm?: boolean;
			pauseOpenCodeSupervisor?: boolean;
			runnerLifecycle?: ProcessHarness["runnerLifecycle"];
			queryInitializationDelayMs?: number;
			queryInitializationFailures?: number;
			blockCapabilitiesProbe?: boolean;
			capabilityModels?: readonly ModelInfo[];
			restartProof?: boolean;
			holdRunnerAck?: boolean;
			holdRunnerOutput?: "permission-request" | "answer-permission";
			runnerReattachGraceMs?: number;
			buildId?: string;
			upgradeSinkProof?: boolean;
			subagentPollTimeoutMs?: number;
		} = {},
	): Promise<ProcessHarness> {
		const harness = new ProcessHarness(
			(options.dist ?? process.env["CONDUIT_TEST_DIST"])
				? resolve(options.dist ?? process.env["CONDUIT_TEST_DIST"] ?? "dist")
				: undefined,
			options.enqueueMarkDelayMs,
			options.claudeRunner,
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
			options.runnerReattachGraceMs,
			options.buildId,
			options.upgradeSinkProof,
			options.subagentPollTimeoutMs,
		);
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
			buildId?: string;
			queryInitializationDelayMs?: number;
		} = {},
	): Promise<void> {
		if (this.disposed) throw new Error("Harness is disposed");
		if (this.child)
			throw new Error("Kill or stop the current child before restarting");
		this.buildId = options.buildId ?? this.buildId;
		this.logs = "";
		const fakeModule = pathToFileURL(
			fileURLToPath(new URL("./fake-claude-process-sdk.ts", import.meta.url)),
		).href;
		const child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
				fileURLToPath(new URL("./process-harness-server.ts", import.meta.url)),
				this.root,
				...(this.dist ? [this.dist] : []),
			],
			{
				cwd: this.projectDir,
				env: {
					PATH: this.managedOpenCode
						? `${join(this.root, "bin")}:${process.env["PATH"] ?? ""}`
						: (process.env["PATH"] ?? ""),
					HOME: join(this.root, "home"),
					SHELL: "/bin/sh",
					XDG_CONFIG_HOME: join(this.root, "config"),
					XDG_CACHE_HOME: join(this.root, "cache"),
					XDG_DATA_HOME: join(this.root, "data"),
					CONDUIT_CONFIG_DIR: join(this.root, "config"),
					CLAUDE_CONFIG_DIR: join(this.root, "claude"),
					CONDUIT_TEST_CLAUDE_QUERY_MODULE: fakeModule,
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
					...(this.holdRunnerAck
						? { CONDUIT_TEST_HOLD_RUNNER_ACK: "text.delta" }
						: {}),
					...(this.holdRunnerOutput && this.generations.length === 0
						? { CONDUIT_TEST_HOLD_RUNNER_OUTPUT: this.holdRunnerOutput }
						: {}),
					...(this.claudeRunner
						? { CONDUIT_CLAUDE_RUNNER: this.claudeRunner }
						: {}),
					...(this.runnerReattachGraceMs !== undefined
						? {
								CONDUIT_CLAUDE_RUNNER_REATTACH_GRACE_MS: String(
									this.runnerReattachGraceMs,
								),
							}
						: {}),
					...(this.shellEnvProof
						? { SHELL: "/bin/zsh", ZDOTDIR: join(this.root, "home") }
						: {}),
					NODE_ENV: "test",
					LOG_LEVEL: "error",
				},
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
		this.exit = new Promise<void>((done) => {
			child.once("exit", (exitCode, signal) => {
				if (generation) Object.assign(generation, { exitCode, signal });
				done();
			});
			child.once("error", () => done());
		});
		await new Promise<void>((done, fail) => {
			const timer = setTimeout(
				() => fail(new Error(`Server startup timeout\n${this.logs}`)),
				TIMEOUT_MS,
			);
			const onExit = () => {
				clearTimeout(timer);
				fail(new Error(`Server exited before ready\n${this.logs}`));
			};
			const onError = (error: Error) => {
				clearTimeout(timer);
				fail(error);
			};
			child.once("exit", onExit);
			child.once("error", onError);
			child.on("message", (value: unknown) => {
				if (!isRecord(value) || value["channel"] !== "conduit-process-test")
					return;
				if (value["kind"] === "ready") {
					clearTimeout(timer);
					child.off("exit", onExit);
					child.off("error", onError);
					generation = value as unknown as Generation;
					this.port = generation.port;
					this.generations.push(generation);
					done();
				} else if (value["kind"] === "fake-sdk-active") {
					if (
						generation &&
						value["module"] === fakeModule &&
						value["projectDir"] === this.projectDir
					)
						generation.fakeSdkActive = true;
				} else {
					this.marks.push(value as unknown as ProcessMark);
				}
			});
		});
		this.rememberManagedOpenCode();
		// Project registration is lazy. Attach without sending a prompt so the
		// selected build must acknowledge its live fake factories before use.
		if (options.skipBrowserProbe) return;
		const probe = await ProcessBrowser.connect(this.port);
		try {
			const deadline = Date.now() + 2000;
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

	async connect(
		sessionId?: string,
		originId?: string,
	): Promise<ProcessBrowser> {
		const browser = await ProcessBrowser.connect(
			this.port,
			sessionId,
			originId,
		);
		this.browsers.push(browser);
		return browser;
	}

	/** Close before any /ws init replay or ListPtys can discover hosted terminals. */
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

	async shutdown(): Promise<void> {
		if (!this.child) return;
		await sendRpcRequest(join(this.configDir, "relay.sock"), new Shutdown({}));
		for (const connected of this.browsers) await connected.close();
		const child = this.child;
		const force = setTimeout(() => child?.kill("SIGKILL"), 5000);
		try {
			await this.exit;
		} finally {
			clearTimeout(force);
		}
		this.child = undefined;
		for (const connected of this.browsers) await connected.close();
	}

	async waitForExit(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			for (const browser of this.browsers) await browser.close();
			await Promise.race([
				this.exit,
				new Promise<never>((_done, fail) => {
					timer = setTimeout(
						() => fail(new Error("Server did not stop")),
						5000,
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
		// The runner gets 1s to reply and 3s to terminate before its own force-kill.
		const force = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		try {
			await this.exit;
		} finally {
			clearTimeout(force);
			this.child = undefined;
			for (const browser of this.browsers) await browser.close();
		}
	}

	proof(): unknown {
		return {
			root: this.root,
			configDir: this.configDir,
			disposed: this.disposed,
			runnerCleanup: this.runnerCleanup,
			generations: this.generations,
			marks: this.marks,
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
		if (!this.managedOpenCode) return;
		const config = loadDaemonConfig(this.configDir);
		for (const instance of config?.instances ?? []) {
			if (
				instance.managed &&
				instance.driver !== "claude" &&
				instance.processIdentity &&
				!this.ownedOpenCode.has(instance.processIdentity.token)
			)
				this.ownedOpenCode.set(instance.processIdentity.token, instance);
		}
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
			if (this.blockCapabilitiesProbe)
				writeFileSync(join(this.root, "capabilities-probe-release"), "release");
			this.rememberManagedOpenCode();
		} catch (cause) {
			failures.push(cause);
		}
		try {
			if (this.managedOpenCode) await this.shutdown();
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
		for (const record of this.ownedOpenCode.values()) {
			try {
				const owned = await inspectManagedOpenCodeProcess(
					record.processIdentity,
				);
				const stopped = owned
					? await stopManagedOpenCode({ ...record, pid: owned.pid })
					: false;
				if (
					!stopped &&
					record.processIdentity &&
					isProcessAlive(record.processIdentity.supervisorPid)
				)
					failures.push(
						new Error(
							`Cannot verify managed fixture cleanup; recovery retained at ${this.root}`,
						),
					);
			} catch (cause) {
				failures.push(
					new Error(
						`Cannot verify managed fixture cleanup; recovery retained at ${this.root}`,
						{ cause },
					),
				);
			}
		}
		const runnerPids = new Set(
			this.marks.flatMap((mark) =>
				(mark.kind === "runner-spawned" || mark.kind === "runner-started") &&
				Number.isSafeInteger(mark.pid) &&
				mark.pid > 0 &&
				!this.generations.some((generation) => generation.pid === mark.pid)
					? [mark.pid]
					: [],
			),
		);
		for (const pid of runnerPids) {
			try {
				try {
					process.kill(pid, 0);
				} catch (cause) {
					if (isRecord(cause) && cause["code"] === "ESRCH") continue;
					throw cause;
				}
				// Only reap an exact PID reported by this harness's child process.
				try {
					process.kill(pid, "SIGKILL");
				} catch (cause) {
					if (isRecord(cause) && cause["code"] === "ESRCH") continue;
					throw cause;
				}
				const deadline = Date.now() + 3000;
				while (true) {
					try {
						process.kill(pid, 0);
					} catch (cause) {
						if (isRecord(cause) && cause["code"] === "ESRCH") break;
						throw cause;
					}
					if (Date.now() >= deadline)
						throw new Error(`Harness runner ${pid} did not exit`);
					await new Promise<void>((done) => setTimeout(done, 25));
				}
			} catch (cause) {
				failures.push(cause);
			}
		}
		try {
			this.runnerCleanup = await cleanupTestClaudeRunners(
				this.root,
				this.runnerPids(),
				this.configDir,
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
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(
				failures,
				`Harness cleanup failed; recovery retained at ${this.root}`,
			);
		// Keep registration/socket evidence if cleanup cannot prove termination.
		rmSync(this.root, { recursive: true, force: true });
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
	private constructor(
		private readonly ws: WebSocket,
		private readonly runtime: ManagedRuntime.ManagedRuntime<BrowserRpc, never>,
		readonly rpc: BrowserRpc["Type"],
		originId: string,
	) {
		this.originId = originId;
		ws.on("message", (data) => {
			const at = process.hrtime.bigint();
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			this.frames.push({ message, at });
			for (const notify of this.messageListeners) notify(message);
			for (const notify of this.waiters) notify();
		});
		ws.on("error", (error) => {
			this.failure = error;
			for (const notify of this.waiters) notify();
		});
		ws.on("close", () => {
			this.closed = true;
			for (const notify of this.waiters) notify();
		});
		ws.on("ping", () => ws.pong());
	}

	static async connect(
		port: number,
		sessionId?: string,
		originId: string = randomUUID(),
	): Promise<ProcessBrowser> {
		const runtime = browserRpcRuntime(port);
		const rpc = await runtime
			.runPromise(BrowserRpc.pipe(Effect.timeout(TIMEOUT_MS)))
			.catch(async (error: unknown) => {
				await runtime.dispose();
				throw error;
			});
		const ws = new WebSocket(
			`ws://127.0.0.1:${port}/ws?p=process-test&client=${originId}${sessionId ? `&session=${sessionId}` : ""}`,
		);
		const browser = new ProcessBrowser(ws, runtime, rpc, originId);
		try {
			await new Promise<void>((done, fail) => {
				const timer = setTimeout(
					() => fail(new Error("Browser WS connect timeout")),
					TIMEOUT_MS,
				);
				ws.once("open", () => {
					clearTimeout(timer);
					done();
				});
				ws.once("error", (error) => {
					clearTimeout(timer);
					fail(error);
				});
			});
			await browser.waitFor(
				(message) => message["type"] === "protocol_version",
			);
			return browser;
		} catch (error) {
			await browser.close();
			throw error;
		}
	}

	private run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
		return this.runtime.runPromise(effect.pipe(Effect.timeout(TIMEOUT_MS)));
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

	async createSession(title?: string, instanceId?: string): Promise<string> {
		const result = await this.run(
			this.rpc.CreateSession({
				projectSlug: "process-test",
				providerId: "claude",
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
				projectSlug: "process-test",
				originId: this.originId,
			}),
		);
		const message = await this.waitFor(
			(frame) => frame["type"] === "pty_created",
			cursor,
		);
		return message["pty"] as PtyInfo;
	}

	async listPtys(): Promise<readonly PtyInfo[]> {
		return (
			await this.run(
				this.rpc.ListPtys({
					projectSlug: "process-test",
					originId: this.originId,
				}),
			)
		).ptys;
	}

	inputPty(ptyId: string, data: string): void {
		this.ws.send(JSON.stringify({ type: "pty_input", ptyId, data }));
	}

	async resizePty(ptyId: string, cols: number, rows: number): Promise<void> {
		await this.run(
			this.rpc.ResizePty({
				projectSlug: "process-test",
				originId: this.originId,
				ptyId,
				cols,
				rows,
			}),
		);
	}

	async closePty(ptyId: string): Promise<void> {
		await this.run(this.rpc.ClosePty({ projectSlug: "process-test", ptyId }));
	}

	async view(sessionId: string): Promise<void> {
		await this.run(
			this.rpc.ViewSession({
				projectSlug: "process-test",
				sessionId,
				originId: this.originId,
			}),
		);
	}

	async preWarmSession(sessionId: string): Promise<void> {
		await this.run(
			this.rpc.PreWarmSession({ projectSlug: "process-test", sessionId }),
		);
	}

	async send(
		sessionId: string,
		prompt: string,
	): Promise<{ chunks: string[]; done: Record<string, unknown> }> {
		const cursor = this.frames.length;
		await this.run(
			this.rpc.SendMessage({
				projectSlug: "process-test",
				sessionId,
				originId: this.originId,
				commandId: randomUUID(),
				text: prompt,
			}),
		);
		const done = await this.waitFor(
			(message) =>
				message["type"] === "done" && message["sessionId"] === sessionId,
			cursor,
		);
		const chunks = this.frames
			.slice(cursor)
			.filter(({ message }) => message["type"] === "delta")
			.map(({ message }) => String(message["text"]));
		return { chunks, done };
	}

	async answerApproval(
		request: Record<string, unknown>,
		decision: "allow" | "allow_always" | "deny",
	): Promise<void> {
		await this.run(
			this.rpc.RespondPermission({
				projectSlug: "process-test",
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

	async history(sessionId: string) {
		return (
			await this.run(
				this.rpc.LoadMoreHistory({ projectSlug: "process-test", sessionId }),
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
		await this.run(
			this.rpc.DeleteSession({
				projectSlug: "process-test",
				sessionId,
				originId: this.originId,
			}),
		);
	}

	async switchAgent(sessionId: string, agentId: string): Promise<void> {
		await this.run(
			this.rpc.SwitchAgent({
				projectSlug: "process-test",
				sessionId,
				agentId,
				originId: this.originId,
			}),
		);
	}

	async reloadSession(sessionId: string, signal?: AbortSignal): Promise<void> {
		await this.runtime.runPromise(
			this.rpc
				.ReloadProviderSession({
					projectSlug: "process-test",
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
	): Promise<Record<string, unknown>> {
		return new Promise((done, fail) => {
			const timer = setTimeout(() => {
				this.waiters.delete(check);
				fail(new Error("Timed out waiting for browser event"));
			}, TIMEOUT_MS);
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
		if (!this.closed) this.ws.terminate();
		await this.runtime.dispose();
		this.closed = true;
	}
}
