// Failure modes: a fresh/resumed/forked/warm query omits the opt-out, or a
// retained runner snapshot re-enables checkpointing after an upgrade.
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { buildClaudeQueryOptions } from "../../../../src/lib/provider/claude/claude-query-options.js";
import { makeClaudeRunnerLaunch } from "../../../../src/lib/provider/claude/claude-runner-launch.js";
import {
	configuredClaudeConfigDir,
	makeClaudeSdkEnv,
} from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	closeClaudeEmptyQuery,
	makeClaudeEmptyQuery,
} from "../../../../src/lib/provider/claude/claude-warmed-query.js";
import type {
	ClaudePreWarmSessionInput,
	Options,
} from "../../../../src/lib/provider/claude/types.js";
import type { SessionCommand } from "../../../../src/lib/provider/runner/session-runner.js";

const { queryFactory } = vi.hoisted(() => ({ queryFactory: vi.fn() }));

vi.mock(
	"../../../../src/lib/provider/claude/claude-sdk-module.js",
	async () => {
		const { Effect } = await import("effect");
		const { createMockQuery } = await import("../../../helpers/mock-sdk.js");
		queryFactory.mockImplementation(() => createMockQuery([]));
		return {
			loadClaudeSdkTestModule: Effect.succeed({
				claudeSdk: { query: queryFactory },
			}),
		};
	},
);

afterEach(() => queryFactory.mockClear());

const input: ClaudePreWarmSessionInput = {
	sessionId: "checkpoint-session",
	workspaceRoot: "/private/tmp",
	extraFolders: [],
	providerState: {},
	configDir: configuredClaudeConfigDir("/private/tmp/checkpoint-account"),
	folderSource: "account",
	model: { providerId: "claude", modelId: "sonnet" },
};

it.each([
	["new", {}],
	["resume", { resumeSessionId: "native-parent" }],
	[
		"fork",
		{
			resumeSessionId: "native-parent",
			forkSession: true,
			resumeSessionAt: "native-message",
		},
	],
] as const)("disables file checkpointing for %s session options", (_kind, continuation) => {
	const options = buildClaudeQueryOptions(
		{ ...input, ...continuation },
		new AbortController(),
		async () => ({ behavior: "deny", message: "No tools in this test" }),
		undefined,
		{},
	);
	expect(options.enableFileCheckpointing).toBe(false);
});

it.each([
	"baseEnv",
	"accountEnv",
] as const)("disables file checkpointing inherited through %s", (source) => {
	const env = makeClaudeSdkEnv({
		configDir: input.configDir,
		[source]: { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true" },
	});
	expect(env["CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING"]).toBe("false");
});

it("disables file checkpointing at the idle query launch boundary", async () => {
	let fileCheckpointing: boolean | undefined;
	const launch = vi.fn(({ options }: { options?: Options }) => {
		fileCheckpointing = options?.enableFileCheckpointing;
		return { close() {} };
	});
	await Effect.runPromise(
		Effect.acquireUseRelease(
			makeClaudeEmptyQuery(launch, () => ({ enableFileCheckpointing: true }), {
				configDir: input.configDir,
			}),
			() => Effect.void,
			closeClaudeEmptyQuery,
		),
	);
	expect(launch).toHaveBeenCalledOnce();
	expect(fileCheckpointing).toBe(false);
});

it.each([
	"fresh",
	"snapshot-omitted",
	"snapshot-enabled",
] as const)("disables file checkpointing when warming a %s runner", async (mode) => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const launch = yield* makeClaudeRunnerLaunch({
					sessionId: input.sessionId,
					runFork: () => undefined,
					stateChanged: () => {},
					isCandidate: () => false,
					isBackgroundBusy: () => false,
					turnStateChanged: () => {},
					queryStarted: () => {},
					isReplacedQuery: () => false,
					readThread: () => Effect.succeed({ items: [] }),
				});
				const runner = yield* launch.makeRunner(
					{ workspaceRoot: input.workspaceRoot },
					() => Effect.succeed({}),
				);
				const command: Extract<SessionCommand, { type: "pre-warm" }> = {
					type: "pre-warm",
					sessionId: input.sessionId,
					input,
					...(mode === "fresh"
						? {}
						: {
								settingsSnapshot: {
									input,
									options: {
										env: { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true" },
										settingSources: [],
										...(mode === "snapshot-enabled"
											? { enableFileCheckpointing: true }
											: {}),
									},
								},
							}),
				};
				launch.acceptCommand(command);
				yield* launch.executeEffect(runner, command);
				expect(queryFactory).toHaveBeenCalledOnce();
				expect(
					queryFactory.mock.calls[0]?.[0]?.options?.enableFileCheckpointing,
				).toBe(false);
				expect(
					queryFactory.mock.calls[0]?.[0]?.options?.env?.[
						"CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING"
					],
				).toBe("false");
			}),
		),
	);
});
