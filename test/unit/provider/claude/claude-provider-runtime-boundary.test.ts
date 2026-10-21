import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../../src/lib/contracts/provider-instance.js";
import * as configPersistence from "../../../../src/lib/daemon/config-persistence.js";
import {
	makeClaudeProviderRuntime,
	makeClaudeSessionRunner,
} from "../../../../src/lib/provider/claude/claude-provider-runtime.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import type {
	Query,
	SDKMessage,
	Options as SDKOptions,
} from "../../../../src/lib/provider/claude/types.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../../../../src/lib/relay/relay-settings.js";
import { makeTestClaudeProviderInstance } from "../../../helpers/claude-provider-instance.js";
import { getClaudeRuntimeSessionCountForTest } from "../../../helpers/claude-runtime-state.js";
import {
	createMockQuery,
	makeBaseSendTurnInput,
	makeSuccessResult,
} from "../../../helpers/mock-sdk.js";

function makeBlockingQuery(
	streamStarted: Deferred.Deferred<void>,
	releaseStream: Deferred.Deferred<void>,
): Query {
	const release = async () => {
		await Effect.runPromise(Deferred.succeed(releaseStream, undefined));
	};
	const stream = {
		async next() {
			await Effect.runPromise(Deferred.succeed(streamStarted, undefined));
			await Effect.runPromise(Deferred.await(releaseStream));
			return { done: true, value: undefined };
		},
		async return() {
			await release();
			return { done: true, value: undefined };
		},
		async throw(error?: unknown) {
			throw error;
		},
		[Symbol.asyncIterator]() {
			return this;
		},
		async [Symbol.asyncDispose]() {
			await release();
		},
	} as AsyncGenerator<SDKMessage, void, unknown>;

	return Object.assign(stream, {
		interrupt: vi.fn(release),
		close: vi.fn(() => {
			Effect.runFork(Deferred.succeed(releaseStream, undefined));
		}),
		setModel: vi.fn(async () => {}),
		setPermissionMode: vi.fn(async () => {}),
		streamInput: vi.fn(async () => {}),
		setMaxThinkingTokens: vi.fn(async () => {}),
		applyFlagSettings: vi.fn(async () => {}),
		initializationResult: vi.fn(async () => ({})),
		supportedCommands: vi.fn(async () => []),
		supportedModels: vi.fn(async () => []),
		supportedAgents: vi.fn(async () => []),
		mcpServerStatus: vi.fn(async () => []),
		getContextUsage: vi.fn(async () => ({})),
		reloadPlugins: vi.fn(async () => ({})),
		accountInfo: vi.fn(async () => ({})),
		rewindFiles: vi.fn(async () => ({ canRewind: false })),
		seedReadState: vi.fn(async () => {}),
		reconnectMcpServer: vi.fn(async () => {}),
		toggleMcpServer: vi.fn(async () => {}),
		setMcpServers: vi.fn(async () => ({})),
		stopTask: vi.fn(async () => {}),
		next: stream.next.bind(stream),
		return: stream.return.bind(stream),
		throw: stream.throw.bind(stream),
		[Symbol.asyncIterator]: () => stream,
	}) as unknown as Query;
}

describe("Claude provider runtime boundary", () => {
	// Sends and warm-ups must use the admitted account even with conflicting
	// native, project and process folders; neither may reread daemon accounts.
	it.each([
		"send",
		"prewarm",
	] as const)("launches %s from its carried account without disk account reads", async (operation) => {
		const capturedOptions: SDKOptions[] = [];
		vi.stubEnv("HOME", "/tmp/g4zp-test-home");
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/g4zp-test-process-folder");
		const account = {
			id: AccountIdSchema.make("selected-account"),
			name: "Selected account",
			driver: "claude" as const,
			folder: configuredClaudeConfigDir("/tmp/g4zp-test-account-folder"),
			env: { ANTHROPIC_API_KEY: "test-account-key" },
			usageEligible: false,
		};
		const loadConfig = vi
			.spyOn(configPersistence, "loadDaemonConfigResult")
			.mockImplementation(() => {
				throw new Error("Account launch must not reread daemon config");
			});
		try {
			const instance = makeTestClaudeProviderInstance({
				workspaceRoot: "/tmp/g4zp-test-project",
				shellEnv: () => ({
					HOME: "/tmp/g4zp-test-home",
					CLAUDE_CONFIG_DIR: "/tmp/g4zp-test-project-folder",
					ANTHROPIC_API_KEY: "test-project-key",
				}),
				queryFactory: ({ options }) => {
					if (options) capturedOptions.push(options);
					return createMockQuery([makeSuccessResult()]);
				},
			});
			const input = makeBaseSendTurnInput({
				account,
				instanceId: "historical-account",
				configDir: undefined,
				model: { providerId: "claude", modelId: "sonnet" },
			});
			if (operation === "send") {
				await Effect.runPromise(instance.sendTurnEffect(input));
				expect(
					await Effect.runPromise(instance.getNativeSessionEffect("session-1")),
				).toMatchObject({
					instanceId: account.id,
					configDir: account.folder,
				});
			} else {
				await Effect.runPromise(instance.preWarmSessionEffect(input));
			}
			expect(capturedOptions).toHaveLength(1);
			expect(capturedOptions[0]?.env).toMatchObject({
				CLAUDE_CONFIG_DIR: account.folder.path,
				ANTHROPIC_API_KEY: "test-account-key",
			});
			expect(loadConfig).not.toHaveBeenCalled();
		} finally {
			loadConfig.mockRestore();
			vi.unstubAllEnvs();
		}
	});

	it("uses only the default SDK settings without an overrides getter", async () => {
		const capturedSettings: SDKOptions["settings"][] = [];
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: "/tmp/ws",
			queryFactory: ({ options }: { options?: SDKOptions }) => {
				capturedSettings.push(options?.settings);
				return createMockQuery([makeSuccessResult()]);
			},
		});

		await Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "session-default-settings",
					model: { providerId: "claude", modelId: "sonnet" },
				}),
			),
		);

		expect(capturedSettings).toEqual([{ showThinkingSummaries: true }]);
	});

	it("reads and merges SDK settings overrides at each session start", async () => {
		const capturedSettings: SDKOptions["settings"][] = [];
		const configDir = mkdtempSync(join(tmpdir(), "conduit-claude-settings-"));
		saveRelaySettings(
			{ claudeSettings: { autoCompactEnabled: false } },
			configDir,
		);
		const claudeSettingsOverrides = vi.fn(
			() => loadRelaySettings(configDir).claudeSettings,
		);
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: "/tmp/ws",
			queryFactory: ({ options }: { options?: SDKOptions }) => {
				capturedSettings.push(options?.settings);
				return createMockQuery([makeSuccessResult()]);
			},
			claudeSettingsOverrides,
		});

		await Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "session-overrides-one",
					inputId: "turn-1",
					model: { providerId: "claude", modelId: "sonnet" },
				}),
			),
		);
		saveRelaySettings(
			{ claudeSettings: { autoCompactEnabled: true } },
			configDir,
		);
		await Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "session-overrides-two",
					inputId: "turn-2",
					model: { providerId: "claude", modelId: "sonnet" },
				}),
			),
		);

		expect(capturedSettings).toEqual([
			{ showThinkingSummaries: true, autoCompactEnabled: false },
			{ showThinkingSummaries: true, autoCompactEnabled: true },
		]);
		expect(claudeSettingsOverrides).toHaveBeenCalledTimes(2);
		rmSync(configDir, { recursive: true, force: true });
	});

	it("removes trust-tiered keys from SDK settings overrides", async () => {
		const capturedSettings: SDKOptions["settings"][] = [];
		const instance = makeTestClaudeProviderInstance({
			workspaceRoot: "/tmp/ws",
			queryFactory: ({ options }: { options?: SDKOptions }) => {
				capturedSettings.push(options?.settings);
				return createMockQuery([makeSuccessResult()]);
			},
			claudeSettingsOverrides: () => ({
				permissions: { allow: ["Bash(*)"] },
				autoMode: true,
			}),
		});

		await Effect.runPromise(
			instance.sendTurnEffect(
				makeBaseSendTurnInput({
					sessionId: "session-trust-settings",
					model: { providerId: "claude", modelId: "sonnet" },
				}),
			),
		);

		expect(capturedSettings[0]).not.toHaveProperty("permissions");
		expect(capturedSettings[0]).not.toHaveProperty("autoMode");
		expect(capturedSettings).toEqual([{ showThinkingSummaries: true }]);
	});

	it("closes active SDK sessions from the scoped runtime finalizer", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const streamStarted = yield* Deferred.make<void>();
				const releaseStream = yield* Deferred.make<void>();
				const query = makeBlockingQuery(streamStarted, releaseStream);
				const scope = yield* Scope.make();
				const runtime = yield* makeClaudeProviderRuntime({
					runnerFactory: makeClaudeSessionRunner,
					daemonConfigDir: configPersistence.getConfigDir(),
					workspaceRoot: "/tmp/ws",
					queryFactory: () => query,
				}).pipe(Effect.provideService(Scope.Scope, scope));
				const instance = runtime;

				const turnFiber = yield* Effect.forkChild(
					instance
						.sendTurnEffect(
							makeBaseSendTurnInput({
								sessionId: "scoped-shutdown",
								model: { providerId: "claude", modelId: "sonnet" },
							}),
						)
						.pipe(Effect.result),
				);
				yield* Deferred.await(streamStarted).pipe(
					Effect.timeoutOrElse({
						duration: "1 second",
						orElse: () =>
							Effect.fail((() => new Error("Claude stream did not start"))()),
					}),
				);

				yield* Scope.close(scope, Exit.void);
				const turnResult = yield* Fiber.join(turnFiber);

				expect(query.interrupt).toHaveBeenCalledTimes(1);
				expect(query.close).toHaveBeenCalledTimes(1);
				expect(getClaudeRuntimeSessionCountForTest(instance)).toBe(0);
				expect(turnResult._tag).toBe("Failure");
			}),
		);
	});

	it("declares per-task stop and forwards it without interrupting or closing the query", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const started = yield* Deferred.make<void>();
					const released = yield* Deferred.make<void>();
					const query = makeBlockingQuery(started, released);
					let options: SDKOptions | undefined;
					const runtime = yield* makeClaudeProviderRuntime({
						runnerFactory: makeClaudeSessionRunner,
						daemonConfigDir: configPersistence.getConfigDir(),
						workspaceRoot: "/tmp/ws",
						queryFactory: (params) => {
							options = params.options;
							return query;
						},
					});
					const instance = runtime;
					const turn = yield* Effect.forkChild(
						instance
							.sendTurnEffect(
								makeBaseSendTurnInput({
									sessionId: "task-stop",
									model: { providerId: "claude", modelId: "sonnet" },
								}),
							)
							.pipe(Effect.result),
					);
					yield* Deferred.await(started);
					expect(options?.perTaskStopAffordance).toBe(true);
					yield* instance.stopTaskEffect("task-stop", "shell");
					expect(query.stopTask).toHaveBeenCalledWith("shell");
					expect(query.interrupt).not.toHaveBeenCalled();
					expect(query.close).not.toHaveBeenCalled();
					vi.mocked(query.stopTask).mockRejectedValueOnce(
						new Error("SDK unavailable"),
					);
					const failure = yield* Effect.result(
						instance.stopTaskEffect("task-stop", "shell"),
					);
					expect(failure._tag).toBe("Failure");
					expect(query.close).not.toHaveBeenCalled();
					// Composer Stop retains its existing teardown behavior.
					yield* instance.interruptTurnEffect("task-stop");
					expect(query.close).toHaveBeenCalledOnce();
					yield* Fiber.join(turn);
				}),
			),
		);
	});
});
