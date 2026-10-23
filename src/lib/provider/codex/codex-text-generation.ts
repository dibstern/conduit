import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { ProviderInstanceFailure } from "../errors.js";
import { modelParameterChoices } from "../turn-settings.js";
import type { ProviderInstance } from "../types.js";
import { discoverCodex } from "./codex-discovery.js";
import { prepareCodexAccount } from "./codex-home.js";

const McpServers = Schema.fromJsonString(
	Schema.Array(Schema.Struct({ name: Schema.String })),
);

/** One `codex exec` in an empty scratch folder, with every configured MCP server disabled. */
export const generateCodexText = (
	input: Parameters<ProviderInstance["generateTextEffect"]>[0],
	configDir = DEFAULT_CONFIG_DIR,
) =>
	Effect.gen(function* () {
		const account =
			input.account.driver === "codex" && input.model.providerId === "codex"
				? input.account
				: yield* Effect.fail(
						new Error(
							"Codex text generation requires a Codex account and model",
						),
					);
		const { home, env } = yield* prepareCodexAccount(account, configDir);
		const catalog = yield* discoverCodex(home, env, undefined, true);
		const model = catalog.models.find(({ id }) => id === input.model.modelId);
		if (!model)
			return yield* Effect.fail(new Error("Codex title model is not offered"));
		const choices = modelParameterChoices(model);
		const choice = input.effort
			? choices.resolve(input.effort)
			: Result.succeed(choices.cheapest());
		if (Result.isFailure(choice)) return yield* choice.failure;
		const effort = choice.success.values.find(
			({ id }) => id === "effort",
		)?.value;
		// Native values reach a TOML override, so only bare effort names are accepted.
		if (effort && !/^[a-z]+$/.test(effort))
			return yield* Effect.fail(
				new Error(`Unsupported Codex effort ${effort}`),
			);
		const binary = env["CONDUIT_CODEX_BINARY"] ?? "codex";
		const run = (argv: string[], cwd: string, stdin = "") =>
			Effect.tryPromise({
				try: (signal) =>
					new Promise<string>((resolve, reject) => {
						const child = execFile(
							binary,
							argv,
							{ cwd, env, signal, maxBuffer: 1024 * 1024 },
							(error, stdout) => (error ? reject(error) : resolve(stdout)),
						);
						child.stdin?.end(stdin);
					}),
				// Keep the child's error, whose message carries its stderr.
				catch: (cause) => cause,
			});
		const scratchRoot = join(configDir, "text-generation");
		return yield* Effect.acquireUseRelease(
			Effect.tryPromise(async () => {
				await mkdir(scratchRoot, { recursive: true });
				const directory = await mkdtemp(join(scratchRoot, "codex-"));
				await mkdir(join(directory, "work"));
				return directory;
			}),
			(directory) =>
				Effect.gen(function* () {
					const cwd = join(directory, "work");
					// Listing configuration does not connect to servers. Fail closed if it
					// fails, since an unenumerated server must never start for this call.
					const servers = yield* run(["mcp", "list", "--json"], cwd).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(McpServers)),
					);
					const overrides: string[] = [];
					for (const { name } of servers) {
						// CLI dotted overrides cannot address a server name containing a dot.
						if (!/^[A-Za-z0-9_-]+$/.test(name))
							return yield* Effect.fail(
								new Error("MCP server name cannot be safely disabled"),
							);
						overrides.push("-c", `mcp_servers.${name}.enabled=false`);
					}
					const lastMessage = join(directory, "last-message.txt");
					yield* run(
						[
							"exec",
							"--ephemeral",
							"-s",
							"read-only",
							"--skip-git-repo-check",
							"--output-last-message",
							lastMessage,
							"--model",
							input.model.modelId,
							...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
							...overrides,
							// The prompt carries user text: stdin keeps it out of argv parsing and ps.
							"-",
						],
						cwd,
						`${input.instructions}\n\n${input.prompt}`,
					);
					return (yield* Effect.tryPromise(() =>
						readFile(lastMessage, "utf8"),
					)).trim();
				}),
			(directory) =>
				Effect.tryPromise(() =>
					rm(directory, { recursive: true, force: true }),
				).pipe(Effect.ignore),
		);
	}).pipe(
		Effect.timeoutOrElse({
			duration: "30 seconds",
			orElse: () =>
				Effect.fail(new Error("Timed out waiting for Codex text generation")),
		}),
		Effect.mapError(
			(cause) =>
				new ProviderInstanceFailure({
					providerId: "codex",
					operation: "generateText",
					cause,
				}),
		),
	);
