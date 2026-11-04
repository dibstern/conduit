import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { tracingChannel } from "node:diagnostics_channel";
import { appendFileSync, chmodSync, existsSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { Deferred, Effect, FiberSet, Scope } from "effect";
import * as Failure from "../../effect/failure-classification.js";
import { createLogger } from "../../logger.js";
import { createEventId } from "../../persistence/events.js";
import type { SendToken } from "../run-ledger/run-ledger-model.js";
import type { TurnResult } from "../types.js";
import { makeRunnerIdleExit } from "./runner-idle.js";
import {
	RUNNER_PROTOCOL_VERSION,
	type RunnerHello,
	RunnerSocket,
	type RunnerWireCodec,
	runnerBuildId,
	runnerFailure,
	runnerHelloFailure,
	runnerIdleFailure,
} from "./runner-protocol.js";
import {
	registerRunner,
	removeRunnerDiscovery,
	runnerPidAlive,
	runnerProcessTable,
} from "./runner-registry.js";
import { RunnerSendJournal } from "./runner-send-journal.js";
import { RunnerSpool } from "./runner-spool.js";
import type {
	RunnerSourceDelivery,
	RunnerUpgradeState,
} from "./runner-upgrade.js";
import {
	currentRunnerQuery,
	type NativeSessionRunner,
	type SessionCommand,
	type SessionFailure,
	type SessionOutput,
	type SessionOutputReply,
} from "./session-runner.js";

export type RunnerRole =
	| { readonly _tag: "Serving" }
	| { readonly _tag: "Reserved"; readonly revision: string }
	| { readonly _tag: "Candidate" };

export function decideRunnerRole(
	role: RunnerRole,
	event:
		| {
				readonly _tag: "Retire";
				readonly revision: string;
				readonly quiescent: boolean;
		  }
		| { readonly _tag: "Command"; readonly activates: boolean }
		| { readonly _tag: "Cancel" | "Activate" | "Hello" },
): RunnerRole {
	switch (event._tag) {
		case "Retire":
			return role._tag === "Serving" && event.quiescent
				? { _tag: "Reserved", revision: event.revision }
				: role;
		case "Activate":
			return role._tag === "Candidate" ? { _tag: "Serving" } : role;
		case "Command":
			// Only the serving row's runner is held a send, so a command reaching
			// a Candidate means its swap committed (CONTRACT 2507-2511).
			if (role._tag === "Candidate")
				return event.activates ? { _tag: "Serving" } : role;
			return role._tag === "Reserved" ? { _tag: "Serving" } : role;
		case "Cancel":
		case "Hello":
			return role._tag === "Reserved" ? { _tag: "Serving" } : role;
	}
}

export interface RunnerLaunchCallbacks {
	readonly sessionId: string;
	readonly runFork: (effect: Effect.Effect<void>) => unknown;
	readonly stateChanged: () => void;
	/** Fence admission before a payload publishes its final turn outcome. */
	readonly retireAfterCommand?: (inputId: string) => void;
	readonly isCandidate: () => boolean;
	/** A rebind excludes the executing send's own command and admitted turn. */
	readonly isBackgroundBusy: (ignoredCommands?: number) => boolean;
	readonly turnStateChanged: (inFlight: boolean) => void;
	/** Every native query start after the host's first is a replacement (CONTRACT 6.1); true for one. */
	readonly queryStarted: (query: object) => boolean;
	/** True for a query the host has seen replaced; no query (Codex, Cursor) is never replaced (6.1). */
	readonly isReplacedQuery: (query: object | undefined) => boolean;
	/** Only the producer can finish this exact terminal delivery. */
	readonly sourceDelivery?: (
		source: Pick<RunnerSourceDelivery, "sessionId" | "inputId" | "runId">,
	) => (() => void) | undefined;
	readonly readThread: RunnerSocket["threadReadEffect"];
	readonly markServer: RunnerSocket["serverMarkEffect"];
}

export interface RunnerLaunch {
	/** Retire a poisoned payload after delivering its command result. */
	readonly shouldExitAfterCommand?: (
		command: SessionCommand,
		result: TurnResult | undefined,
	) => boolean;
	readonly wire?: RunnerWireCodec;
	readonly capabilities?: Pick<
		RunnerHello,
		| "stopsTasks"
		| "taggedConfigDir"
		| "rebindsAccount"
		| "declaresLogin"
		| "cursorBackendUrl"
	>;
	readonly makeRunner: (
		config: NonNullable<RunnerHello["config"]>,
		emit: (
			output: SessionOutput,
		) => Effect.Effect<SessionOutputReply, SessionFailure>,
	) => Effect.Effect<NativeSessionRunner, never, Scope.Scope>;
	readonly upgradeState: () => Omit<
		RunnerUpgradeState,
		"quiescent" | "turnInFlight" | "revision"
	>;
	readonly acceptCommand: (command: SessionCommand) => void;
	readonly changesAccount?: (
		command: Extract<SessionCommand, { type: "send-turn" }>,
	) => boolean;
	readonly executeEffect: (
		runner: NativeSessionRunner,
		command: SessionCommand,
	) => Effect.Effect<TurnResult | undefined, SessionFailure>;
}

const log = createLogger("session-runner");

// Only this runner holds the pipe's write end. No daemon connection is involved.
const reaperScript = `
trap '' TERM HUP INT
group=$1
set -- $(LC_ALL=C ps -o pgid= -p $$)
[ "$1" = "$group" ] || exit 0
printf 'ready\\n'
exec 1>/dev/null
groups=
# The runner reports each detached child's group as it starts (+id) and once it empties (-id).
while IFS= read -r line; do
  id=\${line#?}
  case $id in ''|*[!0-9]*) continue ;; esac
  case $line in
    +*) groups="$groups $id" ;;
    -*) kept=; for g in $groups; do [ "$g" = "$id" ] || kept="$kept $g"; done; groups=$kept ;;
  esac
done
# EOF can precede the parent's actual exit while its exit handlers are running.
while :; do
  set -- $(LC_ALL=C ps -o ppid= -p $$)
  [ "$1" = "$group" ] || break
  sleep 0.05
done
kill -s TERM -- "-$group" 2>/dev/null || :
for g in $groups; do kill -s TERM -- "-$g" 2>/dev/null || :; done
deadline=$(( $(date +%s) + 3 ))
polls=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  # exec keeps ps a direct child, so the reaper never waits on its own ps.
  members=$(LC_ALL=C exec ps -axo pid=,pgid=,ppid=,stat=) || break
  remaining=0
  while read -r member pgid parent state; do
    case "$state" in Z*) continue ;; esac
    [ "$member" != "$$" ] && [ "$parent" != "$$" ] || continue
    case " $group $groups " in *" $pgid "*) remaining=1; break ;; esac
  done <<MEMBERS
$members
MEMBERS
  [ "$remaining" = 1 ] || break
  polls=$((polls + 1))
  # About a second in, before the daemon's KILL of this group at 3 s can end the reaper.
  [ "$polls" = 20 ] && for g in $groups; do kill -s KILL -- "-$g" 2>/dev/null || :; done
  sleep 0.05
done
for g in $groups; do kill -s KILL -- "-$g" 2>/dev/null || :; done
kill -s KILL -- "-$group" 2>/dev/null
`;

/**
 * Agent tools start detached children in their own session and group (Cursor's shell, live check
 * 2026-11-04), which the group kill misses. Each one's group is reported to the reaper as it
 * starts, so the list outlives this runner. CONTRACT.md 2447-2449 leaves such descendants as a
 * limit; this narrows it to commands that leave the group the runner started.
 */
const reportDetachedGroups = (reaperInput: Writable) => {
	const groups = new Set<number>();
	// A group id can be reused only once the group is empty, so it is dropped then and not before.
	const prune = () => {
		for (const group of groups)
			if (!runnerPidAlive(-group)) {
				groups.delete(group);
				reaperInput.write(`-${group}\n`);
			}
	};
	setInterval(prune, 10_000).unref();
	tracingChannel<{
		readonly process: ChildProcess;
		readonly options: SpawnOptions;
	}>("child_process.spawn").subscribe({
		start: ({ process: child, options }) => {
			if (!options.detached) return;
			child.once("spawn", () => {
				if (child.pid === undefined) return;
				groups.add(child.pid);
				reaperInput.write(`+${child.pid}\n`);
			});
			child.once("exit", prune);
		},
	});
};

// Allow delayed source ACKs under load without approaching the daemon's send deadline.
const SOURCE_DELIVERY_ADMISSION_WAIT_MS = 2_000;

export const runSessionRunner = (
	driverKind: string,
	makeLaunch: (
		callbacks: RunnerLaunchCallbacks,
	) => Effect.Effect<RunnerLaunch, SessionFailure>,
) =>
	Effect.gen(function* () {
		const socketPath = process.argv[2];
		const sessionId = process.argv[3];
		const runnerId = process.argv[4];
		if (!socketPath || !sessionId || !runnerId || !process.send)
			return yield* Effect.die("Runner requires a socket path and parent IPC");
		let reaperWarning = false;
		const warnReaper = (cause: unknown) => {
			if (reaperWarning) return;
			reaperWarning = true;
			log.warn(
				"Runner reaper unavailable; retaining leader-only capability",
				cause,
			);
		};
		const reaper = yield* Effect.tryPromise({
			try: () =>
				new Promise<NonNullable<RunnerHello["reaper"]>>((done, fail) => {
					const child = spawn(
						"/bin/sh",
						["-c", reaperScript, "runner-reaper", String(process.pid)],
						{
							detached: false,
							stdio: ["pipe", "pipe", "ignore"],
						},
					);
					// Retain the write end until process exit, even though it is unref'd.
					process.once("exit", () => child.stdin.destroy());
					child.unref();
					if (child.stdin instanceof Socket) child.stdin.unref();
					child.stdin.on("error", warnReaper);
					let finished = false;
					let ready = "";
					const finish = (
						identity?: NonNullable<RunnerHello["reaper"]>,
						cause?: unknown,
					) => {
						if (finished) return;
						finished = true;
						clearTimeout(timeout);
						if (child.stdout instanceof Socket) child.stdout.unref();
						if (identity) {
							reportDetachedGroups(child.stdin);
							done(identity);
						} else fail(cause ?? "Reaper exited before startup completed");
					};
					const timeout = setTimeout(
						() => finish(undefined, "Reaper startup timed out"),
						2000,
					);
					child.once("error", (cause) => finish(undefined, cause));
					child.once("exit", () => finish());
					child.stdout.once("end", () => finish());
					child.stdout.on("data", (chunk: Buffer) => {
						ready += chunk.toString();
						if (!ready.includes("\n")) return;
						if (ready !== "ready\n" || child.pid === undefined) return finish();
						const current = runnerProcessTable.inspect(child.pid);
						if (
							current.state !== "running" ||
							current.startTime === undefined ||
							current.pgid !== process.pid
						)
							return finish(undefined, "Reaper identity could not be verified");
						finish({ pid: child.pid, startTime: current.startTime });
					});
				}),
			catch: (cause) => cause,
		}).pipe(
			Effect.catch((cause) =>
				Effect.sync(() => {
					warnReaper(cause);
					return undefined;
				}),
			),
		);
		const stopped = yield* Deferred.make<void>();
		const scope = yield* Effect.scope;
		const runFork = yield* FiberSet.makeRuntime<never, void, never>();
		let attached = false;
		let exiting = false;
		let retirementInputId: string | undefined;
		let role: RunnerRole =
			process.argv[5] === "upgrade"
				? { _tag: "Candidate" }
				: { _tag: "Serving" };
		const register = () =>
			registerRunner({
				socketPath,
				sessionId,
				runnerId,
				driverKind,
				buildId: runnerBuildId(),
				pid: process.pid,
			});
		let connection: RunnerSocket | undefined;
		let idle: ReturnType<typeof makeRunnerIdleExit> | undefined;
		let exitDeadline: ReturnType<typeof setTimeout> | undefined;
		const beginExit = () => {
			if (exitDeadline !== undefined) return;
			exiting = true;
			invalidateSourceDelivery();
			idle?.close();
			// Neither an absent server acknowledgement nor SDK disposal can hold exit.
			exitDeadline = setTimeout(() => {
				removeRunnerDiscovery(socketPath);
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
		let runner: NativeSessionRunner | undefined;
		let sendJournal: RunnerSendJournal | undefined;
		let initializing = false;
		let helloCount = 0;
		// The host owns querySeq; a surviving host keeps it across daemon reconnects (6.1).
		let querySeq = 0;
		let currentQuery: object | undefined;
		const isReplacedQuery = (query: object | undefined) =>
			query !== undefined && query !== currentQuery;
		const querySeqs = new WeakMap<object, number>();
		const spool = new RunnerSpool(`${socketPath}.spool`, () => querySeq);
		let backgroundSnapshot:
			| Extract<SessionOutput, { type: "background-task" }>
			| undefined;
		// 8.3: the last task snapshot, empty included, so an attaching server learns the set without
		// another SDK message.
		let tasksSnapshot:
			| {
					readonly output: Extract<SessionOutput, { type: "event" }>;
					readonly querySeq: number;
			  }
			| undefined;
		let activeCommands = 0;
		let activeOutputs = 0;
		let revision = 0;
		let turnInFlight = false;
		let reportedTurnInFlight: boolean | undefined;
		let reportedQuiescent: boolean | undefined;
		let sourceDelivery: RunnerSourceDelivery | undefined;
		let sourceDeliveryInvalidated: Deferred.Deferred<void> | undefined;
		const sourceDeliveryAborts = new Map<string, Deferred.Deferred<void>>();
		let reportedDelivery: RunnerSourceDelivery | undefined;
		let deliveryGeneration = 0;
		let sourceSinkId: string | undefined;
		let reportedSnapshot: RunnerUpgradeState["snapshot"];
		let reportedResume: string | undefined;
		let reportedConfiguration: RunnerUpgradeState["liveConfiguration"];
		// A rebind check ignores the executing send's own command and turn.
		const hostBusy = (ignoredCommands = 0) =>
			activeCommands > ignoredCommands ||
			activeOutputs > 0 ||
			runner?.hasPendingSubagentFinalizers?.(sessionId) === true;
		const isBackgroundBusy = (ignoredCommands = 0) =>
			hostBusy(ignoredCommands) || idle?.isQuiescent(ignoredCommands) !== true;
		const quiescent = () =>
			!exiting &&
			retirementInputId === undefined &&
			role._tag !== "Reserved" &&
			!isBackgroundBusy();
		const upgradeState = (): RunnerUpgradeState => ({
			quiescent: quiescent(),
			turnInFlight,
			revision,
			...launch.upgradeState(),
			...(sourceDelivery ? { sourceDelivery } : {}),
		});
		const reportUpgradeState = () => {
			const { snapshot, resumeSessionId, liveConfiguration, frozen } =
				launch.upgradeState();
			const quiet = quiescent();
			if (
				quiet === reportedQuiescent &&
				sourceDelivery === reportedDelivery &&
				turnInFlight === reportedTurnInFlight &&
				snapshot === reportedSnapshot &&
				resumeSessionId === reportedResume &&
				liveConfiguration === reportedConfiguration
			)
				return;
			reportedQuiescent = quiet;
			reportedDelivery = sourceDelivery;
			reportedTurnInFlight = turnInFlight;
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
						turnInFlight,
						revision,
						...(sourceDelivery ? { sourceDelivery } : {}),
						...(changedSnapshot && snapshot ? { snapshot } : {}),
						...(resumeSessionId ? { resumeSessionId } : {}),
						...(liveConfiguration ? { liveConfiguration } : {}),
						...(frozen ? { frozen: true } : {}),
					},
				});
		};
		const invalidateSourceDelivery = () => {
			if (!sourceDelivery) return;
			sourceDelivery = undefined;
			const invalidated = sourceDeliveryInvalidated;
			sourceDeliveryInvalidated = undefined;
			if (invalidated) Deferred.doneUnsafe(invalidated, Effect.void);
			reportUpgradeState();
		};
		const retireWhenQuiescent = () => {
			if (retirementInputId !== undefined && !isBackgroundBusy()) beginExit();
		};
		const launch = yield* makeLaunch({
			sessionId,
			runFork,
			stateChanged: () => {
				reportUpgradeState();
				retireWhenQuiescent();
			},
			retireAfterCommand: (inputId) => {
				retirementInputId = inputId;
			},
			isCandidate: () => role._tag === "Candidate",
			isBackgroundBusy,
			turnStateChanged: (inFlight) => {
				turnInFlight = inFlight;
				idle?.setTurnInFlight(inFlight);
				reportUpgradeState();
				if (!inFlight) retireWhenQuiescent();
			},
			queryStarted: (query) => {
				if (query === currentQuery) return false;
				const replaced = currentQuery !== undefined;
				if (replaced) querySeq++;
				currentQuery = query;
				querySeqs.set(query, querySeq);
				return replaced;
			},
			isReplacedQuery,
			sourceDelivery: (source) => {
				const owner = sourceSinkId ? bindings.get(sourceSinkId) : undefined;
				if (
					source.sessionId !== sessionId ||
					!sourceSinkId ||
					!owner?.token ||
					owner.sessionId !== source.sessionId ||
					owner.inputId !== source.inputId ||
					owner.runId !== source.runId
				)
					return;
				const delivery: RunnerSourceDelivery = {
					...source,
					runnerId,
					token: owner.token,
					sinkId: sourceSinkId,
					generation: ++deliveryGeneration,
				};
				const invalidated = Deferred.makeUnsafe<void>();
				const previousInvalidated = sourceDeliveryInvalidated;
				sourceDeliveryInvalidated = invalidated;
				sourceDelivery = delivery;
				if (previousInvalidated)
					Deferred.doneUnsafe(previousInvalidated, Effect.void);
				reportUpgradeState();
				let finishing = false;
				return () => {
					if (sourceDelivery !== delivery || finishing) return;
					finishing = true;
					// Idle/release notices return before ACK, but their sequence is already allocated.
					const acknowledged = spool.drainThroughEffect();
					runFork(
						Effect.raceFirst(acknowledged, Deferred.await(invalidated)).pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									// A late fence belongs to its old producer, never its successor.
									if (sourceDelivery === delivery) invalidateSourceDelivery();
								}),
							),
						),
					);
				};
			},
			readThread: (input) =>
				connection && attached && !connection.closed
					? connection.threadReadEffect(input)
					: Effect.fail(runnerFailure("read thread", "Runner is disconnected")),
			markServer: (input) =>
				connection && attached && !connection.closed
					? connection.serverMarkEffect(input)
					: Effect.fail(runnerFailure("mark server", "Runner is disconnected")),
		});
		const bindings = new Map<
			string,
			{
				sessionId: string;
				inputId?: string;
				runId?: string;
				token?: SendToken;
				providerRunId?: string;
				released?: boolean;
			}
		>();
		const commands = new Map<
			string,
			Deferred.Deferred<TurnResult | undefined, SessionFailure>
		>();
		const completedCommands = new Map<
			string,
			{
				commandId: string;
				result?: TurnResult;
				failure?: SessionFailure;
			}
		>();
		const interruptedRuns = new Set<string>();
		const sockets = new Set<Socket>();
		let connectionDrained: Effect.Effect<void> = Effect.void;
		const attachSocket = (socket: Socket, drained: Deferred.Deferred<void>) => {
			if (socket.destroyed) {
				Deferred.doneUnsafe(drained, Effect.void);
				return;
			}
			let greeted = false;
			const peer = new RunnerSocket(
				socket,
				(message) => {
					if (message.type === "idle-exit-ack" && exiting) {
						finishExit();
						return;
					}
					if (message.type === "hello") {
						const failure = exiting
							? runnerIdleFailure()
							: (runnerHelloFailure(message, "server", driverKind) ??
								(greeted || initializing || !message.config
									? runnerFailure(
											"runner hello",
											"Runner refused invalid or repeated server hello",
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
									sendJournal = yield* Effect.try({
										try: () =>
											new RunnerSendJournal(
												dirname(socketPath),
												sessionId,
												driverKind,
												{ allowOpaqueFences: true },
											),
										catch: (cause) => runnerFailure("open runner sends", cause),
									});
									runner = yield* launch
										.makeRunner(config, (output) =>
											Effect.gen(function* () {
												// 6.1: a replaced query's output is dropped at capture, by
												// identity. Its acceptance and terminal facts, and cleanup of
												// what it opened (gap: 6.1 names no cleanup), still go out
												// under its own querySeq.
												const origin = yield* currentRunnerQuery;
												if (
													isReplacedQuery(origin) &&
													!(output.type === "event"
														? [
																"run.started",
																"turn.completed",
																"turn.error",
																"turn.interrupted",
															].includes(output.event.type)
														: [
																"release-sink",
																"cancel-interaction",
																"cancel-interactions",
																"resolve-permission",
																"resolve-question",
															].includes(output.type))
												)
													return output.type === "event" ||
														output.type === "background-task" ||
														output.type === "account-usage"
														? {}
														: yield* Effect.fail(
																runnerFailure(
																	"query fence",
																	"The query that produced this output was replaced",
																),
															);
												if (
													output.type === "event" &&
													output.event.type === "evidence.tasks_snapshot"
												)
													// Under its own querySeq: a replaced query's set is not the new one's (6.1).
													tasksSnapshot = {
														output,
														querySeq: origin
															? (querySeqs.get(origin) ?? querySeq)
															: querySeq,
													};
												if (output.type === "background-task") {
													backgroundSnapshot =
														output.transition.kind === "snapshot" &&
														output.transition.tasks.length > 0
															? output
															: undefined;
												}
												idle?.activity(output);
												activeOutputs++;
												reportUpgradeState();
												const binding =
													"sinkId" in output
														? bindings.get(output.sinkId)
														: undefined;
												if (
													binding &&
													binding.sessionId === sessionId &&
													output.type === "event" &&
													output.event.sessionId === sessionId &&
													output.event.type === "run.started" &&
													typeof output.event.data === "object" &&
													output.event.data !== null &&
													"inputId" in output.event.data &&
													output.event.data.inputId === binding.inputId &&
													output.event.runId
												) {
													binding.runId = output.event.runId;
													sourceSinkId = output.sinkId;
												}
												const runId =
													output.type === "event"
														? output.event.providerRefs.providerTurnId
														: undefined;
												if (output.type === "release-sink" && binding)
													binding.released = true;
												const recordRun =
													runId &&
													binding?.token &&
													sendJournal &&
													binding.providerRunId !== runId
														? sendJournal
																.reportProviderRun(binding.token, runId)
																.pipe(
																	Effect.tap(() =>
																		Effect.sync(() => {
																			binding.providerRunId = runId;
																		}),
																	),
																)
														: Effect.void;
												return yield* recordRun.pipe(
													Effect.andThen(
														spool.emit(
															output,
															origin
																? (querySeqs.get(origin) ?? querySeq)
																: querySeq,
														),
													),
													Effect.ensuring(
														Effect.sync(() => {
															activeOutputs--;
															reportUpgradeState();
														}),
													),
												);
											}),
										)
										.pipe(Effect.provideService(Scope.Scope, scope));
									const testIdle =
										process.env["NODE_ENV"] === "test"
											? process.env["CONDUIT_TEST_RUNNER_IDLE_MS"]
											: undefined;
									idle = makeRunnerIdleExit(
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
										config.autoSettleAfterDays,
										(ignoredTurns) =>
											role._tag === "Reserved" ||
											hostBusy(ignoredTurns) ||
											spool.hasHeldWork,
										config.daemonConfigDir,
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
								role = decideRunnerRole(role, { _tag: "Hello" });
								greeted = true;
								const overrideHello =
									process.env["NODE_ENV"] === "test" &&
									(!process.env["CONDUIT_TEST_RUNNER_HELLO_AFTER_FIRST"] ||
										helloCount > 0);
								helloCount++;
								peer.write({
									type: "hello",
									protocolVersion:
										overrideHello &&
										process.env["CONDUIT_TEST_RUNNER_HELLO_VERSION"]
											? Number(process.env["CONDUIT_TEST_RUNNER_HELLO_VERSION"])
											: RUNNER_PROTOCOL_VERSION,
									buildId: runnerBuildId(),
									...(overrideHello &&
									process.env["CONDUIT_TEST_RUNNER_HELLO_WITHOUT_RUN_IDS"]
										? {}
										: { stampsRunIds: true as const }),
									settlesAnswers: true,
									drainsConnections: true,
									attachmentRefs: true,
									...(driverKind === "cursor" &&
									!(
										overrideHello &&
										process.env[
											"CONDUIT_TEST_RUNNER_HELLO_WITHOUT_CURSOR_CREDENTIALS"
										]
									)
										? { scopedCursorCredentials: true as const }
										: {}),
									runnerId,
									driverKind,
									sessionId,
									pid: process.pid,
									...(reaper ? { reaper } : {}),
									bindings: [...bindings].map(([sinkId, binding]) => ({
										sinkId,
										sessionId: binding.sessionId,
										...(binding.token ? { token: binding.token } : {}),
										...(process.env["NODE_ENV"] === "test" &&
										process.env[
											"CONDUIT_TEST_RUNNER_HELLO_WITHOUT_BINDING_RELEASE_STATE"
										]
											? {}
											: { released: binding.released === true }),
									})),
									pendingOutputs: spool.pendingOutputs,
									completedCommands: [...completedCommands.values()],
									...(sendJournal?.canAnswerRetainedSends
										? {
												sendJournalAnswers: true,
												sendAnswers: sendJournal.answers,
											}
										: {}),
									sendTokens: sendJournal?.tokens ?? [],
									upgradeState: upgradeState(),
									...launch.capabilities,
								});
								initializing = false;
							}).pipe(
								Effect.catch((failure) =>
									Effect.sync(() => {
										initializing = false;
										peer.refuse(failure);
									}),
								),
							),
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
						const firstAttachment = !attached;
						attached = true;
						spool.attach(peer, message.acknowledgedSequence);
						// The server lost its in-memory level state, even for acked outputs.
						// Replay the current snapshot after the backlog, with a fresh sequence.
						// Receipt-failure retries on this connection only need the backlog.
						if (firstAttachment)
							runFork(
								Effect.suspend(() =>
									Effect.all([
										backgroundSnapshot
											? spool.emit(backgroundSnapshot)
											: Effect.void,
										tasksSnapshot
											? spool.emit(
													{
														...tasksSnapshot.output,
														event: {
															...tasksSnapshot.output.event,
															eventId: createEventId(),
															createdAt: Date.now(),
														},
													},
													tasksSnapshot.querySeq,
												)
											: Effect.void,
									]),
								).pipe(Effect.orDie),
							);
						reportedQuiescent = undefined;
						reportUpgradeState();
					} else if (message.type === "output-reply") {
						spool.reply(message);
						reportUpgradeState();
						retireWhenQuiescent();
					} else if (
						message.type === "settled-commands" &&
						greeted &&
						sendJournal
					) {
						const journal = sendJournal;
						runFork(
							Effect.try({
								try: () => {
									const records = journal.acknowledge(message.tokens);
									const proof =
										process.env["NODE_ENV"] === "test"
											? process.env["CONDUIT_TEST_PROCESS_PROOF"]
											: undefined;
									if (proof && records.length)
										appendFileSync(
											proof,
											`${JSON.stringify({ kind: "runner-send-pruned", sessionId, records })}\n`,
										);
									peer.write({
										type: "settled-commands-ack",
										tokens: message.tokens,
									});
								},
								catch: (cause) => runnerFailure("prune runner sends", cause),
							}).pipe(
								Effect.catch((failure) => Effect.logWarning(failure.message)),
							),
						);
					} else if (message.type === "upgrade-retire") {
						const ready =
							greeted &&
							attached &&
							message.revision === revision &&
							quiescent();
						role = decideRunnerRole(role, {
							_tag: "Retire",
							revision: String(message.revision),
							quiescent: ready,
						});
						peer.write({
							type: "upgrade-reply",
							requestId: message.requestId,
							result: ready && role._tag === "Reserved",
						});
					} else if (message.type === "upgrade-cancel") {
						role = decideRunnerRole(role, { _tag: "Cancel" });
						reportUpgradeState();
					} else if (message.type === "upgrade-activate") {
						role = decideRunnerRole(role, { _tag: "Activate" });
					} else if (message.type === "command-status" && greeted && runner) {
						runFork(
							Effect.gen(function* () {
								if (process.env["NODE_ENV"] === "test") {
									const gate = join(
										dirname(socketPath),
										"conduit-test-hold-command-status-reply",
									);
									const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
									if (existsSync(gate) && proof)
										appendFileSync(
											proof,
											`${JSON.stringify({ kind: "runner-command-status-held", commandId: message.commandId, runnerId })}\n`,
										);
									while (existsSync(gate)) yield* Effect.sleep("20 millis");
								}
								const completed = completedCommands.get(message.commandId);
								peer.write({
									type: "command-status-reply",
									requestId: message.requestId,
									result: completed
										? completed.failure
											? "failed"
											: "completed"
										: commands.has(message.commandId)
											? "running"
											: "not_received",
								});
							}),
						);
					} else if (message.type === "command" && runner) {
						const command = message.command;
						const runId =
							command.type === "send-turn"
								? (command.runId ?? command.input.runId)
								: undefined;
						// An abort releases a send waiting on source delivery even when refused.
						if (command.type === "abort") {
							const cancelled = sourceDeliveryAborts.get(command.sinkId);
							if (cancelled) Deferred.doneUnsafe(cancelled, Effect.void);
						}
						const refused = exiting
							? "exiting"
							: retirementInputId !== undefined
								? "retiring"
								: runId && interruptedRuns.has(runId)
									? "interrupted"
									: undefined;
						if (refused) {
							peer.write({
								type: "command-refused",
								commandId: message.commandId,
								reason: refused,
							});
							return;
						}
						if (command.type === "interrupt" && !command.unrecorded)
							for (const interruptedRun of command.runIds ?? [])
								interruptedRuns.add(interruptedRun);
						// Fence later frames synchronously, while the accepted Stop is
						// allowed to finish and publish its reply before exit begins.
						if (command.type === "end-session") exiting = true;
						// Retirement is a reservation until the server commits its route.
						// A command selected on the old route cancels it without waiting.
						// The swap's own pre-warm reaches the Candidate before its commit, so
						// only a shutdown and it leave the role (nearest reading of 2507-2511).
						role = decideRunnerRole(role, {
							_tag: "Command",
							activates:
								command.type !== "shutdown" && command.type !== "pre-warm",
						});
						// A send's frame id is its Send Token, unique per transmission (4.9, 4.11).
						const token = message.commandId as SendToken;
						const existing = commands.get(message.commandId);
						const result =
							existing ??
							Deferred.makeUnsafe<TurnResult | undefined, SessionFailure>();
						if (!existing) {
							// Register receipt before a later frame or drained reconnect can
							// answer status, even if execution yields before its first step.
							commands.set(message.commandId, result);
						}
						if (command.type === "send-turn") {
							peer.write({
								type: "command-accepted",
								commandId: message.commandId,
								sinkId: command.sinkId,
							});
							idle?.beginTurn(command.autoSettleAfterDays);
						}
						idle?.activity();
						activeCommands++;
						if (command.type === "send-turn") {
							if (bindings.get(command.sinkId)?.token !== token)
								bindings.set(command.sinkId, {
									sessionId: command.input.sessionId,
									inputId: command.input.inputId,
									...(command.input.runId
										? { runId: command.input.runId }
										: {}),
									token,
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
								if (existing) return yield* Deferred.await(existing);
								const proof =
									process.env["NODE_ENV"] === "test"
										? process.env["CONDUIT_TEST_PROCESS_PROOF"]
										: undefined;
								if (proof && command.control)
									appendFileSync(
										proof,
										`${JSON.stringify({ kind: "runner-control", commandId: message.commandId, type: command.type, runnerId })}\n`,
									);
								if (!runner)
									return yield* Effect.die("Runner is not initialized");
								const payloadRunner = runner;
								const execution = Effect.gen(function* () {
									if (
										process.env["NODE_ENV"] === "test" &&
										(command.type === "resolve-permission" ||
											command.type === "resolve-question") &&
										existsSync(
											join(dirname(socketPath), "conduit-test-refuse-answer"),
										)
									)
										return yield* Effect.fail({
											operation: command.type,
											code: "test_answer_refused",
											retryable: true,
											message: "The test refused this answer.",
										});
									const invalidated = sourceDeliveryInvalidated;
									if (
										command.type === "send-turn" &&
										invalidated &&
										launch.changesAccount?.(command)
									) {
										const cancelled = Deferred.makeUnsafe<void>();
										if (command.aborted)
											Deferred.doneUnsafe(cancelled, Effect.void);
										sourceDeliveryAborts.set(command.sinkId, cancelled);
										yield* Effect.raceFirst(
											Deferred.await(invalidated),
											Deferred.await(cancelled),
										).pipe(
											Effect.timeoutOption(SOURCE_DELIVERY_ADMISSION_WAIT_MS),
											Effect.ensuring(
												Effect.sync(() => {
													sourceDeliveryAborts.delete(command.sinkId);
												}),
											),
										);
										// An old producer's signal cannot authorize rebinding past a newer fence.
										if (
											exiting ||
											sourceDeliveryInvalidated ||
											Deferred.isDoneUnsafe(cancelled)
										)
											return yield* Effect.fail({
												operation: "send-turn",
												code: "account_switch_busy",
												retryable: true,
												message:
													"Source delivery did not finish before send admission. Resend the turn.",
											});
									}
									launch.acceptCommand(command);
									return yield* launch.executeEffect(payloadRunner, command);
								});
								const exit = yield* Effect.exit(
									command.type === "send-turn" && sendJournal
										? sendJournal.execute(token, execution, command.mode)
										: execution,
								);
								yield* Deferred.done(result, exit);
								return yield* Deferred.await(result);
							}).pipe(
								Effect.ensuring(
									Effect.gen(function* () {
										if (
											process.env["NODE_ENV"] !== "test" ||
											command.type !== "send-turn" ||
											command.input.inputId !== retirementInputId
										)
											return;
										const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
										if (!proof) return;
										const gate = join(
											dirname(proof),
											"conduit-test-hold-abandoned-run-retirement",
										);
										if (!existsSync(gate)) return;
										appendFileSync(
											proof,
											`${JSON.stringify({ kind: "runner-abandoned-retirement-paused", runnerId, inputId: command.input.inputId })}\n`,
										);
										while (existsSync(gate)) yield* Effect.sleep("20 millis");
									}),
								),
								Effect.ensuring(
									Effect.sync(() => {
										if (command.type === "send-turn") idle?.endTurn();
										activeCommands--;
										reportUpgradeState();
									}),
								),
								Effect.matchCauseEffect({
									onFailure: (cause) =>
										Effect.gen(function* () {
											if (
												process.env["NODE_ENV"] === "test" &&
												command.type === "end-session" &&
												command.control?.retireRunIds
											) {
												const gate = join(
													dirname(socketPath),
													"conduit-test-hold-retirement-reply",
												);
												while (existsSync(gate))
													yield* Effect.sleep("20 millis");
											}
											const failure = runnerFailure(
												command.type,
												Failure.squashCause(cause),
											);
											// A refused answer was not consumed: main retries it under the same commandId,
											// so its next transmission runs again rather than replaying this refusal (3.10).
											if (
												failure.retryable &&
												(command.type === "resolve-permission" ||
													command.type === "resolve-question")
											)
												commands.delete(message.commandId);
											completedCommands.set(message.commandId, {
												commandId: message.commandId,
												failure,
											});
											connection?.write({
												type: "command-reply",
												commandId: message.commandId,
												failure,
											});
											if (
												command.type === "end-session" ||
												(command.type === "send-turn" &&
													command.input.inputId === retirementInputId)
											)
												beginExit();
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
											if (
												process.env["NODE_ENV"] === "test" &&
												(command.type === "resolve-permission" ||
													command.type === "resolve-question")
											) {
												const gate = join(
													dirname(socketPath),
													"conduit-test-hold-answer-reply",
												);
												const held = existsSync(gate);
												while (existsSync(gate))
													yield* Effect.sleep("20 millis");
												const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
												if (held && proof)
													appendFileSync(
														proof,
														`${JSON.stringify({ kind: "runner-answer-reply-released", commandId: message.commandId, runnerId })}\n`,
													);
											}
											reportUpgradeState();
											connection?.write({
												type: "command-reply",
												commandId: message.commandId,
												...(result ? { result } : {}),
											});
											if (
												command.type === "end-session" ||
												(command.type === "send-turn" &&
													command.input.inputId === retirementInputId) ||
												launch.shouldExitAfterCommand?.(command, result)
											)
												beginExit();
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
						const proof =
							process.env["NODE_ENV"] === "test"
								? process.env["CONDUIT_TEST_PROCESS_PROOF"]
								: undefined;
						if (proof)
							appendFileSync(
								proof,
								`${JSON.stringify({ kind: "runner-detached", sessionId, pid: process.pid, at: process.hrtime.bigint().toString() })}\n`,
							);
						if (exiting) finishExit();
					}
				},
				undefined,
				launch.wire,
			);
			peer.querySeq = () => querySeq;
			connection = peer;
			runFork(
				peer.readToEndEffect.pipe(
					Effect.andThen(Deferred.succeed(drained, undefined)),
				),
			);
			socket.resume();
		};
		const server = createServer((socket) => {
			// A reconnect can overtake the old stream's unread commands. Queue its
			// reader until the predecessor reaches EOF before answering its hello.
			sockets.add(socket);
			socket.once("close", () => sockets.delete(socket));
			socket.pause();
			const previousDrained = connectionDrained;
			const drained = Deferred.makeUnsafe<void>();
			connectionDrained = Deferred.await(drained);
			runFork(
				previousDrained.pipe(
					Effect.andThen(Effect.sync(() => attachSocket(socket, drained))),
				),
			);
		});
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				idle?.close();
				clearTimeout(exitDeadline);
				for (const socket of sockets) socket.destroy();
				server.close();
				removeRunnerDiscovery(socketPath);
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
		process.send({
			channel: `conduit-${driverKind}-runner`,
			type: "listening",
		});
		yield* Deferred.await(stopped);
	});
