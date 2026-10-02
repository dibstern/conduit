import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Socket } from "@effect/platform";
import { RpcClient, type RpcGroup, RpcSerialization } from "@effect/rpc";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import WebSocket from "ws";
import { WsRpcGroup } from "../../src/lib/contracts/ws-rpc.js";
import { isRecord } from "../../src/lib/utils.js";
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
	readonly marks: ProcessMark[] = [];
	readonly generations: Generation[] = [];
	readonly browsers: ProcessBrowser[] = [];
	private child: ChildProcess | undefined;
	private exit: Promise<void> | undefined;
	private logs = "";
	private port = 0;
	private disposed = false;

	private constructor(
		private readonly dist?: string,
		private readonly enqueueMarkDelayMs = 0,
		private readonly claudeRunner?: "process",
		private readonly shellEnvProof = false,
	) {
		for (const directory of [
			"home",
			"config",
			"claude",
			"project",
			"cache",
			"static",
		]) {
			mkdirSync(join(this.root, directory));
		}
		if (shellEnvProof)
			writeFileSync(
				join(this.root, "home/.zprofile"),
				'export CONDUIT_ENV_PROOF=server-cache\nexport ANTHROPIC_API_KEY=must-remove\nexport ANTHROPIC_MODEL=must-remove\nexport PATH="/tmp/conduit-cached-env-bin:$PATH"\n',
			);
	}

	static async start(
		options: {
			dist?: string;
			enqueueMarkDelayMs?: number;
			claudeRunner?: "process";
			shellEnvProof?: boolean;
		} = {},
	): Promise<ProcessHarness> {
		const harness = new ProcessHarness(
			options.dist ? resolve(options.dist) : undefined,
			options.enqueueMarkDelayMs,
			options.claudeRunner,
			options.shellEnvProof,
		);
		try {
			await harness.restart();
			return harness;
		} catch (error) {
			await harness.dispose();
			throw error;
		}
	}

	async restart(): Promise<void> {
		if (this.disposed) throw new Error("Harness is disposed");
		if (this.child)
			throw new Error("Kill or stop the current child before restarting");
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
					PATH: process.env["PATH"] ?? "",
					HOME: join(this.root, "home"),
					XDG_CONFIG_HOME: join(this.root, "config"),
					XDG_CACHE_HOME: join(this.root, "cache"),
					CONDUIT_CONFIG_DIR: join(this.root, "config"),
					CLAUDE_CONFIG_DIR: join(this.root, "claude"),
					CONDUIT_TEST_CLAUDE_QUERY_MODULE: fakeModule,
					CONDUIT_TEST_ENQUEUE_MARK_DELAY_MS: String(this.enqueueMarkDelayMs),
					...(this.claudeRunner
						? { CONDUIT_CLAUDE_RUNNER: this.claudeRunner }
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
		// Project registration is lazy. Attach without sending a prompt so the
		// selected build must acknowledge its live fake factories before use.
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

	async connect(sessionId?: string): Promise<ProcessBrowser> {
		const browser = await ProcessBrowser.connect(this.port, sessionId);
		this.browsers.push(browser);
		return browser;
	}

	async kill(): Promise<void> {
		await this.stop("SIGKILL");
	}

	async disconnectParent(): Promise<void> {
		const child = this.child;
		if (!child) throw new Error("No server child to disconnect");
		child.disconnect();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.exit,
				new Promise<never>((_done, fail) => {
					timer = setTimeout(
						() => fail(new Error("Child did not exit after parent disconnect")),
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

	private async stop(signal: NodeJS.Signals): Promise<void> {
		const child = this.child;
		if (!child) return;
		child.kill(signal);
		const force = setTimeout(() => child.kill("SIGKILL"), 3000);
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
			disposed: this.disposed,
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

	async dispose(): Promise<void> {
		if (this.disposed) return;
		await this.stop("SIGTERM");
		rmSync(this.root, { recursive: true, force: true });
		this.disposed = true;
	}
}

export class ProcessBrowser {
	readonly frames: BrowserFrame[] = [];
	readonly originId: string;
	private readonly waiters = new Set<() => void>();
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
	): Promise<ProcessBrowser> {
		const originId = randomUUID();
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
		const runtime = ManagedRuntime.make(
			Layer.scoped(BrowserRpc, RpcClient.make(WsRpcGroup)).pipe(
				Layer.provide(protocol),
			),
		);
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

	async createSession(title?: string): Promise<string> {
		const result = await this.run(
			this.rpc.CreateSession({
				projectSlug: "process-test",
				providerId: "claude",
				...(title !== undefined ? { title } : {}),
				originId: this.originId,
			}),
		);
		await this.view(result.sessionId);
		return result.sessionId;
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
		decision: "allow" | "deny",
	): Promise<void> {
		await this.run(
			this.rpc.RespondPermission({
				projectSlug: "process-test",
				originId: this.originId,
				commandId: randomUUID(),
				requestId: String(request["requestId"]),
				decision,
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

	async shutdown(): Promise<void> {
		await this.run(this.rpc.Shutdown({}));
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
