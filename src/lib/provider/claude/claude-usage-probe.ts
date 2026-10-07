import { query } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { makeClaudeSdkEnv } from "./claude-sdk-env.js";
import {
	decodeClaudeUsage,
	type QuotaCheckResult,
} from "./claude-usage-schema.js";
import {
	closeClaudeEmptyQuery,
	makeClaudeEmptyQuery,
} from "./claude-warmed-query.js";
import type { Options, SDKUserMessage } from "./types.js";

export interface ClaudeQuotaAccount {
	readonly id: string;
	readonly configDir?: string;
	readonly env?: Readonly<Record<string, string>>;
}

/** This is the one provider boundary used by the daemon's quota decisions. */
export interface ClaudeUsageProbe {
	readonly probe: (
		account: ClaudeQuotaAccount,
	) => Effect.Effect<QuotaCheckResult>;
}

interface UsageQuery {
	initializationResult(): Promise<unknown>;
	usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options?: {
		skipBehaviors?: boolean;
	}): Promise<unknown>;
	close(): void;
}

export interface ClaudeUsageProbeOptions {
	readonly queryFactory?: (params: {
		prompt: AsyncIterable<SDKUserMessage>;
		options?: Options;
	}) => UsageQuery;
	readonly prepareQuery?: () => Promise<void>;
	readonly cwd?: string;
	readonly shellEnv?: Readonly<Record<string, string | undefined>>;
}

function probeFailure(error: unknown, stderr: string): QuotaCheckResult {
	const cause =
		error !== null && typeof error === "object" && "cause" in error
			? error.cause
			: error;
	const message = `${cause instanceof Error ? cause.message : String(cause)}\n${stderr}`;
	// Network failures and experimental-control drift cannot veto a user action.
	return /not logged in|not authenticated|login required|please log in|please run \/login|authentication failed|authentication_error|invalid_api_key|invalid (?:oauth |authentication )?(?:token|credentials)|unauthorized/i.test(
		message,
	)
		? { _tag: "Unavailable", reason: "Claude account authentication failed" }
		: { _tag: "Unknown" };
}

export const makeClaudeUsageProbe = (
	options: ClaudeUsageProbeOptions = {},
): ClaudeUsageProbe => ({
	probe: (account) =>
		Effect.suspend(() => {
			let stderr = "";
			return Effect.acquireUseRelease(
				makeClaudeEmptyQuery(
					options.queryFactory ?? query,
					(abortController) => ({
						cwd: options.cwd ?? process.cwd(),
						abortController,
						env: makeClaudeSdkEnv({
							configDir: account.configDir,
							baseEnv: { ...(options.shellEnv ?? process.env), ...account.env },
						}),
						persistSession: false,
						settingSources: ["user"],
						settings: { disableAllHooks: true },
						tools: [],
						stderr: (chunk) => {
							stderr = `${stderr}${chunk}`.slice(-4096);
						},
					}),
					options.prepareQuery,
				).pipe(Effect.interruptible),
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
				Effect.catchAll((error) => Effect.succeed(probeFailure(error, stderr))),
			);
		}),
});
