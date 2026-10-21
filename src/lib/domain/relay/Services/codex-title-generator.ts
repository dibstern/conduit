import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import type { Account } from "../../../contracts/account.js";
import type { Logger } from "../../../logger.js";
import { prepareCodexAccount } from "../../../provider/codex/codex-home.js";
import {
	generationFailureReason,
	SessionTitleGenerationFailure,
	type TitleGenerator,
} from "./title-generator.js";

const TITLE_GENERATION_TIMEOUT_MS = 30_000;
const TITLE_SCHEMA = {
	type: "object",
	properties: { title: { type: "string" } },
	required: ["title"],
	additionalProperties: false,
};
const TitleResult = Schema.fromJsonString(
	Schema.Struct({ title: Schema.String }),
);
const McpServers = Schema.fromJsonString(
	Schema.Array(Schema.Struct({ name: Schema.String })),
);

export const makeCodexTitleGenerator = (options: {
	readonly account: Account;
	readonly configDir: string | undefined;
	readonly sessionModel: string | null | undefined;
	readonly log: Logger;
}): TitleGenerator => {
	// Cost is unknown for other models. Let the selected account choose its default.
	const model = options.sessionModel?.match(/(?:^|[-/])(?:mini|nano)(?:[-/]|$)/)
		? options.sessionModel
		: undefined;
	return ({ prompt, cwd }) =>
		Effect.gen(function* () {
			const { env } = yield* prepareCodexAccount(
				options.account,
				options.configDir,
			);
			const binary = env["CONDUIT_CODEX_BINARY"] ?? "codex";
			const run = (argv: string[], input = "") =>
				Effect.tryPromise({
					try: (signal) =>
						new Promise<string>((resolve, reject) => {
							const child = execFile(
								binary,
								argv,
								{
									cwd,
									env,
									signal,
									timeout: TITLE_GENERATION_TIMEOUT_MS,
									maxBuffer: 1024 * 1024,
								},
								(error, stdout) => (error ? reject(error) : resolve(stdout)),
							);
							child.stdin?.end(input);
						}),
					catch: (cause) =>
						new SessionTitleGenerationFailure({
							reason: generationFailureReason(cause),
						}),
				});
			// Listing configuration does not connect to servers. Fail closed if listing
			// fails, since an unenumerated server must never start for a title request.
			const servers = yield* run(["mcp", "list", "--json"]).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(McpServers)),
			);
			const overrides: string[] = [];
			for (const { name } of servers) {
				// CLI dotted overrides cannot address a server name containing a dot.
				if (!/^[A-Za-z0-9_-]+$/.test(name))
					return yield* new SessionTitleGenerationFailure({
						reason: "MCP server name cannot be safely disabled",
					});
				overrides.push("-c", `mcp_servers.${name}.enabled=false`);
			}
			options.log.debug(
				`Codex title generation model: ${model ?? "account default"}`,
			);
			return yield* Effect.acquireUseRelease(
				Effect.tryPromise(() =>
					mkdtemp(join(tmpdir(), "conduit-codex-title-")),
				),
				(directory) =>
					Effect.gen(function* () {
						const schema = join(directory, "schema.json");
						const lastMessage = join(directory, "last-message.json");
						yield* Effect.tryPromise(() =>
							writeFile(schema, JSON.stringify(TITLE_SCHEMA)),
						);
						yield* run(
							[
								"exec",
								"--ephemeral",
								"-s",
								"read-only",
								"--output-schema",
								schema,
								"--skip-git-repo-check",
								"--output-last-message",
								lastMessage,
								...overrides,
								...(model ? ["--model", model] : []),
								// The prompt carries user text: stdin keeps it out of argv parsing and ps.
								"-",
							],
							prompt,
						);
						return yield* Effect.tryPromise(() =>
							readFile(lastMessage, "utf8"),
						).pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(TitleResult)),
							Effect.map(({ title }) => title),
						);
					}),
				(directory) =>
					Effect.tryPromise(() =>
						rm(directory, { recursive: true, force: true }),
					).pipe(Effect.ignore),
			);
		}).pipe(
			Effect.mapError(
				(cause) =>
					new SessionTitleGenerationFailure({
						reason: generationFailureReason(cause),
					}),
			),
			Effect.timeoutOrElse({
				duration: "30 seconds",
				orElse: () =>
					Effect.fail(
						new SessionTitleGenerationFailure({
							reason: "Timed out waiting for Codex title generation",
						}),
					),
			}),
		);
};
