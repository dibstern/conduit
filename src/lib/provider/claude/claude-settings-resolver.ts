import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Effect, Schema } from "effect";
import {
	CLAUDE_DISPLAYABLE_SETTINGS_KEYS,
	ClaudeSettingsResolveError,
	type ResolvedClaudeSettings,
	ResolvedClaudeSettingsSchema,
} from "../../contracts/claude-settings.js";
import { makeClaudeSdkEnv } from "./claude-sdk-env.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1_048_576;

export interface ClaudeSettingsChildRequest {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly timeoutMs: number;
}

export interface ClaudeSettingsChildResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly outputTooLarge: boolean;
}

export type ClaudeSettingsChildRunner = (
	request: ClaudeSettingsChildRequest,
) => Promise<ClaudeSettingsChildResult>;

const runClaudeSettingsChild: ClaudeSettingsChildRunner = ({
	cwd,
	env,
	timeoutMs,
}) =>
	new Promise((resolve, reject) => {
		const sdkModuleUrl = pathToFileURL(
			createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
		).href;
		const script = [
			`const { resolveSettings } = await import(${JSON.stringify(sdkModuleUrl)});`,
			"const result = await resolveSettings({ cwd: process.cwd(), settingSources: ['user', 'project', 'local'] });",
			`const keys = ${JSON.stringify(CLAUDE_DISPLAYABLE_SETTINGS_KEYS)};`,
			"const display = Object.fromEntries(keys.map(key => {",
			"  const { source, path, policyOrigin } = result.provenance[key] ?? {};",
			"  return [key, { value: result.effective[key], source, path, policyOrigin }];",
			"}));",
			"process.stdout.write(JSON.stringify(display));",
		].join("\n");
		const child = spawn(
			process.execPath,
			["--input-type=module", "--eval", script],
			{
				cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let timedOut = false;
		let outputTooLarge = false;
		let settled = false;

		const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > MAX_OUTPUT_BYTES) {
				outputTooLarge = true;
				child.kill("SIGKILL");
				return;
			}
			if (target === "stdout") stdout += chunk.toString("utf8");
			else stderr += chunk.toString("utf8");
		};

		child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);

		child.once("error", (cause) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(cause);
		});
		child.once("close", (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode, timedOut, outputTooLarge });
		});
	});

export const resolveClaudeSettingsFromDisk = (
	input: {
		readonly workspaceRoot: string;
		readonly configDir?: string | undefined;
		readonly timeoutMs?: number | undefined;
	},
	runChild: ClaudeSettingsChildRunner = runClaudeSettingsChild,
): Effect.Effect<ResolvedClaudeSettings, ClaudeSettingsResolveError> =>
	Effect.gen(function* () {
		const result = yield* Effect.tryPromise({
			try: () =>
				runChild({
					cwd: input.workspaceRoot,
					env: makeClaudeSdkEnv(
						input.configDir === undefined
							? undefined
							: { configDir: input.configDir },
					),
					timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				}),
			catch: (cause) =>
				new ClaudeSettingsResolveError({
					reason: "spawn-failed",
					message: `Claude settings resolver failed to start: ${String(cause)}`,
				}),
		});

		if (result.timedOut) {
			return yield* new ClaudeSettingsResolveError({
				reason: "timeout",
				message: `Claude settings resolver timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
			});
		}
		if (result.outputTooLarge) {
			return yield* new ClaudeSettingsResolveError({
				reason: "output-too-large",
				message: `Claude settings resolver exceeded ${MAX_OUTPUT_BYTES} bytes of output`,
			});
		}
		if (result.exitCode !== 0) {
			const detail = result.stderr.trim() || "no stderr output";
			return yield* new ClaudeSettingsResolveError({
				reason: "non-zero-exit",
				message: `Claude settings resolver exited with code ${String(result.exitCode)}: ${detail}`,
			});
		}

		const parsed = yield* Effect.try({
			try: () => JSON.parse(result.stdout),
			catch: () =>
				new ClaudeSettingsResolveError({
					reason: "invalid-json",
					message: "Claude settings resolver returned invalid JSON",
				}),
		});
		return yield* Schema.decodeUnknown(ResolvedClaudeSettingsSchema)(
			parsed,
		).pipe(
			Effect.mapError(
				() =>
					new ClaudeSettingsResolveError({
						reason: "invalid-result",
						message:
							"Claude settings resolver returned JSON that does not match the display settings contract",
					}),
			),
		);
	});
