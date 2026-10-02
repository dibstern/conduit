/**
 * THROWAWAY SPIKE for conduit-test-85kb.2. Not production provider code.
 * Run: node --import tsx scripts/spikes/claude-preboot/measure.ts
 * stdout is a JSON evidence artifact; progress goes to stderr.
 * Failure cases: absent/expired OAuth, no pre-input init, failed resume,
 * stalled output, interruption, and child processes surviving close().
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	type Query,
	query,
	type SDKResultMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { makeClaudeSdkEnv } from "../../../src/lib/provider/claude/claude-sdk-env.js";

const rounds = Number(process.env.CLAUDE_PREBOOT_ROUNDS ?? 3);
const idleMs = Number(process.env.CLAUDE_PREBOOT_IDLE_MS ?? 5000);
const model = process.env.CLAUDE_PREBOOT_MODEL ?? "sonnet";
if (
	!Number.isInteger(rounds) ||
	rounds < 1 ||
	!Number.isFinite(idleMs) ||
	idleMs < 0
) {
	throw new Error("Invalid spike rounds or idle duration");
}
const children: ChildProcess[] = [];
const cancellation = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => cancellation.abort(new Error(signal)));
}

// Read the current profile's OAuth credential without refreshing it or writing
// to the profile/Keychain. Only the access token goes into the isolated CLI env.
async function oauthToken(): Promise<string | undefined> {
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
		return process.env.CLAUDE_CODE_OAUTH_TOKEN;
	const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	let raw: string | undefined;
	try {
		raw = await readFile(join(configDir, ".credentials.json"), "utf8");
	} catch {}
	if (!raw && process.platform === "darwin") {
		const secureDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
		const configured =
			secureDir !== undefined
				? Boolean(secureDir)
				: Boolean(process.env.CLAUDE_CONFIG_DIR);
		const suffix = configured
			? `-${createHash("sha256")
					.update(resolve(secureDir ?? configDir).normalize("NFC"))
					.digest("hex")
					.slice(0, 8)}`
			: "";
		try {
			raw = execFileSync(
				"/usr/bin/security",
				[
					"find-generic-password",
					"-a",
					process.env.USER ?? userInfo().username,
					"-w",
					"-s",
					`Claude Code-credentials${suffix}`,
				],
				{ encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
			);
		} catch {}
	}
	if (!raw) return undefined;
	const data: unknown = JSON.parse(raw);
	if (typeof data !== "object" || data === null || !("claudeAiOauth" in data))
		return undefined;
	const oauth = data.claudeAiOauth;
	if (typeof oauth !== "object" || oauth === null || !("accessToken" in oauth))
		return undefined;
	if (
		"expiresAt" in oauth &&
		typeof oauth.expiresAt === "number" &&
		oauth.expiresAt <= Date.now()
	)
		return undefined;
	return typeof oauth.accessToken === "string" ? oauth.accessToken : undefined;
}

async function deadline<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	const timer = new AbortController();
	try {
		return await Promise.race([
			promise,
			delay(ms, undefined, { signal: timer.signal }).then(() => {
				throw new Error(`${label} timed out after ${ms}ms`);
			}),
			new Promise<never>((_, reject) => {
				if (cancellation.signal.aborted) reject(cancellation.signal.reason);
				else
					cancellation.signal.addEventListener(
						"abort",
						() => reject(cancellation.signal.reason),
						{ once: true, signal: timer.signal },
					);
			}),
		]);
	} finally {
		timer.abort();
	}
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
			throw error;
	}
}

async function terminate(child: ChildProcess): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) {
		const exited = new Promise<void>((done) =>
			child.once("exit", () => done()),
		);
		await Promise.race([exited, delay(8000)]);
		if (child.exitCode === null && child.signalCode === null) {
			signalGroup(child, "SIGTERM");
			await Promise.race([exited, delay(1000)]);
		}
		if (child.exitCode === null && child.signalCode === null) {
			signalGroup(child, "SIGKILL");
			await Promise.race([exited, delay(2000)]);
		}
	}
	// The detached group belongs solely to this spike, including descendants.
	signalGroup(child, "SIGKILL");
	if (child.pid) {
		try {
			process.kill(child.pid, 0);
			throw new Error(`Spike child ${child.pid} survived cleanup`);
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ESRCH")
			)
				throw error;
		}
	}
}

async function measure(
	round: number,
	cwd: string,
	configDir: string,
	token: string,
	resume?: string,
) {
	const input = Promise.withResolvers<SDKUserMessage | undefined>();
	const end = Promise.withResolvers<void>();
	async function* prompt(): AsyncGenerator<SDKUserMessage> {
		const message = await input.promise;
		if (message) yield message;
		await end.promise; // Keep stdin open throughout the turn and idle period.
	}
	const completed = Promise.withResolvers<SDKResultMessage>();
	// Attach a rejection handler now, including for failure before awaiting result.
	void completed.promise.catch(() => {});
	let sdkQuery: Query | undefined;
	let consumer: Promise<void> | undefined;
	let child: ChildProcess | undefined;
	let enqueuedMs: number | null = null;
	let spawnCalledMs: number | null = null;
	let spawnEventMs: number | null = null;
	let initializeMs: number | null = null;
	let systemInitMs: number | null = null;
	let firstTokenMs: number | null = null;
	let sessionId: string | undefined;
	let actualModel: string | undefined;
	let text = "";
	const preInputEvents: string[] = [];
	const started = performance.now();
	const elapsed = () => performance.now() - started;
	try {
		const env = makeClaudeSdkEnv({ configDir });
		env.CLAUDE_CODE_OAUTH_TOKEN = token;
		delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
		env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
		sdkQuery = query({
			prompt: prompt(),
			options: {
				cwd,
				env,
				model,
				...(resume ? { resume } : {}),
				includePartialMessages: true,
				settingSources: [],
				tools: [],
				mcpServers: {},
				strictMcpConfig: true,
				thinking: { type: "disabled" },
				maxTurns: 1,
				spawnClaudeCodeProcess(options) {
					spawnCalledMs = elapsed();
					const spawned = spawn(options.command, options.args, {
						cwd: options.cwd,
						env: options.env,
						signal: options.signal,
						stdio: ["pipe", "pipe", "pipe"],
						detached: process.platform !== "win32",
					});
					child = spawned;
					children.push(child);
					child.once("spawn", () => {
						spawnEventMs = elapsed();
					});
					child.on("error", (error) => completed.reject(error));
					child.stderr?.resume(); // Drain, without logging credentials or hooks.
					return spawned;
				},
			},
		});
		const queryReturnedMs = elapsed();
		consumer = (async () => {
			try {
				for await (const message of sdkQuery) {
					if (enqueuedMs === null)
						preInputEvents.push(
							message.type === "system"
								? `system/${message.subtype}`
								: message.type,
						);
					if (message.type === "system" && message.subtype === "init") {
						systemInitMs ??= elapsed();
						sessionId = message.session_id;
						actualModel = message.model;
					}
					if (
						message.type === "stream_event" &&
						message.event.type === "content_block_delta" &&
						message.event.delta.type === "text_delta" &&
						message.event.delta.text
					) {
						firstTokenMs ??= elapsed();
						text += message.event.delta.text;
					}
					if (message.type === "result") {
						sessionId = message.session_id;
						completed.resolve(message);
					}
				}
				completed.reject(new Error("SDK stream ended without a result"));
			} catch (error) {
				completed.reject(error);
			}
		})();
		await deadline(
			sdkQuery.initializationResult().then(() => {
				initializeMs = elapsed();
			}),
			60000,
			"initialize handshake",
		);
		await deadline(delay(idleMs), idleMs + 1000, "idle observation");
		if (!child || child.exitCode !== null || child.signalCode !== null)
			throw new Error("CLI exited before prompt");
		enqueuedMs = elapsed();
		input.resolve({
			type: "user",
			session_id: resume ?? "",
			parent_tool_use_id: null,
			message: { role: "user", content: "reply with ok" },
		});
		const result = await deadline(
			completed.promise,
			120000,
			"assistant result",
		);
		if (result.subtype !== "success")
			throw new Error(`Turn failed: ${result.subtype}`);
		if (firstTokenMs === null || !sessionId)
			throw new Error("Missing first text delta or session ID");
		if (resume && sessionId !== resume)
			throw new Error("Resumed result changed session ID");
		return {
			round,
			mode: resume ? "resume" : "fresh",
			sessionId,
			model: actualModel,
			pid: child.pid,
			queryReturnedMs,
			spawnCalledMs,
			spawnEventMs,
			initializeMs,
			enqueuedMs,
			idleMs,
			systemInitMs,
			systemInitBeforePrompt:
				systemInitMs !== null && systemInitMs < enqueuedMs,
			preInputEvents,
			firstTokenFromQueryMs: firstTokenMs,
			firstTokenFromEnqueueMs: firstTokenMs - enqueuedMs,
			resultMs: elapsed(),
			reply: text,
			usage: result.usage,
			costEstimateUsd: result.total_cost_usd,
		};
	} finally {
		sdkQuery?.close();
		input.resolve(undefined);
		end.resolve();
		if (child) await terminate(child);
		if (consumer)
			await deadline(consumer, 3000, "stream cleanup").catch(() => {});
	}
}

const evidence = {
	date: new Date().toISOString(),
	node: process.version,
	platform: `${process.platform}-${process.arch}`,
	requestedModel: model,
	runs: [] as Awaited<ReturnType<typeof measure>>[],
	credentialUnavailable: false,
	error: undefined as string | undefined,
	spawnedPids: [] as number[],
	allChildrenTerminated: false,
};
let scratch: string | undefined;
try {
	const token = await oauthToken();
	if (!token) {
		evidence.credentialUnavailable = true;
		process.exitCode = 2;
	} else {
		scratch = await mkdtemp(
			join(dirname(fileURLToPath(import.meta.url)), ".scratch-"),
		);
		const cwd = join(scratch, "work");
		const configDir = join(scratch, "config");
		await mkdir(cwd);
		await mkdir(configDir, { mode: 0o700 });
		for (let round = 1; round <= rounds; round++) {
			console.error(
				`round ${round}/${rounds}: fresh, empty input until ready + ${idleMs}ms`,
			);
			const fresh = await measure(round, cwd, configDir, token);
			evidence.runs.push(fresh);
			console.error(
				`round ${round}/${rounds}: resume of the just-created session`,
			);
			evidence.runs.push(
				await measure(round, cwd, configDir, token, fresh.sessionId),
			);
		}
	}
} catch (error) {
	// Do not dump raw errors/stderr which can include credentials or provider data.
	// Known SDK errors in this spike contain only lifecycle/auth failure messages.
	evidence.error =
		error instanceof Error ? error.message : "Unknown spike failure";
	process.exitCode = 1;
} finally {
	for (const child of children) await terminate(child);
	evidence.spawnedPids = children.flatMap((child) =>
		child.pid ? [child.pid] : [],
	);
	evidence.allChildrenTerminated = true;
	if (scratch) await rm(scratch, { recursive: true, force: true });
	console.log(JSON.stringify(evidence, null, 2));
}
