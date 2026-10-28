import { query } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import type { UsageRead, UsageReader } from "../usage-reader.js";
import {
	type ClaudeConfigDir,
	configuredClaudeConfigDir,
	makeClaudeSdkEnv,
} from "./claude-sdk-env.js";
import { decodeClaudeUsage } from "./claude-usage-schema.js";
import {
	closeClaudeEmptyQuery,
	makeClaudeEmptyQuery,
} from "./claude-warmed-query.js";
import type { Options, SDKUserMessage } from "./types.js";

interface UsageQuery {
	initializationResult(): Promise<unknown>;
	usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options?: {
		skipBehaviors?: boolean;
	}): Promise<unknown>;
	close(): void;
}

export interface ClaudeUsageReaderOptions {
	readonly queryFactory?: (params: {
		configDir: ClaudeConfigDir;
		prompt: AsyncIterable<SDKUserMessage>;
		options?: Options;
	}) => UsageQuery;
	readonly prepareQuery?: () => Promise<void>;
	readonly cwd?: string;
	readonly shellEnv?: Readonly<Record<string, string | undefined>>;
}

function usageFailure(error: unknown, stderr: string): UsageRead {
	const cause =
		error !== null && typeof error === "object" && "cause" in error
			? error.cause
			: error;
	const message = `${cause instanceof Error ? cause.message : String(cause)}\n${stderr}`;
	// Network failures and experimental-control drift cannot veto a user action.
	return /not logged in|not authenticated|login required|please log in|please run \/login|authentication failed|authentication_error|invalid_api_key|invalid (?:oauth |authentication )?(?:token|credentials)|unauthorized/i.test(
		message,
	)
		? {
				status: "unavailable",
				windows: [],
				reason: "Claude account authentication failed",
			}
		: { status: "unknown", windows: [] };
}

export const makeClaudeUsageReader = (
	options: ClaudeUsageReaderOptions = {},
): UsageReader => ({
	read: (account) =>
		Effect.suspend(() => {
			let stderr = "";
			const baseEnv = { ...(options.shellEnv ?? process.env), ...account.env };
			const folder =
				account.folder ??
				(account.configDir === undefined
					? undefined
					: configuredClaudeConfigDir(account.configDir));
			if (folder === undefined)
				return Effect.fail(
					new Error(`Claude usage account ${account.id} requires a folder`),
				);
			const launch = {
				configDir: folder,
				killProcessGroup: true,
			};
			return Effect.acquireUseRelease(
				makeClaudeEmptyQuery(
					options.queryFactory ?? query,
					(abortController) => ({
						cwd: options.cwd ?? process.cwd(),
						abortController,
						env: makeClaudeSdkEnv({
							...launch,
							baseEnv,
						}),
						persistSession: false,
						settingSources: ["user"],
						settings: { disableAllHooks: true },
						tools: [],
						stderr: (chunk) => {
							stderr = `${stderr}${chunk}`.slice(-4096);
						},
					}),
					launch,
					options.prepareQuery,
				),
				(resource) =>
					Effect.gen(function* () {
						yield* Effect.tryPromise({
							try: () => resource.query.initializationResult(),
							catch: (cause) => cause,
						});
						const response = yield* Effect.tryPromise({
							try: () =>
								resource.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(
									{ skipBehaviors: true },
								),
							catch: (cause) => cause,
						});
						return decodeClaudeUsage(response);
					}),
				closeClaudeEmptyQuery,
			).pipe(
				Effect.catch((error) => Effect.succeed(usageFailure(error, stderr))),
			);
		}),
});
