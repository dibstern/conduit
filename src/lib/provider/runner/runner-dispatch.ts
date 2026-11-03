import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
	Clock,
	Deferred,
	Effect,
	Exit,
	type FiberSet,
	type Semaphore,
} from "effect";
import type { SqlClient } from "effect/sql";
import { accountSwitchBusyMessage } from "../../contracts/limit-recovery.js";
import * as Failure from "../../effect/failure-classification.js";
import { STOP_ABORT_WAIT_MS } from "../orchestration-command-contracts.js";
import { runSendCommandIdQuery } from "../session-run-settlement.js";
import type { TurnResult } from "../types.js";
import type {
	Held,
	ProcessRunnerDeps,
	ProcessRunnerDriver,
	WritePermission,
} from "./process-runner-types.js";
import type { RunnerChild } from "./runner-entry-lifecycle.js";
import * as Entry from "./runner-entry-lifecycle.js";
import {
	RUNNER_WRITE_GATE_CLOSED,
	runnerBuildId,
	runnerFailure,
	sendToken,
} from "./runner-protocol.js";
import { currentRunnerOutput } from "./runner-receipts.js";
import type { makeRunnerRetirement } from "./runner-retirement.js";
import type { makeRunnerSends, SendBinding } from "./runner-sends.js";
import {
	CANCELLED_TURN,
	log,
	type makeRunnerStarter,
} from "./runner-starter.js";
import { failRunnerTurn } from "./runner-turn-failure.js";
import { makeSendAdmissionWait } from "./send-admission.js";
import type { SendScope } from "./send-scope.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionTurn,
} from "./session-runner.js";

export const legacyAnswerCommandId = (entry: RunnerChild, commandId: string) =>
	entry.capabilities?.settlesAnswers === true
		? undefined
		: `${commandId}:answer`;

interface RunnerDispatchOptions {
	readonly deps: ProcessRunnerDeps;
	readonly driver: ProcessRunnerDriver;
	readonly runFork: Effect.Success<
		ReturnType<typeof FiberSet.makeRuntime<never, void, never>>
	>;
	readonly lock: Semaphore.Semaphore;
	readonly sql: SqlClient.SqlClient | undefined;
	readonly sends: ReturnType<typeof makeRunnerSends>;
	readonly stops: Pick<
		Effect.Success<ReturnType<typeof makeRunnerRetirement>>,
		| "awaitStop"
		| "closing"
		| "currentEntry"
		| "records"
		| "shutdown"
		| "stopRunner"
	>;
	readonly starter: Pick<
		Effect.Success<ReturnType<typeof makeRunnerStarter>>,
		"start" | "createEntry" | "upgrade" | "retireSurvivor" | "reportStart"
	>;
	readonly emit: (
		output: SessionOutput,
		sessionId?: string,
	) => Effect.Effect<SessionOutputReply, SessionFailure>;
	readonly failSendOnce: (
		binding: SendBinding,
		failure: Effect.Effect<void>,
	) => Effect.Effect<void>;
	readonly failBoundSend: (
		sinkId: string,
		binding: SendBinding,
		entry: RunnerChild,
		failure: SessionFailure,
	) => Effect.Effect<void>;
	readonly accountDisplayName: (
		input: Pick<SessionTurn, "account" | "instanceId"> | undefined,
	) => string;
}

export const makeRunnerDispatch = (options: RunnerDispatchOptions) => {
	const {
		deps,
		driver,
		runFork,
		lock,
		sql,
		sends,
		stops,
		starter: { start, createEntry, upgrade, retireSurvivor, reportStart },
		emit,
		failSendOnce,
		failBoundSend,
		accountDisplayName,
	} = options;
	function dispatch(
		command: Extract<SessionCommand, { type: "send-turn" }>,
		send: SendScope,
		recovered?: RunnerChild,
		held?: Held,
		legacySend?: boolean,
		permission?: WritePermission,
	): Effect.Effect<TurnResult, SessionFailure>;
	function dispatch(
		command: Exclude<SessionCommand, { type: "send-turn" }>,
		send?: SendScope,
		recovered?: RunnerChild,
		held?: Held,
		legacySend?: boolean,
		permission?: WritePermission,
	): Effect.Effect<void, SessionFailure>;
	function dispatch(
		command: SessionCommand,
		send: SendScope,
		recovered?: RunnerChild,
		held?: Held,
		legacySend?: boolean,
		permission?: WritePermission,
	): Effect.Effect<TurnResult | undefined, SessionFailure>;
	function dispatch(
		command: SessionCommand,
		send?: SendScope,
		recovered?: RunnerChild,
		held?: Held,
		legacySend = false,
		permission?: WritePermission,
	): Effect.Effect<TurnResult | undefined, SessionFailure> {
		const turn: SendBinding | undefined =
			command.type === "send-turn"
				? {
						sessionId: command.input.sessionId,
						...(send ? { sendScope: send } : {}),
						inputId: command.input.inputId,
						runId: command.input.runId,
						...(command.input.continuation
							? {}
							: {
									placement: {
										inputId: command.input.inputId,
										text: command.input.text ?? command.input.prompt,
										...(command.input.images
											? {
													images: command.input.images.map(({ ref }) => ref),
												}
											: {}),
									},
								}),
						messageId: "",
						commandPending: true,
					}
				: undefined;
		let child: RunnerChild | undefined;
		let sentToRunner = false;
		let admitted: RunnerChild | undefined;
		let admittedSessionId = "";
		let cancelled: Deferred.Deferred<void> | undefined;
		let unsentReleased = false;
		const emitUnsent = (output: SessionOutput) =>
			Effect.suspend(() => {
				if (command.type !== "send-turn" || unsentReleased)
					return Effect.succeed({});
				const binding = sends.route(command.sinkId);
				if (binding && binding !== turn) return Effect.succeed({});
				if (output.type !== "release-sink") return emit(output);
				unsentReleased = true;
				return Effect.succeed({});
			});
		let deliveryRegistration:
			| { entry: RunnerChild; changed: Deferred.Deferred<void> }
			| undefined;
		let deliveryDeadline: number | undefined;
		const waitForAdmission =
			command.type === "send-turn"
				? makeSendAdmissionWait(command.input.sessionId, command.input.inputId)
				: undefined;
		const execute = Effect.gen(function* () {
			const autoSettleAfterDays =
				command.type === "send-turn"
					? command.input.autoSettleAfterDays !== undefined
						? command.input.autoSettleAfterDays
						: yield* deps.autoSettleAfterDays ?? Effect.succeed(undefined)
					: undefined;
			if (command.type === "send-turn" && cancelled) {
				const pendingSend = (turn?.sendScope
					? sends.pending(turn.sendScope)
					: undefined) ?? {
					sessionId: command.input.sessionId,
					runId: command.runId ?? command.input.runId,
					cancelled,
				};
				if (turn?.sendScope)
					yield* sends.bindPending(turn.sendScope, command.sinkId, pendingSend);
				sentToRunner = false;
			}
			const outputOwner = yield* currentRunnerOutput;
			if (command.type === "abort") {
				if (!send) return;
				if (
					send &&
					(send.assignment._tag === "Closed" ||
						(sends.route(command.sinkId) !== undefined &&
							sends.route(command.sinkId)?.sendScope !== send))
				)
					return;
				// Owner-bound sends, joined steers included from 32.5, end through
				// settleSend or a durable Stop (CONTRACT 1625-1632); legacy and direct
				// sends keep the in-memory cancel the recall needs.
				const pending = sends.pending(send);
				if (pending && !sends.dispatched(send) && !pending.owner) {
					yield* Deferred.succeed(pending.cancelled, undefined);
					return;
				}
			}
			if (command.type === "interrupt") {
				yield* sends.cancelUndispatched(command.sessionId, command.runIds);
			}
			if (command.type === "shutdown") {
				yield* stops.shutdown;
				return;
			}
			if (stops.closing)
				return yield* Effect.fail(
					runnerFailure(command.type, "Runners are shutting down"),
				);
			const sessionId =
				command.type === "send-turn"
					? command.input.sessionId
					: "sessionId" in command
						? command.sessionId
						: sends.route(command.sinkId)?.sessionId;
			if (!sessionId) return;
			admittedSessionId = sessionId;
			if (command.type === "send-turn" && turn?.sendScope)
				yield* sends.retainAccount(
					turn.sendScope,
					command.sinkId,
					command.input.account?.id,
				);
			let entry: RunnerChild | undefined;
			// Admission parks on this entry. Only a new gate step may pick another holder.
			let selectedEntry = held
				? stops.records.get(held.runner)?.identity.entry
				: stops.currentEntry(sessionId);
			let selecting = true;
			while (selecting) {
				const selection = yield* lock.withPermits(1)(
					Effect.gen(function* () {
						if (stops.closing)
							return yield* Effect.fail(
								runnerFailure(command.type, "Runners are shutting down"),
							);
						const existing = selectedEntry;
						// An interrupted adoption settles ready but leaves its survivor
						// Recovering with no failure or stop. A send needs the serving
						// slot, so it retires that survivor as a failed adoption would
						// (CONTRACT 6.7, 6.3). Under the lock, after the closing check,
						// shutdown can never see it retire a live survivor (Q28).
						if (
							existing &&
							existing !== recovered &&
							existing.lifecycle.activity._tag === "Recovering" &&
							!existing.lifecycle.failure &&
							!existing.lifecycle.stop &&
							Deferred.isDoneUnsafe(existing.ready) &&
							(command.type === "send-turn" || command.type === "pre-warm")
						)
							yield* retireSurvivor(
								existing,
								runnerFailure(
									"recover runner",
									"Runner adoption was interrupted",
								),
							);
						if (held && (!existing || existing.runnerId !== held.runner))
							return yield* Effect.fail({
								...runnerFailure("send-turn", "Holder is no longer attached"),
								delivery: { _tag: "NotSent" },
							});
						if (
							command.control &&
							(!existing ||
								existing.runnerId !== command.control.providerProcessId ||
								!Entry.canControl(existing.lifecycle))
						)
							return yield* Effect.fail({
								...runnerFailure(
									command.type,
									"The target provider process is no longer running",
								),
								code: "provider_process_gone",
							});
						if (
							existing &&
							existing !== recovered &&
							(command.type === "send-turn" || command.type === "pre-warm") &&
							!Deferred.isDoneUnsafe(existing.ready)
						) {
							if (command.type === "pre-warm")
								return { entry: undefined, draining: false };
							return {
								entry: existing,
								draining: true,
								recoveryPending: true,
							};
						}
						if (
							outputOwner &&
							(command.type === "answer-permission" ||
								command.type === "answer-question" ||
								command.type === "interaction-failed") &&
							existing?.runnerId !== outputOwner.runnerId
						)
							return { entry: undefined, draining: false };
						if (
							existing &&
							(command.type === "send-turn" || command.type === "pre-warm")
						) {
							const snapshot = existing.upgrade.state?.snapshot;
							const launch = snapshot?.input;
							const previousExtra = new Set(launch?.extraFolders ?? []);
							const nextExtra = new Set(command.input.extraFolders ?? []);
							const extraFoldersChanged =
								previousExtra.size !== nextExtra.size ||
								[...previousExtra].some((folder) => !nextExtra.has(folder));
							const removedExtra = [...previousExtra].filter(
								(folder) => !nextExtra.has(folder),
							);
							const addedExtra = [...nextExtra].filter(
								(folder) => !previousExtra.has(folder),
							);
							// Secondary Enter/Exit swaps a configured folder's role. The
							// captured secondary-folder integration requires this reconciliation.
							const canReconcileExtraFolders =
								snapshot?.workspacePreviousRoot !== undefined &&
								previousExtra.size === nextExtra.size &&
								removedExtra.length === 1 &&
								addedExtra.length === 1 &&
								[...nextExtra].every((folder) =>
									snapshot.workspaceDirectories?.includes(folder),
								) &&
								(addedExtra[0] === snapshot.workspacePreviousRoot ||
									removedExtra[0] === launch?.workspaceRoot);
							const foldersChanged =
								launch !== undefined &&
								(launch.workspaceRoot !== command.input.workspaceRoot ||
									(extraFoldersChanged && !canReconcileExtraFolders));
							const loginChange =
								launch === undefined
									? "None"
									: driver.loginChange(
											{
												...launch,
												configDir: launch.configDir,
												root: launch.workspaceRoot,
											},
											{
												...command.input,
												configDir: command.input.configDir,
												root: command.input.workspaceRoot,
												shellConfig:
													command.input.shellConfig ?? command.shellConfig,
											},
										);
							const legacyCursor =
								driver.driverKind === "cursor" &&
								existing.connection?.scopedCursorCredentials === false;
							// Observe before checking, under selection. Await only after releasing it.
							const changed = Deferred.makeUnsafe<void>();
							Entry.watch(existing, changed);
							deliveryRegistration = { entry: existing, changed };
							const delivery = existing.sourceDelivery;
							if (
								command.type === "send-turn" &&
								loginChange === "Account" &&
								!foldersChanged &&
								!legacyCursor &&
								Entry.canReconfigure(existing.lifecycle) &&
								delivery?.sessionId === sessionId &&
								delivery.runnerId === existing.runnerId &&
								delivery.generation > 0
							) {
								return {
									entry: existing,
									draining: true,
									sourceDeliveryPending: changed,
								};
							}
							Entry.unwatch(existing, changed);
							deliveryRegistration = undefined;
							const decision = Entry.decideSend({
								command: command.type,
								lifecycle: existing.lifecycle,
								quiescent: existing.upgrade.state?.quiescent === true,
								rebindsAccount:
									existing.capabilities?.rebindsAccount === true &&
									// The capability predates guarded account admission. The
									// shared dev sentinel cannot establish the child's build.
									(loginChange !== "Account" ||
										(existing.buildId !== "dev" &&
											existing.buildId === runnerBuildId())),
								changes: {
									folders: foldersChanged,
									login: loginChange,
									legacyCursor,
									settingsDeferred: existing.upgrade.settingsDeferred === true,
								},
							});
							if (process.env["NODE_ENV"] === "test" && process.connected)
								process.send?.({
									channel: "conduit-process-test",
									kind: "runner-admission",
									sessionId,
									command: command.type,
									decision,
								});
							switch (decision) {
								case "Refuse":
									log.info(
										`Account switch refused for session ${sessionId}: runner is busy`,
									);
									return yield* Effect.fail({
										...runnerFailure(
											command.type,
											accountSwitchBusyMessage(
												accountDisplayName(launch),
												accountDisplayName(command.input),
											),
										),
										code: "account_switch_busy",
										retryable: true,
									});
								case "Skip":
									return { entry: undefined, draining: false };
								case "Wait":
									Entry.watch(existing, changed);
									deliveryRegistration = { entry: existing, changed };
									return {
										entry: existing,
										draining: true,
										foldersPending: changed,
										waitReason: foldersChanged
											? ("foldersPending" as const)
											: legacyCursor
												? ("legacyCursor" as const)
												: ("loginPending" as const),
									};
								case "Retire":
									return {
										entry: existing,
										draining: true,
										retire: existing,
									};
								case "DeferRebind":
									log.info(
										`Account rebind deferred for session ${sessionId}: runner is busy`,
									);
									break;
								case "Use":
									break;
								default: {
									const _exhaustive: never = decision;
									return _exhaustive;
								}
							}
						}
						if (
							command.type === "pre-warm" &&
							existing &&
							!Entry.canPreWarm(existing.lifecycle)
						)
							return { entry: undefined, draining: false };
						if (
							existing ||
							(command.type !== "send-turn" && command.type !== "pre-warm")
						) {
							// A held frame goes to the write, where the write gate
							// (4.4) or the host's refusal (4.6) decides.
							const draining =
								command.type === "send-turn" &&
								existing !== undefined &&
								!held &&
								Entry.mustDrainBeforeSend(existing.lifecycle);
							if (
								existing &&
								!draining &&
								turn &&
								command.type === "send-turn"
							) {
								yield* sends.bind(command.sinkId, turn);
							}
							if (existing && !draining) {
								Entry.transition(existing, { _tag: "AdmitCommand" });
								admitted = existing;
								Entry.touch(existing);
							}
							return {
								entry: existing,
								draining,
								admission: existing?.lifecycle.end?.released,
							};
						}
						const created: RunnerChild = yield* createEntry(sessionId, {
							projectId: command.input.projectId,
							launch: {
								workspaceRoot: command.input.workspaceRoot,
								extraFolders: command.input.extraFolders,
							},
						});
						Entry.transition(created, { _tag: "AdmitCommand" });
						admitted = created;

						if (turn && command.type === "send-turn") {
							yield* sends.bind(command.sinkId, turn);
						}
						runFork(
							start(sessionId, created).pipe(
								Effect.onExit((exit) =>
									Exit.isFailure(exit)
										? Deferred.failCause(created.ready, exit.cause)
										: exit.value
											? Deferred.succeed(created.ready, exit.value)
											: Deferred.fail(
													created.ready,
													runnerFailure(
														"start runner",
														"Serving registration was lost",
													),
												),
								),
								Effect.ignore,
								Effect.asVoid,
							),
						);
						return { entry: created, draining: false };
					}),
				);
				entry = selection.entry;
				selecting = selection.draining;
				if (
					"sourceDeliveryPending" in selection &&
					selection.sourceDeliveryPending
				) {
					const changed = selection.sourceDeliveryPending;
					const now = yield* Clock.currentTimeMillis;
					// Notifications and successor producers share this send's budget.
					deliveryDeadline ??= now + STOP_ABORT_WAIT_MS;
					const failure: SessionFailure = {
						operation: command.type,
						code: "account_switch_busy",
						retryable: true,
						message:
							"Source delivery did not finish before account-switch admission. Resend the turn.",
					};
					if (now >= deliveryDeadline) return yield* Effect.fail(failure);
					yield* Deferred.await(changed).pipe(
						Effect.timeoutOrElse({
							duration: deliveryDeadline - now,
							orElse: () => Effect.fail(failure),
						}),
						Effect.ensuring(
							Effect.sync(() => {
								if (deliveryRegistration)
									Entry.unwatch(deliveryRegistration.entry, changed);
								deliveryRegistration = undefined;
							}),
						),
					);
					continue;
				}
				if ("recoveryPending" in selection && entry) {
					const waiting = entry;
					yield* Deferred.await(waiting.ready).pipe(
						Effect.catch((failure) =>
							stops.currentEntry(sessionId) !== waiting &&
							waiting.lifecycle.stop
								? Effect.void
								: Effect.fail(failure),
						),
					);
					continue;
				}
				if (
					"foldersPending" in selection &&
					selection.foldersPending &&
					selection.waitReason &&
					entry
				) {
					const changed = selection.foldersPending;
					const waitingEntry = entry;
					const wait = Deferred.await(changed).pipe(
						Effect.ensuring(
							Effect.sync(() => Entry.unwatch(waitingEntry, changed)),
						),
					);
					yield* waitForAdmission
						? waitForAdmission(selection.waitReason, wait)
						: wait;
					continue;
				}
				if (selection.retire) {
					const retiring = selection.retire;
					yield* dispatch(
						{ type: "end-session", sessionId },
						undefined,
						retiring,
					).pipe(
						Effect.ensuring(
							Effect.gen(function* () {
								const released = Entry.transition(retiring, {
									_tag: "FinishEnd",
								});
								if (released) yield* Deferred.succeed(released, undefined);
							}),
						),
						Effect.uninterruptible,
					);
				}
				// Old cleanup is session-wide. Finish it before a replacement
				// can register interactions or publish a new busy status.
				if (held && selection.draining)
					return yield* Effect.fail({
						...runnerFailure("send-turn", "Runner stopped before write"),
						delivery: { _tag: "NotSent" },
					});
				if (entry && selection.draining) {
					yield* Deferred.await(
						!entry.lifecycle.failure &&
							!entry.lifecycle.idleExiting &&
							selection.admission
							? selection.admission
							: entry.drained,
					);
					selectedEntry = undefined;
				}
			}
			if (!entry) return;
			child = entry;
			sentToRunner = false;
			// Restored controls must still reach the old query while a send
			// waits to rebind. That send is what keeps admission readiness gated.
			let connection =
				entry.connection &&
				(entry === recovered ||
					(command.type !== "send-turn" &&
						command.type !== "pre-warm" &&
						!entry.connection.closed &&
						Entry.canUseControlConnection(entry.lifecycle)))
					? entry.connection
					: yield* Deferred.await(entry.ready);
			// 6.1: a draft pre-warm's start waits for its session, so a send reports it first.
			if (command.type === "send-turn" && !entry.lifecycle.candidate)
				yield* reportStart(entry, true).pipe(
					Effect.mapError((cause) =>
						runnerFailure("report runner start", cause),
					),
				);
			if (
				command.control &&
				(stops.currentEntry(sessionId) !== entry ||
					entry.runnerId !== command.control.providerProcessId ||
					!Entry.canControl(entry.lifecycle) ||
					connection.closed)
			)
				return yield* Effect.fail({
					...runnerFailure(
						command.type,
						"The target provider process is no longer running",
					),
					code: "provider_process_gone",
				});
			if (command.type === "pre-warm" && !Entry.canPreWarm(entry.lifecycle))
				return;
			if (stops.closing)
				return yield* Effect.fail(
					runnerFailure(command.type, "Runners are shutting down"),
				);
			if (command.type === "stop-task" && !entry.capabilities?.stopsTasks)
				return yield* Effect.fail(
					runnerFailure(
						command.type,
						`Runner build ${entry.buildId ?? "unknown"} cannot stop background tasks`,
					),
				);
			const launchEntry = entry;
			const preserveReportedLogin = <
				Command extends Extract<
					SessionCommand,
					{ type: "send-turn" | "pre-warm" }
				>,
			>(
				payload: Command,
			): Command => {
				const snapshot = launchEntry.upgrade.state?.snapshot;
				const launch = snapshot?.input;
				if (
					driver.driverKind === "claude" &&
					!launchEntry.capabilities?.declaresLogin &&
					launch &&
					driver.loginChange(
						{ ...launch, root: launch.workspaceRoot },
						{
							...payload.input,
							configDir: payload.input.configDir,
							root: payload.input.workspaceRoot,
							shellConfig: payload.input.shellConfig ?? payload.shellConfig,
						},
					) === "None"
				) {
					// Old peers compare captures and absent account fields as values.
					// Keep their reported login until a declared setting really changes.
					const captured = {
						...payload,
						input: { ...payload.input },
						shellEnv: launch.shellEnv ?? snapshot?.options.env ?? {},
					};
					delete captured.input.account;
					delete captured.input.instanceId;
					delete captured.input.shellEnv;
					if (launch.account !== undefined)
						captured.input.account = launch.account;
					if (launch.instanceId !== undefined)
						captured.input.instanceId = launch.instanceId;
					if (launch.shellEnv !== undefined)
						captured.input.shellEnv = launch.shellEnv;
					return captured;
				}
				return payload;
			};
			const payload =
				command.type === "send-turn"
					? preserveReportedLogin({
							...command,
							autoSettleAfterDays,
							shellConfig: command.input.shellConfig ?? command.shellConfig,
							...(entry.upgrade.state?.frozen
								? driver.snapshotCommandSettings(entry.upgrade.state.snapshot)
								: {}),
							shellEnv: command.input.shellEnv ??
								command.shellEnv ?? {
									...process.env,
								},
						})
					: command.type === "pre-warm"
						? preserveReportedLogin({
								...command,
								shellConfig: command.input.shellConfig ?? command.shellConfig,
								shellEnv: command.input.shellEnv ??
									command.shellEnv ?? {
										...process.env,
									},
							})
						: command;
			let commandId =
				command.control?.commandId ??
				(command.type === "send-turn" ? command.input.inputId : randomUUID());
			if (command.type === "send-turn" && sql && held && command.input.runId) {
				commandId =
					(yield* runSendCommandIdQuery(
						sql,
						sessionId,
						command.input.runId,
					).pipe(
						Effect.mapError((cause) =>
							runnerFailure("resolve runner command", cause),
						),
					)) ?? commandId;
			} else if (
				command.type === "send-turn" &&
				sql &&
				command.input.commandAttempt !== undefined
			) {
				// A legacy retry can retain an outbox command id distinct from
				// its normalized input id. Preserve it for runner reattachment.
				const rows = yield* sql<{
					command_id: string;
				}>`SELECT command_id FROM provider_command_outbox
							WHERE project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId}) AND session_id = ${sessionId} AND effect_type = 'send_turn'
								AND status = 'running' AND attempt_count = ${command.input.commandAttempt}
								AND COALESCE(json_extract(payload_json, '$.inputId'), json_extract(payload_json, '$.userMessageId'), json_extract(payload_json, '$.commandId'), json_extract(payload_json, '$.turnId')) = ${command.input.inputId}
							ORDER BY request_sequence LIMIT 1`.pipe(
					Effect.mapError((cause) =>
						runnerFailure("resolve runner command", cause),
					),
				);
				commandId = rows[0]?.command_id ?? commandId;
			}
			if (command.type === "end-session") {
				const cohort = command.control?.retireRunIds;
				if (sql && cohort) {
					const [row] = yield* sql<{ running: number }>`SELECT EXISTS (
								SELECT 1 FROM provider_runs owner WHERE owner.session_id = ${sessionId}
								AND owner.id IN ${sql.in(cohort)} AND owner.status IN ('pending', 'running')
								AND (owner.runner_id = ${entry.runnerId} OR owner.runner_id IS NULL)
								AND NOT EXISTS (SELECT 1 FROM events terminal WHERE terminal.session_id = owner.session_id
									AND json_extract(terminal.metadata, '$.runId') = owner.id
									AND terminal.type IN ('turn.completed', 'turn.error', 'turn.interrupted'))
							) AS running`.pipe(
						Effect.mapError((cause) =>
							runnerFailure("retirement cohort", cause),
						),
					);
					if (!row?.running) return;
				}
				yield* stops.stopRunner(entry, commandId, "stop", {
					_tag: command.control?.projectRemoved
						? "ProjectRemoved"
						: "EndSession",
				});
				return;
			}
			if (
				process.env["NODE_ENV"] === "test" &&
				process.env["CONDUIT_TEST_HOLD_RUNNER_OUTPUT"] === command.type
			) {
				const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
				if (proof)
					appendFileSync(
						proof,
						`${JSON.stringify({ kind: "held-output", type: command.type })}\n`,
					);
				yield* Effect.never;
			}
			if (command.type === "send-turn") {
				const pending = turn?.sendScope
					? sends.pending(turn.sendScope)
					: undefined;
				if (pending && Deferred.isDoneUnsafe(pending.cancelled))
					return CANCELLED_TURN;
				const holder = held?.runner ?? entry.runnerId;
				const serving = stops.records.get(holder)?.identity.entry;
				if (!serving)
					return yield* Effect.fail(
						runnerFailure("send-turn", "Serving runner is not attached"),
					);
				entry = serving;
				connection = entry.connection ?? (yield* Deferred.await(entry.ready));
				child = entry;
			}
			// A send's frame id is its Send Token: a hold's transmission, else the claim's.
			// A claim's send the runner already holds keeps its token once held (4.11).
			const claimed =
				command.type === "send-turn"
					? sendToken("tx", commandId, command.input.commandAttempt ?? 0)
					: undefined;
			const token =
				held && claimed && !connection.retainedSends?.includes(claimed)
					? sendToken("hold", commandId, held.transmission)
					: claimed;
			if (command.type === "send-turn" && turn?.sendScope && token) {
				const demand = sends.demand(turn.sendScope);
				if (
					turn.sendScope.assignment._tag === "Closed" ||
					(demand && Deferred.isDoneUnsafe(demand.invalidated))
				)
					return CANCELLED_TURN;
				sends.dispatch(turn.sendScope, entry, {
					sinkId: command.sinkId,
					commandId,
					token,
				});
			}
			sentToRunner = true;
			if (command.type === "send-turn") {
				const demand = turn?.sendScope
					? sends.demand(turn.sendScope)
					: undefined;
				if (demand)
					Deferred.doneUnsafe(demand.dispatched, Effect.succeed(connection));
			}
			const legacyAnswerId = legacyAnswerCommandId(entry, commandId);
			// Some unflagged builds already settle and cancel during resolve.
			// Retain their sink so the final handshake receipt is still recorded.
			const legacySinkId =
				legacyAnswerId &&
				(command.type === "resolve-question" ||
					command.type === "resolve-permission")
					? entry.interactionSinks?.get(
							`${command.type === "resolve-question" ? "question" : "permission"}-request:${command.requestId}`,
						)
					: undefined;
			if (
				command.type === "abort" &&
				send &&
				(send.assignment._tag === "Closed" ||
					(sends.route(command.sinkId) !== undefined &&
						sends.route(command.sinkId)?.sendScope !== send))
			)
				return;
			const write = connection.commandEffect(
				token ?? commandId,
				payload,
				permission?.write,
			);
			// The write fiber waits while the gate is closed: it writes after a
			// return to Running, or ends without writing once released (4.4).
			// That end carries no delivery evidence; the release is its outcome.
			let result = yield* Effect.result(write);
			while (
				permission &&
				result._tag === "Failure" &&
				result.failure.code === RUNNER_WRITE_GATE_CLOSED &&
				(yield* permission.reopened)
			)
				result = yield* Effect.result(write);
			if (result._tag === "Failure") return yield* Effect.fail(result.failure);
			// Legacy resolve commands acknowledge the answer without releasing
			// canUseTool. Complete that handshake inside the outbox attempt, using
			// its original reply rather than the runner's redacted notification.
			if (legacyAnswerId && legacySinkId) {
				if (command.type === "resolve-question") {
					yield* connection.commandEffect(legacyAnswerId, {
						type: "answer-question",
						sinkId: legacySinkId,
						requestId: command.requestId,
						answers: command.answers,
					});
				} else if (command.type === "resolve-permission") {
					yield* connection.commandEffect(legacyAnswerId, {
						type: "answer-permission",
						sinkId: legacySinkId,
						requestId: command.requestId,
						response: command.control?.response ?? {
							decision: command.decision,
						},
					});
				}
			}
			return result.success;
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					if (deliveryRegistration)
						Entry.unwatch(
							deliveryRegistration.entry,
							deliveryRegistration.changed,
						);
					deliveryRegistration = undefined;
					if (!admitted) return;
					Entry.transition(admitted, { _tag: "FinishCommand" });
					upgrade(admittedSessionId, admitted);
					admitted = undefined;
				}),
			),
			Effect.catchDefect((cause) =>
				Effect.fail(runnerFailure(command.type, cause)),
			),
			Effect.mapError((failure) =>
				command.type === "send-turn" &&
				held &&
				!sentToRunner &&
				!("delivery" in failure) &&
				!("replied" in failure) &&
				// Admission timeout is permanent (4.7); the feeder settles it.
				failure.code !== "send_admission_timeout"
					? { ...failure, delivery: { _tag: "NotSent" as const } }
					: failure,
			),
			Effect.catch((failure) =>
				command.type === "pre-warm" &&
				(stops.closing ||
					failure.code === "runner_idle_exit" ||
					(child &&
						(Entry.mustDrainBeforeSend(child.lifecycle) ||
							child.lifecycle.stop)))
					? Effect.succeed(undefined)
					: Effect.fail(failure),
			),
			Effect.onError((cause) => {
				if (command.type === "send-turn" && command.input.runId && !legacySend)
					return Effect.void;
				if (
					runnerFailure(command.type, Failure.squashCause(cause)).code ===
					"send_admission_timeout"
				)
					return Effect.void;
				if (
					command.type !== "send-turn" ||
					!turn ||
					stops.closing ||
					child?.lifecycle.failure?.code === "runner_detached" ||
					Failure.isInterruptedOnly(cause)
				)
					return Effect.void;
				// Explicit End owns settlement after confirmed exit. A socket
				// failure during its graceful phase is not a process terminal.
				if (child?.lifecycle.end && sentToRunner)
					return stops
						.awaitStop(child.runnerId, "Escalated")
						.pipe(Effect.ignore);
				const failure = runnerFailure(command.type, Failure.squashCause(cause));
				const cleanup =
					child && sentToRunner
						? failBoundSend(command.sinkId, turn, child, failure)
						: failSendOnce(
								turn,
								failRunnerTurn(
									emitUnsent,
									command.sinkId,
									turn,
									failure,
									driver.driverKind,
								),
							);
				return (
					// Abandoned adoption preserves a runner that never received this send.
					(
						child?.lifecycle.failure && sentToRunner
							? stops.awaitStop(child.runnerId, "Escalated").pipe(Effect.ignore)
							: Effect.void
					).pipe(
						Effect.andThen(
							child ? child.outputs.withPermits(1)(cleanup) : cleanup,
						),
					)
				);
			}),
			Effect.onExit(() =>
				Effect.gen(function* () {
					const entry = child;
					if (turn && command.type === "send-turn" && entry && sentToRunner)
						yield* entry.outputs.withPermits(1)(
							Effect.sync(() => sends.commandSettled(turn)),
						);
					else if (turn) sends.commandSettled(turn);
				}),
			),
		);
		if (command.type !== "send-turn") return execute;
		return Effect.gen(function* () {
			if (!send)
				return yield* Effect.die("Send command requires its admitted handle");
			if (held) return yield* execute;
			cancelled =
				(turn?.sendScope
					? sends.pending(turn.sendScope)?.cancelled
					: undefined) ?? (yield* Deferred.make<void>());
			if (command.aborted) yield* Deferred.succeed(cancelled, undefined);
			return yield* Effect.raceFirst(
				Deferred.await(cancelled).pipe(Effect.as(CANCELLED_TURN)),
				execute,
			);
		});
	}
	return { dispatch };
};
