#!/usr/bin/env node
import { appendFileSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	query as sdkQuery,
	resolveSettings as sdkResolveSettings,
} from "@anthropic-ai/claude-agent-sdk";
import { NodeRuntime } from "@effect/platform-node";
import { Cause, Deferred, Effect, Exit, FiberSet, Scope } from "effect";
import { createLogger } from "../lib/logger.js";
import {
	type ClaudeSessionRunnerDeps,
	makeClaudeSessionRunner,
} from "../lib/provider/claude/claude-provider-runtime.js";
import { makeClaudeRunnerIdleExit } from "../lib/provider/claude/claude-runner-idle.js";
import {
	CLAUDE_RUNNER_PROTOCOL_VERSION,
	ClaudeRunnerSocket,
	claudeRunnerBuildId,
	claudeRunnerFailure,
	claudeRunnerHelloFailure,
	claudeRunnerIdleFailure,
} from "../lib/provider/claude/claude-runner-protocol.js";
import {
	registerClaudeRunner,
	removeClaudeRunner,
} from "../lib/provider/claude/claude-runner-registry.js";
import {
	type ClaudeRunnerFileSettings,
	captureClaudeRunnerFileSettings,
	claudeRunnerFileSettingsFingerprint,
	replayClaudeRunnerFileSettings,
} from "../lib/provider/claude/claude-runner-settings.js";
import { ClaudeRunnerSpool } from "../lib/provider/claude/claude-runner-spool.js";
import type {
	ClaudeRunnerLiveQueryConfiguration,
	ClaudeRunnerSettingsSnapshot,
	ClaudeRunnerUpgradeState,
} from "../lib/provider/claude/claude-runner-upgrade.js";
import { makeClaudeSdkEnv } from "../lib/provider/claude/claude-sdk-env.js";
import { buildClaudeFlagSettings } from "../lib/provider/claude/claude-sdk-settings.js";
import type {
	ClaudeSessionFailure,
	ClaudeSessionRunner,
} from "../lib/provider/claude/claude-session-runner.js";
import { fromSdkPermissionMode } from "../lib/provider/claude/permission-mode-map.js";
import type { Options } from "../lib/provider/claude/types.js";
import type { PreWarmSessionInput, TurnResult } from "../lib/provider/types.js";

const log = createLogger("claude-session-runner");

const main = Effect.gen(function* () {
	const socketPath = process.argv[2];
	const sessionId = process.argv[3];
	const runnerId = process.argv[4];
	if (!socketPath || !sessionId || !runnerId || !process.send)
		return yield* Effect.die(
			"Claude runner requires a socket path and parent IPC",
		);
	const testModule = process.env["CONDUIT_TEST_CLAUDE_QUERY_MODULE"];
	let queryFactory: ClaudeSessionRunnerDeps["queryFactory"];
	let subagentSdk: ClaudeSessionRunnerDeps["subagentSdk"];
	let testSubagentPollTimeoutMs: number | undefined;
	let settingsResolver: typeof sdkResolveSettings | undefined =
		sdkResolveSettings;
	if (process.env["NODE_ENV"] === "test" && testModule) {
		const module = yield* Effect.tryPromise(
			() =>
				import(testModule) as Promise<{
					claudeSdk: {
						query: NonNullable<ClaudeSessionRunnerDeps["queryFactory"]>;
					};
					claudeSubagentSdk?: ClaudeSessionRunnerDeps["subagentSdk"];
					resolveSettings?: typeof sdkResolveSettings;
				}>,
		);
		if (typeof module.claudeSdk?.query !== "function")
			return yield* Effect.die(
				"Process test module must export a Claude query factory",
			);
		queryFactory = module.claudeSdk.query;
		subagentSdk = module.claudeSubagentSdk;
		const pollTimeout = Number(
			process.env["CONDUIT_TEST_SUBAGENT_POLL_TIMEOUT_MS"],
		);
		if (Number.isFinite(pollTimeout) && pollTimeout > 0)
			testSubagentPollTimeoutMs = pollTimeout;
		settingsResolver = module.resolveSettings;
		const { __setProbeOverrideForTesting } = yield* Effect.tryPromise(
			() => import("../lib/provider/claude/claude-capabilities-probe.js"),
		);
		__setProbeOverrideForTesting(async () => ({
			models: [],
			agents: [],
			commands: [],
		}));
	}
	const stopped = yield* Deferred.make<void>();
	const scope = yield* Effect.scope;
	const runFork = yield* FiberSet.makeRuntime<never, void, never>();
	let attached = false;
	let exiting = false;
	let retiring = false;
	let role: "candidate" | "retiring" | undefined =
		process.argv[5] === "upgrade" ? "candidate" : undefined;
	const register = () =>
		registerClaudeRunner({
			socketPath,
			sessionId,
			runnerId,
			buildId: claudeRunnerBuildId(),
			pid: process.pid,
			...(role ? { role } : {}),
		});
	let connection: ClaudeRunnerSocket | undefined;
	let idle: ReturnType<typeof makeClaudeRunnerIdleExit> | undefined;
	let exitDeadline: ReturnType<typeof setTimeout> | undefined;
	const beginExit = () => {
		if (exiting) return;
		exiting = true;
		idle?.close();
		// Neither an absent server acknowledgement nor SDK disposal can hold exit.
		exitDeadline = setTimeout(() => {
			removeClaudeRunner(socketPath);
			process.exit(0);
		}, 2000);
		exitDeadline.unref();
		if (connection) connection.write({ type: "idle-exit" });
		else finishExit();
	};
	function finishExit() {
		const delay =
			process.env["NODE_ENV"] === "test"
				? Number(process.env["CONDUIT_TEST_RUNNER_IDLE_EXIT_DELAY_MS"] ?? 0)
				: 0;
		runFork(
			Effect.sleep(delay).pipe(
				Effect.andThen(Deferred.succeed(stopped, undefined)),
				Effect.asVoid,
			),
		);
	}
	let runner: ClaudeSessionRunner | undefined;
	let shellEnv: Readonly<Record<string, string | undefined>> = process.env;
	let initializing = false;
	const spool = new ClaudeRunnerSpool(`${socketPath}.spool`);
	let snapshot: ClaudeRunnerSettingsSnapshot | undefined;
	let frozenSnapshot: ClaudeRunnerSettingsSnapshot | undefined;
	let fileSettings: ClaudeRunnerFileSettings | undefined;
	let fileSettingsPreparation: Promise<void> | undefined;
	let replayedSettings:
		| Pick<Options, "settings" | "settingSources">
		| undefined;
	let launchInput: PreWarmSessionInput | undefined;
	let launchSettings: ClaudeRunnerSettingsSnapshot["claudeSettingsOverrides"];
	let resumeSessionId: string | undefined;
	let liveConfiguration: ClaudeRunnerLiveQueryConfiguration | undefined;
	let activeCommands = 0;
	let activeOutputs = 0;
	let revision = 0;
	let reportedQuiescent: boolean | undefined;
	let reportedSnapshot: ClaudeRunnerSettingsSnapshot | undefined;
	let reportedResume: string | undefined;
	let reportedConfiguration: ClaudeRunnerLiveQueryConfiguration | undefined;
	const quiescent = () =>
		!exiting &&
		!retiring &&
		activeCommands === 0 &&
		activeOutputs === 0 &&
		!runner?.hasPendingSubagentFinalizers?.(sessionId) &&
		idle?.quiescent === true;
	const upgradeState = (): ClaudeRunnerUpgradeState => ({
		quiescent: quiescent(),
		revision,
		...(snapshot ? { snapshot } : {}),
		...(resumeSessionId ? { resumeSessionId } : {}),
		...(liveConfiguration ? { liveConfiguration } : {}),
		...(frozenSnapshot ? { frozen: true } : {}),
	});
	const reportUpgradeState = () => {
		const quiet = quiescent();
		if (
			quiet === reportedQuiescent &&
			snapshot === reportedSnapshot &&
			resumeSessionId === reportedResume &&
			liveConfiguration === reportedConfiguration
		)
			return;
		reportedQuiescent = quiet;
		const changedSnapshot = snapshot !== reportedSnapshot;
		reportedSnapshot = snapshot;
		reportedResume = resumeSessionId;
		reportedConfiguration = liveConfiguration;
		revision++;
		if (attached)
			connection?.write({
				type: "upgrade-state",
				state: {
					quiescent: quiet,
					revision,
					...(changedSnapshot && snapshot ? { snapshot } : {}),
					...(resumeSessionId ? { resumeSessionId } : {}),
					...(liveConfiguration ? { liveConfiguration } : {}),
					...(frozenSnapshot ? { frozen: true } : {}),
				},
			});
	};
	const createQuery: NonNullable<ClaudeSessionRunnerDeps["queryFactory"]> = (
		params,
	) => {
		const options = params.options;
		if (!options || !launchInput)
			throw new Error("Claude runner launch input is missing");
		const { abortController, canUseTool, resume, ...launch } = options;
		const restoring = frozenSnapshot !== undefined && snapshot === undefined;
		const frozenLaunch: Options | undefined = frozenSnapshot
			? {
					...frozenSnapshot.options,
					...(options.model ? { model: options.model } : {}),
					...(options.effort ? { effort: options.effort } : {}),
					...(options.permissionMode
						? { permissionMode: options.permissionMode }
						: {}),
				}
			: undefined;
		if (frozenLaunch && !options.effort) delete frozenLaunch.effort;
		if (frozenLaunch && !options.permissionMode)
			delete frozenLaunch.permissionMode;
		const effectiveOptions =
			restoring && frozenSnapshot
				? {
						...frozenLaunch,
						...(abortController ? { abortController } : {}),
						...(canUseTool ? { canUseTool } : {}),
						...(resume ? { resume } : {}),
					}
				: frozenSnapshot
					? {
							...options,
							...(frozenSnapshot.options.settings !== undefined
								? { settings: frozenSnapshot.options.settings }
								: {}),
							...(frozenSnapshot.options.env
								? { env: frozenSnapshot.options.env }
								: {}),
						}
					: options;
		const queryOptions = { ...effectiveOptions, ...replayedSettings };
		const query = (queryFactory ?? sdkQuery)({
			...params,
			options: queryOptions,
		});
		const {
			abortController: _abort,
			canUseTool: _tool,
			resume: _resume,
			...effectiveLaunch
		} = queryOptions;
		const retainedFiles = frozenSnapshot?.fileSettings ?? fileSettings;
		const capturedFiles =
			retainedFiles &&
			(queryOptions.settingSources?.length === 0 ||
				(retainedFiles.fingerprint !== undefined &&
					retainedFiles.fingerprint ===
						claudeRunnerFileSettingsFingerprint(queryOptions)))
				? retainedFiles
				: undefined;
		snapshot =
			(restoring ? frozenSnapshot : undefined) ??
			(JSON.parse(
				JSON.stringify({
					input: launchInput,
					...((frozenSnapshot?.claudeSettingsOverrides ?? launchSettings)
						? {
								claudeSettingsOverrides:
									frozenSnapshot?.claudeSettingsOverrides ?? launchSettings,
							}
						: {}),
					options: frozenSnapshot ? effectiveLaunch : launch,
					...(capturedFiles ? { fileSettings: capturedFiles } : {}),
				}),
			) as ClaudeRunnerSettingsSnapshot);
		if (
			!restoring &&
			queryOptions.settingSources?.length !== 0 &&
			snapshot.fileSettings
		) {
			// Validate at SDK readiness, before the foreground turn can change files.
			// A completed control command cannot settle another query's capture.
			const captured = snapshot;
			void query.initializationResult().then(
				() => {
					if (snapshot !== captured) return;
					if (
						captured.fileSettings?.fingerprint !==
						claudeRunnerFileSettingsFingerprint(queryOptions)
					) {
						const { fileSettings: _files, ...launch } = captured;
						snapshot = launch;
					}
					reportUpgradeState();
				},
				() => {
					if (snapshot !== captured) return;
					const { fileSettings: _files, ...launch } = captured;
					snapshot = launch;
					reportUpgradeState();
				},
			);
		}
		if (resume) resumeSessionId = resume;
		if (process.env["NODE_ENV"] === "test") {
			const mark = {
				channel: "conduit-process-test",
				kind: "runner-snapshot",
				pid: process.pid,
				sessionId,
				snapshotJson: JSON.stringify(snapshot),
			};
			const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
			if (proof) appendFileSync(proof, `${JSON.stringify(mark)}\n`);
			if (process.connected) process.send?.(mark);
		}
		reportUpgradeState();
		return query;
	};
	const bindings = new Map<string, { sessionId: string; commandId?: string }>();
	const commands = new Map<
		string,
		Deferred.Deferred<TurnResult | undefined, ClaudeSessionFailure>
	>();
	const completedCommands = new Map<
		string,
		{ commandId: string; result?: TurnResult; failure?: ClaudeSessionFailure }
	>();
	const server = createServer((socket) => {
		if (connection) {
			socket.destroy();
			return;
		}
		let greeted = false;
		const peer = new ClaudeRunnerSocket(
			socket,
			(message) => {
				if (message.type === "idle-exit-ack" && exiting) {
					finishExit();
					return;
				}
				if (message.type === "hello") {
					const failure = exiting
						? claudeRunnerIdleFailure()
						: (claudeRunnerHelloFailure(message, "server") ??
							(greeted || initializing || !message.config
								? claudeRunnerFailure(
										"runner hello",
										"Claude runner refused invalid or repeated server hello",
									)
								: undefined));
					if (failure) {
						log.error(failure.message);
						peer.refuse(failure);
						return;
					}
					initializing = true;
					const config = message.config;
					if (!config) return;
					runFork(
						Effect.gen(function* () {
							if (!runner) {
								runner = yield* makeClaudeSessionRunner(
									{
										...config,
										shellEnv: () => shellEnv,
										queryFactory: createQuery,
										prepareQuery: async () => {
											// First warming prepares the snapshot in the command path.
											// Revalidate native sources only when creating another query.
											if (
												!frozenSnapshot ||
												!snapshot ||
												replayedSettings?.settingSources?.length === 0 ||
												!settingsResolver
											)
												return;
											replayedSettings = await replayClaudeRunnerFileSettings(
												frozenSnapshot.fileSettings,
												frozenSnapshot.options,
												settingsResolver,
											);
										},
										...(subagentSdk ? { subagentSdk } : {}),
										...(testSubagentPollTimeoutMs !== undefined
											? { subagentPollTimeoutMs: testSubagentPollTimeoutMs }
											: {}),
										onSubagentFinalizationComplete: reportUpgradeState,
									},
									(output) => {
										idle?.activity(output);
										activeOutputs++;
										reportUpgradeState();
										return spool.emit(output).pipe(
											Effect.ensuring(
												Effect.sync(() => {
													activeOutputs--;
													reportUpgradeState();
												}),
											),
										);
									},
								).pipe(Effect.provideService(Scope.Scope, scope));
								const testIdle =
									process.env["NODE_ENV"] === "test"
										? process.env["CONDUIT_TEST_RUNNER_IDLE_MS"]
										: undefined;
								idle = makeClaudeRunnerIdleExit(
									beginExit,
									testIdle === "null"
										? null
										: testIdle !== undefined
											? Number(testIdle)
											: undefined,
									process.env["NODE_ENV"] === "test" &&
										process.env["CONDUIT_TEST_RUNNER_IDLE_DAY_MS"]
										? Number(process.env["CONDUIT_TEST_RUNNER_IDLE_DAY_MS"])
										: undefined,
									config.daemonConfigDir,
									() =>
										retiring ||
										activeCommands > 0 ||
										activeOutputs > 0 ||
										runner?.hasPendingSubagentFinalizers?.(sessionId) ===
											true ||
										spool.hasHeldWork,
								);
							}
							if (
								process.env["NODE_ENV"] === "test" &&
								process.env["CONDUIT_TEST_RUNNER_HELLO_DELAY_MS"]
							) {
								process.send?.({
									channel: "conduit-process-test",
									kind: "runner-hello-pending",
									pid: process.pid,
								});
								yield* Effect.sleep(
									Number(process.env["CONDUIT_TEST_RUNNER_HELLO_DELAY_MS"]),
								);
							}
							idle?.activity();
							greeted = true;
							peer.write({
								type: "hello",
								protocolVersion:
									process.env["NODE_ENV"] === "test" &&
									process.env["CONDUIT_TEST_RUNNER_HELLO_VERSION"]
										? Number(process.env["CONDUIT_TEST_RUNNER_HELLO_VERSION"])
										: CLAUDE_RUNNER_PROTOCOL_VERSION,
								buildId: claudeRunnerBuildId(),
								runnerId,
								sessionId,
								pid: process.pid,
								bindings: [...bindings].map(([sinkId, binding]) => ({
									sinkId,
									...binding,
								})),
								pendingOutputs: spool.pendingOutputs,
								completedCommands: [...completedCommands.values()],
								upgradeState: upgradeState(),
							});
							initializing = false;
						}),
					);
				} else if (message.type === "replay") {
					if (
						!greeted ||
						!Number.isSafeInteger(message.acknowledgedSequence) ||
						message.acknowledgedSequence < 0
					) {
						peer.destroy();
						return;
					}
					attached = true;
					if (retiring && !message.preserveRole) {
						retiring = false;
						role = undefined;
						register();
					}
					spool.attach(peer, message.acknowledgedSequence);
					reportedQuiescent = undefined;
					reportUpgradeState();
				} else if (message.type === "output-reply") {
					spool.reply(message);
					reportUpgradeState();
				} else if (message.type === "upgrade-retire") {
					const ready =
						greeted && attached && message.revision === revision && quiescent();
					if (ready) {
						retiring = true;
						role = "retiring";
						register();
					}
					peer.write({
						type: "upgrade-reply",
						requestId: message.requestId,
						result: ready,
					});
				} else if (message.type === "upgrade-cancel") {
					retiring = false;
					role = undefined;
					register();
					reportUpgradeState();
				} else if (message.type === "upgrade-activate") {
					role = undefined;
					register();
				} else if (message.type === "command" && runner) {
					// An interrupted first turn can leave the durable cursor unset.
					// Match the resumed warm query before the runtime selects it.
					const command =
						message.command.type === "send-turn" &&
						frozenSnapshot &&
						resumeSessionId &&
						typeof message.command.input.providerState["resumeSessionId"] !==
							"string"
							? {
									...message.command,
									input: {
										...message.command.input,
										providerState: {
											...message.command.input.providerState,
											resumeSessionId,
										},
									},
								}
							: message.command;
					if (exiting) {
						peer.write({
							type: "command-reply",
							commandId: message.commandId,
							failure: claudeRunnerIdleFailure(),
						});
						return;
					}
					// Retirement is a reservation until the server commits its route.
					// A command selected on the old route cancels it without waiting.
					if (retiring && command.type !== "shutdown") {
						retiring = false;
						role = undefined;
						register();
					}
					if (command.type === "send-turn") {
						peer.write({
							type: "command-accepted",
							commandId: message.commandId,
							sinkId: command.sinkId,
						});
						idle?.beginTurn();
					}
					idle?.activity();
					activeCommands++;
					const deduplicationKey = `${message.commandId}:${message.attempt ?? 0}`;
					if (command.type === "send-turn" || command.type === "pre-warm")
						shellEnv = command.shellEnv ?? process.env;
					if (command.type === "send-turn" || command.type === "pre-warm") {
						if (command.type === "pre-warm" && command.settingsSnapshot)
							frozenSnapshot = command.settingsSnapshot;
						const input = command.input;
						launchInput = {
							sessionId: input.sessionId,
							workspaceRoot: input.workspaceRoot,
							extraFolders: input.extraFolders ?? [],
							providerState: input.providerState,
							...(input.model ? { model: input.model } : {}),
							...(input.configDir ? { configDir: input.configDir } : {}),
							...(input.permissionMode
								? { permissionMode: input.permissionMode }
								: {}),
							...(input.variant ? { variant: input.variant } : {}),
							...(input.contextWindow
								? { contextWindow: input.contextWindow }
								: {}),
							...(input.agent ? { agent: input.agent } : {}),
						};
						launchSettings = command.claudeSettingsOverrides;
						liveConfiguration = {
							...(input.model ? { model: input.model } : {}),
							...(input.contextWindow
								? { contextWindow: input.contextWindow }
								: {}),
							...(input.variant ? { variant: input.variant } : {}),
							...(input.permissionMode
								? { permissionMode: input.permissionMode }
								: {}),
						};
					}
					if (command.type === "send-turn") {
						bindings.set(command.sinkId, {
							sessionId: command.input.sessionId,
							...(command.input.commandId !== undefined
								? { commandId: command.input.commandId }
								: {}),
						});
					}
					reportUpgradeState();
					if (process.env["NODE_ENV"] === "test" && process.connected)
						process.send?.({
							channel: "conduit-process-test",
							kind: "runner-command",
							commandId: message.commandId,
							type: command.type,
						});
					runFork(
						Effect.gen(function* () {
							const existing = commands.get(deduplicationKey);
							if (existing) return yield* Deferred.await(existing);
							const result = yield* Deferred.make<
								TurnResult | undefined,
								ClaudeSessionFailure
							>();
							commands.set(deduplicationKey, result);
							if (!runner)
								return yield* Effect.die("Claude runner is not initialized");
							if (
								(command.type === "pre-warm" || command.type === "send-turn") &&
								settingsResolver &&
								(!resumeSessionId || (frozenSnapshot && !replayedSettings))
							) {
								const resolver = settingsResolver;
								const input = command.input;
								const options: Options = frozenSnapshot?.options ?? {
									cwd: input.workspaceRoot,
									...(input.extraFolders?.length > 0
										? { additionalDirectories: [...input.extraFolders] }
										: {}),
									settingSources: ["user", "project", "local"],
									settings: buildClaudeFlagSettings(
										command.claudeSettingsOverrides,
									),
									env: makeClaudeSdkEnv({
										configDir:
											input.configDir ??
											(typeof input.providerState["claudeConfigDir"] ===
											"string"
												? input.providerState["claudeConfigDir"]
												: undefined),
										baseEnv: shellEnv,
									}),
								};
								if (!fileSettingsPreparation)
									fileSettingsPreparation = (async () => {
										try {
											// The public resolver has no env parameter. Preserve the
											// SDK's distinction between explicit and default config roots.
											const configDir = options.env?.["CLAUDE_CONFIG_DIR"];
											if (configDir)
												process.env["CLAUDE_CONFIG_DIR"] = resolve(
													options.cwd ?? process.cwd(),
													configDir,
												);
											else {
												delete process.env["CLAUDE_CONFIG_DIR"];
												if (
													options.env?.["HOME"] &&
													resolve(options.env["HOME"]) !== resolve(homedir())
												)
													throw new Error(
														"Claude settings HOME cannot match the SDK resolver; retaining the old runner",
													);
											}
											if (frozenSnapshot)
												replayedSettings = await replayClaudeRunnerFileSettings(
													frozenSnapshot.fileSettings,
													options,
													resolver,
												);
											else
												fileSettings = await captureClaudeRunnerFileSettings(
													options,
													resolver,
												);
										} catch (cause) {
											if (frozenSnapshot) throw cause;
											log.warn(
												"Unable to capture Claude file settings for runner upgrade",
												cause,
											);
										}
									})();
								const preparation = fileSettingsPreparation;
								yield* Effect.tryPromise({
									try: () => preparation,
									catch: (cause) =>
										claudeRunnerFailure("prepare runner settings", cause),
								}).pipe(
									Effect.ensuring(
										Effect.sync(() => {
											fileSettingsPreparation = undefined;
										}),
									),
								);
							}
							const exit = yield* Effect.exit(
								runner.executeEffect(command).pipe(
									Effect.tap(() => {
										const frozen = frozenSnapshot;
										const resolver = settingsResolver;
										if (
											command.type !== "pre-warm" ||
											!frozen ||
											!resolver ||
											replayedSettings?.settingSources?.length === 0
										)
											return Effect.void;
										// Native sources must remain unchanged through SDK readiness.
										return Effect.tryPromise({
											try: async () => {
												const current = await captureClaudeRunnerFileSettings(
													frozen.options,
													resolver,
												);
												if (
													!frozen.fileSettings ||
													current.fingerprint !==
														frozen.fileSettings.fingerprint ||
													!isDeepStrictEqual(
														current.resolved,
														frozen.fileSettings.resolved,
													)
												)
													throw new Error(
														"Claude settings changed while warming; retaining the old runner",
													);
											},
											catch: (cause) =>
												claudeRunnerFailure("verify runner settings", cause),
										});
									}),
								),
							);
							if (
								Exit.isSuccess(exit) &&
								command.type === "apply-live-settings"
							) {
								const {
									contextWindow: _window,
									variant: _variant,
									...current
								} = liveConfiguration ?? {};
								liveConfiguration = {
									...current,
									...(command.settings.modelId
										? {
												model: {
													providerId: "claude",
													modelId: command.settings.modelId,
												},
											}
										: {}),
									...(command.settings.contextWindow
										? { contextWindow: command.settings.contextWindow }
										: {}),
									...(command.settings.variant
										? { variant: command.settings.variant }
										: {}),
								};
							}
							if (
								Exit.isSuccess(exit) &&
								command.type === "set-permission-mode"
							) {
								const mode = fromSdkPermissionMode(command.mode);
								if (mode)
									liveConfiguration = {
										...liveConfiguration,
										permissionMode: mode,
									};
							}
							yield* Deferred.done(result, exit);
							return yield* Deferred.await(result);
						}).pipe(
							Effect.ensuring(
								Effect.gen(function* () {
									// Interrupts can finish before an SDK result carries updates.
									const cursor = yield* runner?.getResumeSessionIdEffect?.(
										sessionId,
									) ?? Effect.succeed(undefined);
									if (cursor !== undefined)
										resumeSessionId = cursor ?? undefined;
									if (command.type === "send-turn") idle?.endTurn();
									activeCommands--;
									reportUpgradeState();
								}),
							),
							Effect.matchCauseEffect({
								onFailure: (cause) =>
									Effect.sync(() => {
										completedCommands.set(message.commandId, {
											commandId: message.commandId,
											failure: claudeRunnerFailure(
												command.type,
												Cause.squash(cause),
											),
										});
										connection?.write({
											type: "command-reply",
											commandId: message.commandId,
											failure: claudeRunnerFailure(
												command.type,
												Cause.squash(cause),
											),
										});
									}),
								onSuccess: (result) =>
									Effect.gen(function* () {
										if (command.type === "shutdown")
											yield* spool
												.drainEffect()
												.pipe(Effect.timeout("500 millis"), Effect.ignore);
										completedCommands.set(message.commandId, {
											commandId: message.commandId,
											...(result ? { result } : {}),
										});
										const resumed = result?.providerStateUpdates.find(
											(update) => update.key === "resumeSessionId",
										);
										if (typeof resumed?.value === "string")
											resumeSessionId = resumed.value;
										reportUpgradeState();
										connection?.write({
											type: "command-reply",
											commandId: message.commandId,
											...(result ? { result } : {}),
										});
										if (command.type === "shutdown")
											runFork(
												Deferred.succeed(stopped, undefined).pipe(
													Effect.asVoid,
												),
											);
									}),
							}),
						),
					);
				}
			},
			() => {
				spool.disconnect(peer);
				if (connection === peer) {
					attached = false;
					connection = undefined;
					if (exiting) finishExit();
				}
			},
		);
		connection = peer;
	});
	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			idle?.close();
			clearTimeout(exitDeadline);
			connection?.destroy();
			server.close();
			removeClaudeRunner(socketPath);
		}),
	);
	yield* Effect.tryPromise(
		() =>
			new Promise<void>((done, fail) => {
				server.once("error", fail);
				server.listen(socketPath, () => {
					chmodSync(socketPath, 0o600);
					done();
				});
			}),
	);
	register();
	process.send({ channel: "conduit-claude-runner", type: "listening" });
	yield* Deferred.await(stopped);
});

NodeRuntime.runMain(Effect.scoped(main));
