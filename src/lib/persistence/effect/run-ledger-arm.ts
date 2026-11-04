/**
 * The Run Ledger's arm (CONTRACT.md 3.1, 3.9, 3.12, D58): one projector in main's write. It folds
 * each event it reads into its session's ledger through the pure decider, records the decision's
 * entries, keeps the per-session row, and inserts the three effects decide issues (probe,
 * stop_task, cancel_request) keyed by the partial unique index, never while replaying. It owns no
 * transaction, fiber or event append: the write that projects the event commits the fold.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import {
	getProviderDriver,
	isKnownDriverKind,
} from "../../contracts/provider-instance.js";
import type {
	EventPayloadMap,
	InputRequest,
} from "../../contracts/stored-event.js";
import { inputIdFromOpenCodeMessageId } from "../../provider/opencode/opencode-input-message-id.js";
import {
	decide,
	evolve,
	fenceHolds,
	initialSessionLedgerState,
	type LedgerEvent,
	type SessionLedgerState,
	viewLedger,
} from "../../provider/run-ledger/run-ledger-decider.js";
import type {
	DecideContext,
	LedgerCommand,
	LedgerView,
	ProviderKind,
	RunEffect,
	SendToken,
} from "../../provider/run-ledger/run-ledger-model.js";
import { sendToken } from "../../provider/runner/runner-protocol.js";
import { harnessForModelProvider } from "../../provider/turn-settings.js";
import { backgroundTaskText } from "../../shared-types.js";
import { canonicalEvent, type StoredEvent } from "../events.js";
import { queuePendingWrite } from "./pending-writes.js";
import type {
	EffectProjector,
	ProjectionContext,
	ProjectionTouch,
} from "./projectors-effect.js";
import { runTerminalStatus, stampMessage } from "./projectors-effect.js";

/**
 * settleMs is 3.7's settle window. probeMs and nativeCommandMs: the contract names no value
 * (CONTRACT.md 3.7 "issue + max(probeMs, backoff(n))"); probeMs at the 30 s backoff cap makes a
 * probe's deadline its issue + probeMs (gap, reported).
 */
export const RUN_LEDGER_POLICY: DecideContext["policy"] = {
	settleMs: 7000,
	probeMs:
		process.env["NODE_ENV"] === "test"
			? Number(process.env["CONDUIT_TEST_RUN_LEDGER_PROBE_MS"] ?? 30_000)
			: 30_000,
	nativeCommandMs: 60_000,
};

/** The three effect types decide issues (3.12); every other outbox type is main's. */
export const LEDGER_EFFECT_TYPES = [
	"probe",
	"stop_task",
	"cancel_request",
] as const;

/**
 * The reactors' wakes for a committed ledger effect insert, keyed by the store's client (3.12 "a
 * wake after the commit that inserts one"). Each reactor on the client registers one; the arm's insert queues a
 * pending write whose committed callback calls it after COMMIT, so a rolled-back insert wakes
 * nothing until a later commit lands it.
 */
export const ledgerEffectWakes = new WeakMap<
	SqlClient.SqlClient,
	Set<() => void>
>();
const wakeKey = Symbol("run-ledger-effect-wake");
/** The reactors' wakes for the commit that releases a fence, so a held start is claimed (2.1 row 202). */
export const ledgerFenceWakes = new WeakMap<
	SqlClient.SqlClient,
	Set<() => void>
>();
const fenceWakeKey = Symbol("run-ledger-fence-wake");
/** The alarm schedulers' wakes for a committed change of a session row's alarm_at (3.7). */
export const ledgerAlarmWakes = new WeakMap<
	SqlClient.SqlClient,
	Set<() => void>
>();
const alarmWakeKey = Symbol("run-ledger-alarm-wake");
/** SessionActivity's wakes for a committed change of a session's native command view (8.5). */
export const ledgerNativeCommandsWakes = new WeakMap<
	SqlClient.SqlClient,
	Set<(sessionId: string, commands: LedgerView["nativeCommands"]) => void>
>();
type TasksSnapshot = {
	readonly tasks: EventPayloadMap["evidence.tasks_snapshot"]["tasks"];
	readonly at: number;
};
/**
 * What SessionActivity reads beyond tasks (8.1): the active Run, input or wake, Servers and the
 * pending confirm's snapshot entry (8.4).
 */
const activityOf = (view: LedgerView) =>
	JSON.stringify([
		view.tasks,
		view.active?.origin,
		view.active?.origin === "wake" ? view.active.wakeTask : undefined,
		[...(view.servers?.values() ?? [])],
		view.pendingConfirm?.snapshotEntry,
	]);
/**
 * SessionActivity's wakes for a committed change of a session's tasks view, active Run, Servers or
 * pending confirm (8.1 "a read-only view"), with that view (8.4: callers copy the confirm's snapshot
 * entry, never compute it) and, for a snapshot, its tasks with their display and
 * its time.
 */
export const ledgerTasksWakes = new WeakMap<
	SqlClient.SqlClient,
	Set<
		(
			sessionId: string,
			tasks: LedgerView["tasks"],
			snapshot: TasksSnapshot | undefined,
			ledger: Pick<LedgerView, "active" | "servers" | "pendingConfirm">,
		) => void
	>
>();
/** Calls each registered wake after the commit that lands this write, never on a rollback. */
const wakeAfterCommit = (
	sql: SqlClient.SqlClient,
	key: symbol,
	wakes: WeakMap<SqlClient.SqlClient, Set<() => void>>,
) =>
	queuePendingWrite(sql, key, {
		apply: Effect.void,
		committed: () => {
			for (const wake of wakes.get(sql) ?? []) wake();
		},
	});

/** An outbox row a writer ended, as its RETURNING ENDED_ROW_COLUMNS reads it. */
export interface EndedOutboxRow {
	readonly command_id: string;
	readonly session_id: string;
	readonly provider_id: string;
	readonly attempt_count: number;
	readonly status: string;
	readonly error_code: string | null;
	readonly next_attempt_at: number | null;
	readonly updated_at: number;
	readonly token: string | null;
}

/** A ledger effect's row names decide's token (3.4); main's controls name none. */
export const ENDED_ROW_COLUMNS = `command_id, session_id, provider_id, attempt_count, status,
	error_code, next_attempt_at, updated_at, CASE WHEN effect_type IN ('probe', 'stop_task',
	'cancel_request') THEN json_extract(payload_json, '$.token') END AS token`;

/**
 * The effect_outcome a writer appends in the write that ends an outbox row (3.4, 3.12): it names
 * (command_id, attempt_count), n 0 when no claim reached the row. completed reads succeeded,
 * retryable_failed reads retryable at its next_attempt_at with its error_code, and failed or
 * cancelled reads permanent with its error_code.
 */
export const endedRowOutcome = (row: EndedOutboxRow) =>
	canonicalEvent(
		"evidence.effect_outcome",
		row.session_id,
		{
			commandId: row.command_id,
			transmission: row.attempt_count,
			...(row.token === null ? {} : { token: row.token }),
			outcome:
				row.status === "completed"
					? { tag: "succeeded" as const }
					: row.status === "retryable_failed"
						? {
								tag: "retryable" as const,
								// Main's retryable writes set next_attempt_at; NULL is due now.
								retryAt: row.next_attempt_at ?? row.updated_at,
								...(row.error_code === null ? {} : { code: row.error_code }),
							}
						: { tag: "permanent" as const, code: row.error_code ?? row.status },
		},
		{ provider: row.provider_id, createdAt: row.updated_at },
	);

/** The per-session row (3.12): Quiescent, or Open with its earliest alarm. */
export interface LedgerRow {
	readonly state: "Quiescent" | "Open";
	readonly alarmAt: number | null;
}

/** 3.12 Load: a Run not Ended, an unsettled send, a pending interaction or native command, a
 * future alarm, or background tasks live or unknown. */
export const ledgerRow = (
	view: LedgerView,
	alarmAt: number | undefined,
): LedgerRow =>
	view.active !== undefined ||
	view.anythingMayAct ||
	alarmAt !== undefined ||
	view.tasks.tag !== "none" ||
	view.interactions.some(
		(interaction) =>
			interaction.tag === "Pending" || interaction.delivery !== "settled",
	) ||
	view.nativeCommands.some(
		(command) =>
			command.tag === "Sent" ||
			command.tag === "Started" ||
			command.tag === "Queued",
	)
		? { state: "Open", alarmAt: alarmAt ?? null }
		: { state: "Quiescent", alarmAt: null };

interface Ledger {
	readonly provider: ProviderKind;
	readonly state: SessionLedgerState;
	readonly entrySeq: number;
	readonly stamp: string | null;
	readonly eventSequence: number;
	readonly row: LedgerRow | undefined;
}

/** Rebuild one session's ledger from its entries (3.12, LI4); undefined with no session row. */
export const loadLedger = (
	sessionId: string,
): Effect.Effect<Ledger | undefined, SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [row] = yield* sql<{
			provider: string;
			state: LedgerRow["state"];
			alarm_at: number | null;
		}>`SELECT provider, state, alarm_at FROM run_ledger_sessions WHERE session_id = ${sessionId}`;
		const [session] = row
			? [{ provider: row.provider, model_provider: null }]
			: yield* sql<{
					provider: string;
					model_provider: string | null;
				}>`SELECT provider, model_provider FROM sessions WHERE id = ${sessionId}`;
		if (!session) return undefined;
		// 3.12: the ledger's provider is the instance's driver kind. A named instance's id
		// ("work-oc") names none, so its session's model pick names it: creation holds a pick's
		// harness to the instance's driver. With neither, Claude's (gap, reported).
		const provider = isKnownDriverKind(session.provider)
			? session.provider
			: session.model_provider
				? harnessForModelProvider(session.model_provider)
				: "claude";
		const entries = yield* sql<{
			entry_seq: number;
			event_sequence: number;
			stamp: string;
			entry_json: string;
		}>`SELECT entry_seq, event_sequence, stamp, entry_json FROM run_ledger_entries
			WHERE session_id = ${sessionId} ORDER BY entry_seq`;
		const last = entries.at(-1);
		return {
			provider,
			// Entries are the decider's own plain-JSON facts; the boundary casts them back.
			state: entries.reduce(
				(state, entry) =>
					evolve(state, JSON.parse(entry.entry_json) as LedgerEvent),
				initialSessionLedgerState(sessionId, provider),
			),
			entrySeq: last?.entry_seq ?? 0,
			stamp: last?.stamp ?? null,
			eventSequence: last?.event_sequence ?? 0,
			row: row ? { state: row.state, alarmAt: row.alarm_at } : undefined,
		};
	});

/** One session's view, rebuilt from its entries. */
export const loadLedgerView = (sessionId: string) =>
	loadLedger(sessionId).pipe(
		Effect.map((ledger) => ledger && viewLedger(ledger.state)),
	);

/** The event's command for the decider, or undefined for an event it does not fold. */
const commandFor = (
	event: StoredEvent,
	provider: ProviderKind,
): Effect.Effect<LedgerCommand | undefined, SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const main = (observation: LedgerCommand & { verb: "observe" }) =>
			observation;
		switch (event.type) {
			case "input.sent": {
				// 3.9 D58: admit is main's handoff; its request is the admission's (gap, reported).
				// Without its images: decide reads no request field, and entry_json holds no
				// AttachmentRef, so attachment retention keeps one owner, input.admitted.
				const [admitted] = yield* sql<{ request: string }>`
					SELECT json_remove(json_extract(data, '$.request'), '$.images') AS request FROM events
					WHERE session_id = ${event.sessionId} AND type = 'input.admitted'
						AND json_extract(data, '$.inputId') = ${event.data.inputId}
						AND sequence < ${event.sequence}
					ORDER BY sequence DESC LIMIT 1`;
				if (!admitted) return undefined;
				return {
					verb: "admit",
					inputId: event.data.inputId,
					delivery: event.data.steer ? "steer" : "queue",
					request: JSON.parse(admitted.request) as InputRequest,
				};
			}
			case "run.requested":
				return main({
					verb: "observe",
					observation: {
						tag: "Main",
						eventId: event.eventId,
						kind: "run_requested",
						runId: event.data.runId,
						inputId: event.data.inputId,
						// 3.4: a direct start is its own transmission; the driver's trait names it (gap).
						direct: getProviderDriver(provider)?.runsOpenCodeServer === true,
					},
				});
			case "message.created": {
				// 9 (CONTRACT.md 3032-3033, 3101-3102): OpenCode's echo of a prompt, its user message under
				// the conduit id main gave it, is that input's acceptance (3.4, 506-507), which beats an
				// earlier absent reading (564, 3128-3131). Conduit's own placement carries the bare input id.
				const inputId =
					event.data.role === "user" &&
					getProviderDriver(provider)?.runsOpenCodeServer === true
						? inputIdFromOpenCodeMessageId(event.data.messageId)
						: undefined;
				if (inputId === undefined) return undefined;
				// 3.4: a direct start's token is its run.requested runId; the echo names no try, so the latest.
				const [requested] = yield* sql<{ runId: string }>`
					SELECT json_extract(data, '$.runId') AS runId FROM events
					WHERE session_id = ${event.sessionId} AND type = 'run.requested'
						AND json_extract(data, '$.inputId') = ${inputId}
						AND sequence < ${event.sequence}
					ORDER BY sequence DESC LIMIT 1`;
				if (!requested) return undefined;
				return {
					verb: "observe",
					observation: {
						tag: "Answer",
						token: requested.runId as SendToken,
						kind: "input_accepted",
						nativeMessageId: event.data.messageId,
					},
				};
			}
			case "run.started":
				return main({
					verb: "observe",
					observation: {
						tag: "Main",
						eventId: event.eventId,
						kind: "run_started",
						// 3.9: the run main started the input in; a native message's names the requested Run.
						runId: event.metadata.runId ?? event.data.requestedRunId,
						inputId: event.data.inputId,
						requestedRunId: event.data.requestedRunId,
					},
				});
			case "turn.completed":
			case "turn.error":
			case "turn.interrupted":
			case "session.status": {
				// 3.9 D59: main's terminal rule; a wake's turn.completed under an ended Run ends nothing (F18).
				const outcome = runTerminalStatus(event, event.provider);
				const runId = event.metadata.runId;
				if (!outcome || !runId) return undefined;
				const code =
					event.type === "turn.error" || event.type === "turn.interrupted"
						? event.data.code
						: undefined;
				return main({
					verb: "observe",
					observation: {
						tag: "Main",
						eventId: event.eventId,
						kind: "run_terminal",
						runId,
						outcome,
						...(code === undefined ? {} : { code }),
					},
				});
			}
			case "run.dispatched": {
				const { runId, runnerId, commandId, transmission } = event.data;
				if (commandId === undefined || transmission === undefined)
					return undefined;
				return {
					verb: "observe",
					observation: {
						tag: "Answer",
						token: sendToken("hold", commandId, transmission),
						kind: "run_dispatched",
						runId,
						runnerId,
						commandId,
						transmission,
					},
				};
			}
			case "run.released":
				return {
					verb: "observe",
					observation: {
						tag: "Answer",
						token: sendToken(
							"hold",
							event.data.commandId,
							event.data.transmission,
						),
						kind: "run_released",
						// The stored Refused names no why; the ledger reads it as exiting (gap, reported).
						reason:
							event.data.reason === "Refused"
								? { tag: "Refused", why: "exiting" }
								: event.data.reason,
					},
				};
			case "interrupt.requested": {
				const commandId = event.metadata.commandId;
				if (commandId === undefined) return undefined;
				const deadlineAt = event.data.stop?.deadlineAt ?? null;
				// 5.1 D58: Run now is the interrupt main's interruptForInput commits after its
				// input.interrupt_requested; the stored interrupt names no input (gap, reported).
				// Keyed by session, so the read never walks other sessions' history (RL-063).
				const [latest] = yield* sql<{ type: string; input_id: string }>`
					SELECT type, json_extract(data, '$.inputId') AS input_id FROM events
					WHERE session_id = ${event.sessionId}
						AND type IN ('input.interrupt_requested', 'interrupt.requested')
						AND sequence < ${event.sequence}
					ORDER BY sequence DESC LIMIT 1`;
				return {
					verb: "control",
					control:
						latest?.type === "input.interrupt_requested"
							? {
									kind: "run_now",
									commandId,
									inputId: latest.input_id,
									deadlineAt,
								}
							: { kind: "stop", commandId, deadlineAt },
				};
			}
			case "session.end_requested": {
				const commandId = event.metadata.commandId;
				if (commandId === undefined) return undefined;
				return {
					verb: "control",
					control: {
						kind: "end",
						commandId,
						// L6: U2's retire folds no deadline.
						deadlineAt: event.data.retireRunIds
							? null
							: (event.data.stop?.deadlineAt ?? null),
					},
				};
			}
			// 8.4: the browser's Stop tasks; decide reads the live tasks at this fold.
			case "tasks.stop_requested":
				return {
					verb: "control",
					control: { kind: "stop_tasks", tasks: event.data.tasks },
				};
			// 8.4, D45: the browser's confirm; decide rejects one older than the latest snapshot.
			case "escalation.confirmed":
				return {
					verb: "control",
					control: {
						kind: "confirm_escalation",
						snapshotEntry: event.data.snapshotEntry,
					},
				};
			case "native_command.requested": {
				const commandId = event.metadata.commandId;
				if (commandId === undefined) return undefined;
				return {
					verb: "control",
					control: { kind: "native_command", commandId, text: event.data.text },
				};
			}
			case "evidence.command_receipt":
				// D61: a native command's receipts are unsolicited, by its commandId.
				return {
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						label: event.data.label,
						eventId: event.eventId,
						kind: "command_lifecycle",
						commandId: event.data.commandId,
						state: event.data.state,
					},
				};
			case "evidence.process_started":
				return {
					verb: "settle",
					settlement: {
						kind: "process_started",
						label: event.data.label,
						reattached: event.data.reattached,
					},
				};
			case "evidence.process_lost":
				return {
					verb: "settle",
					settlement: {
						kind: "process_lost",
						runnerId: event.data.runnerId,
						retiredAt: event.data.retiredAt,
					},
				};
			case "evidence.alarm_fired":
				return { verb: "settle", settlement: { kind: "alarm_fired" } };
			case "evidence.hold_exhausted":
				return {
					verb: "settle",
					settlement: {
						kind: "hold_exhausted",
						commandId: event.data.commandId,
					},
				};
			case "evidence.effect_outcome": {
				const { commandId, transmission, token, outcome } = event.data;
				// 3.4: a ledger effect's outcome names decide's token; any other names main's
				// (commandId, transmission), and the host composes that transmission's token.
				return {
					verb: "observe",
					observation:
						token === undefined
							? {
									tag: "Answer",
									token: sendToken("tx", commandId, transmission),
									kind: "effect_outcome",
									transmission: { commandId, transmission },
									outcome,
								}
							: {
									tag: "Answer",
									token: token as SendToken,
									kind: "effect_outcome",
									outcome,
								},
				};
			}
			case "evidence.probe_result":
				return {
					verb: "observe",
					observation: {
						tag: "Answer",
						token: event.data.token as SendToken,
						kind: "probe_result",
						finding: event.data.finding,
					},
				};
			case "evidence.turn_started":
				return {
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						label: event.data.label,
						eventId: event.eventId,
						kind: "turn_started",
						...(event.data.wakeTask ? { wakeTask: event.data.wakeTask } : {}),
					},
				};
			case "evidence.tasks_snapshot":
				// 8.2: the decider folds only the snapshot's 8.2 fields; the rest is display.
				return {
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						label: event.data.label,
						eventId: event.eventId,
						kind: "tasks_snapshot",
						tasks: event.data.tasks.map(
							({ key, taskType, subagentType, description, ambient }) => ({
								key,
								taskType,
								...(subagentType === undefined ? {} : { subagentType }),
								description,
								ambient,
							}),
						),
					},
				};
			case "evidence.turn_ended": {
				// 8.3 (CONTRACT.md 2823-2828): a Claude wake ended by its result, which main stores no
				// event for, folds that result, its outcome with it; with none it ends at turn_ended.
				const result = event.data.result;
				return {
					verb: "observe",
					observation: result
						? {
								tag: "Unsolicited",
								label: event.data.label,
								eventId: event.eventId,
								kind: "result",
								outcome: result.outcome,
								...(result.code === undefined
									? {}
									: { error: { code: result.code, retryable: false } }),
							}
						: {
								tag: "Unsolicited",
								label: event.data.label,
								eventId: event.eventId,
								kind: "turn_ended",
							},
				};
			}
			case "evidence.server_seen":
				return {
					verb: "settle",
					settlement: { kind: "server_seen", ...event.data },
				};
			case "evidence.server_gone":
				return {
					verb: "settle",
					settlement: { kind: "server_gone", server: event.data.server },
				};
			case "permission.asked":
			case "question.asked":
			case "permission.resolved":
			case "question.resolved":
			case "evidence.interaction_resolved": {
				const opencode =
					getProviderDriver(provider)?.runsOpenCodeServer === true;
				// Codex's prompts are not folded yet: its async questions never resolve (3.10).
				const runnerPrompts = provider === "claude";
				if (!opencode && !runnerPrompts) return undefined;
				const { id: interactionId, providerProcessId } = event.data;
				// 3.10 (CONTRACT.md 1007-1014): Claude's answer from main, its control-outbox commit's
				// commandId, or the timeout's, whose row enqueueCommittedControlAnswers names after the
				// event; first wins. OpenCode's resolves natively at main's answer, as before.
				const commandId = opencode
					? undefined
					: (event.metadata.commandId ??
						(event.metadata.source === "permission-timeout" &&
						providerProcessId !== undefined
							? `legacy-answer:${event.eventId}`
							: undefined));
				if (event.type === "permission.resolved" && commandId !== undefined)
					return {
						verb: "control",
						control: {
							kind: "answer",
							commandId,
							interactionId,
							answer: event.data.decision,
						},
					};
				if (event.type === "question.resolved" && commandId !== undefined)
					return {
						verb: "control",
						control: {
							kind: "answer",
							commandId,
							interactionId,
							answer: event.data.answers,
						},
					};
				// 2.1 row 205, 3.10 (CONTRACT.md 216, 999-1006): an OpenCode interaction belongs to the
				// label its session's process reported last (gap, reported); Claude's to its runner's,
				// the prompt's providerProcessId (relay-event-sink.ts 257).
				const runnerId = opencode ? null : (providerProcessId ?? null);
				if (!opencode && runnerId === null) return undefined;
				const [started] = yield* sql<{ label: string }>`
					SELECT json_extract(data, '$.label') AS label FROM events
					WHERE session_id = ${event.sessionId} AND type = 'evidence.process_started'
						AND (${runnerId} IS NULL OR json_extract(data, '$.runnerId') = ${runnerId})
						AND sequence < ${event.sequence}
					ORDER BY sequence DESC LIMIT 1`;
				if (!started) return undefined;
				const at = {
					tag: "Unsolicited",
					label: started.label,
					eventId: event.eventId,
					interactionId,
				} as const;
				return {
					verb: "observe",
					observation:
						event.type === "permission.asked" || event.type === "question.asked"
							? {
									...at,
									kind: "interaction_requested",
									interactionKind:
										event.type === "permission.asked"
											? "permission"
											: "question",
								}
							: { ...at, kind: "interaction_resolved" },
				};
			}
			case "evidence.delivery_indeterminate":
				return {
					verb: "observe",
					// The direct marker reads as delivery_unknown, never the hold fact a send with no hold
					// cannot produce (CONTRACT.md 527, 1818); a direct start's token is its runId (3.4).
					observation: {
						tag: "Answer",
						token: event.data.runId as SendToken,
						kind: "effect_outcome",
						outcome: { tag: "delivery_unknown" },
					},
				};
			default:
				return undefined;
		}
	});

const ledgerEffect = (effect: RunEffect) =>
	effect.kind === "probe" ||
	effect.kind === "stop_task" ||
	effect.kind === "cancel_request"
		? effect
		: undefined;

const HANDLES = [
	"session.created",
	"input.sent",
	"run.requested",
	"message.created",
	"run.started",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"session.status",
	"run.dispatched",
	"run.released",
	"interrupt.requested",
	"session.end_requested",
	"tasks.stop_requested",
	"escalation.confirmed",
	"native_command.requested",
	"evidence.process_started",
	"evidence.process_lost",
	"evidence.alarm_fired",
	"evidence.effect_outcome",
	"evidence.probe_result",
	"evidence.turn_started",
	"evidence.turn_ended",
	"evidence.command_receipt",
	"evidence.tasks_snapshot",
	"evidence.interaction_resolved",
	"evidence.delivery_indeterminate",
	"evidence.hold_exhausted",
	"evidence.server_seen",
	"evidence.server_gone",
	"permission.asked",
	"permission.resolved",
	"question.asked",
	"question.resolved",
] as const;

const untouched: ProjectionTouch = {
	stamped: [],
	removed: [],
	collections: [],
};

/** A function declaration: projectors-effect imports it while this module imports that one. */
export function makeRunLedgerArm(): Omit<EffectProjector, "handles"> & {
	readonly handles: typeof HANDLES;
} {
	// A cache only: each touch checks its last entry against the store, so a rolled-back write
	// or another writer's commit is reloaded, never read stale (3.12).
	const cache = new Map<string, Ledger>();
	// 8.1: the reader's copy lives in memory, so each session's view is handed over on its first
	// touch in this process, not only when it moves; a restart then shows the tasks it knew.
	const handedOver = new Set<string>();
	let warmed = false;
	const current = (sessionId: string) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const [last] = yield* sql<{ entry_seq: number; stamp: string }>`
				SELECT entry_seq, stamp FROM run_ledger_entries WHERE session_id = ${sessionId}
				ORDER BY entry_seq DESC LIMIT 1`;
			const cached = cache.get(sessionId);
			if (
				cached &&
				cached.entrySeq === (last?.entry_seq ?? 0) &&
				cached.stamp === (last?.stamp ?? null)
			)
				return cached;
			const loaded = yield* loadLedger(sessionId);
			if (loaded) cache.set(sessionId, loaded);
			else cache.delete(sessionId);
			return loaded;
		});
	return {
		name: "run-ledger",
		handles: HANDLES,
		project: (event: StoredEvent, ctx: ProjectionContext) =>
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const handOver = (
					sessionId: string,
					view: LedgerView,
					snapshot: TasksSnapshot | undefined,
				) =>
					queuePendingWrite(sql, `run-ledger-tasks:${sessionId}`, {
						apply: Effect.void,
						committed: () => {
							const wakes = ledgerTasksWakes.get(sql);
							if (!wakes?.size) return;
							handedOver.add(sessionId);
							for (const wake of wakes)
								wake(sessionId, view.tasks, snapshot, view);
						},
					});
				// The display of a first hand-over's live tasks: its latest stored snapshot.
				const storedSnapshot = (
					sessionId: string,
					tasks: LedgerView["tasks"],
					upTo = Number.MAX_SAFE_INTEGER,
				) =>
					tasks.tag !== "live"
						? Effect.succeed(undefined)
						: sql<{ data: string; created_at: number }>`
								SELECT data, created_at FROM events WHERE session_id = ${sessionId}
								AND type = 'evidence.tasks_snapshot' AND sequence <= ${upTo}
								ORDER BY sequence DESC LIMIT 1`.pipe(
								Effect.map(([row]) =>
									row
										? {
												tasks: (
													JSON.parse(
														row.data,
													) as EventPayloadMap["evidence.tasks_snapshot"]
												).tasks,
												at: row.created_at,
											}
										: undefined,
								),
							);
				if (!warmed) {
					// 3.12 Load: rebuild only sessions with open work; others load on first touch.
					warmed = true;
					for (const { session_id } of yield* sql<{
						session_id: string;
					}>`SELECT session_id FROM run_ledger_sessions WHERE state = 'Open'`) {
						const warm = yield* current(session_id);
						// 8.1: the reader learns a restarted session's open work now, not at its next event.
						if (warm && session_id !== event.sessionId) {
							const view = viewLedger(warm.state);
							handOver(
								session_id,
								view,
								yield* storedSnapshot(session_id, view.tasks),
							);
						}
					}
				}
				// 3.3 (CONTRACT.md 312): the Session's provider, stored when the session is created so
				// no first load infers it (gap: the contract names no time for it, reported).
				if (event.type === "session.created") {
					if (isKnownDriverKind(event.data.driver))
						yield* sql`INSERT INTO run_ledger_sessions (session_id, provider, state, alarm_at)
							VALUES (${event.sessionId}, ${event.data.driver}, 'Quiescent', NULL)
							ON CONFLICT (session_id) DO NOTHING`;
					return untouched;
				}
				const ledger = yield* current(event.sessionId);
				if (!ledger || event.sequence <= ledger.eventSequence) return untouched;
				const command = yield* commandFor(event, ledger.provider);
				if (!command) return untouched;
				let minted = 0;
				const decision = decide(ledger.state, command, {
					now: event.createdAt,
					// 3.4: ids from the folded event's sequence, so a replay mints the same ones.
					newId: () => `${event.sequence}.${minted++}`,
					policy: RUN_LEDGER_POLICY,
				});
				if (decision.tag === "Rejected" || decision.events.length === 0) {
					if (!handedOver.has(event.sessionId)) {
						const view = viewLedger(ledger.state);
						handOver(
							event.sessionId,
							view,
							yield* storedSnapshot(
								event.sessionId,
								view.tasks,
								event.sequence,
							),
						);
					}
					return untouched;
				}
				const stamp = randomUUID();
				for (const [index, entry] of decision.events.entries())
					yield* sql`INSERT INTO run_ledger_entries
						(session_id, entry_seq, event_sequence, stamp, entry_json)
						VALUES (${event.sessionId}, ${ledger.entrySeq + index + 1}, ${event.sequence},
							${stamp}, ${JSON.stringify(entry)})`;
				const state = decision.events.reduce(evolve, ledger.state);
				const row = ledgerRow(viewLedger(state), decision.alarmAt);
				// A15: the row is written only when its value changes.
				if (
					row.state !== ledger.row?.state ||
					row.alarmAt !== ledger.row.alarmAt
				)
					yield* sql`INSERT INTO run_ledger_sessions (session_id, provider, state, alarm_at)
						VALUES (${event.sessionId}, ${ledger.provider}, ${row.state}, ${row.alarmAt})
						ON CONFLICT (session_id) DO UPDATE SET state = excluded.state,
							alarm_at = excluded.alarm_at`;
				if (row.alarmAt !== (ledger.row?.alarmAt ?? null))
					wakeAfterCommit(sql, alarmWakeKey, ledgerAlarmWakes);
				const view = viewLedger(state);
				const before = viewLedger(ledger.state);
				if (
					JSON.stringify(view.nativeCommands) !==
					JSON.stringify(before.nativeCommands)
				)
					queuePendingWrite(sql, `run-ledger-commands:${event.sessionId}`, {
						apply: Effect.void,
						committed: () => {
							for (const wake of ledgerNativeCommandsWakes.get(sql) ?? [])
								wake(event.sessionId, view.nativeCommands);
						},
					});
				// 8.4 L5 (CONTRACT.md 2907-2913): each label's lost work, decided once, is a timeline notice
				// at the fact that decided it, so it replays after a reload. The names come from that
				// label's latest stored snapshot, which carries each task's command.
				const noticeIds: string[] = [];
				for (const [index, lost] of view.lostWork
					.slice(before.lostWork.length)
					.entries()) {
					const [stored] =
						lost.tag === "known"
							? yield* sql<{ data: string }>`
									SELECT data FROM events WHERE session_id = ${event.sessionId}
									AND type = 'evidence.tasks_snapshot' AND sequence <= ${event.sequence}
									AND json_extract(data, '$.label') = ${lost.label}
									ORDER BY sequence DESC LIMIT 1`
							: [];
					const details = new Map(
						(stored
							? (
									JSON.parse(
										stored.data,
									) as EventPayloadMap["evidence.tasks_snapshot"]
								).tasks
							: []
						).map((task) => [task.key.taskId, task.detail]),
					);
					const text =
						lost.tag === "known"
							? `Background work ended: ${lost.tasks
									.map((task) => {
										const detail = details.get(task.key.taskId);
										return backgroundTaskText({
											kind: task.kind,
											type: task.taskType,
											description: task.description,
											...(detail ? { detail } : {}),
										});
									})
									.join(", ")}`
							: "Background work may have been lost";
					const messageId = `lost-work-${event.sequence}-${index}`;
					yield* sql`INSERT INTO messages
						(id, session_id, role, text, is_streaming, created_at, updated_at, version, ordinal)
						VALUES (${messageId}, ${event.sessionId}, 'assistant', '', 0, ${event.createdAt},
							${event.createdAt}, ${ctx.version},
							(SELECT COALESCE(MAX(ordinal), 0) + 1 FROM messages WHERE session_id = ${event.sessionId}))
						ON CONFLICT (id) DO NOTHING`;
					yield* sql`INSERT INTO message_parts
						(id, message_id, type, text, metadata, sort_order, created_at, updated_at, version)
						VALUES (${`${messageId}-part`}, ${messageId}, 'text', ${text},
							${JSON.stringify({ notice: true })}, 0, ${event.createdAt}, ${event.createdAt},
							${ctx.version})
						ON CONFLICT (id) DO NOTHING`;
					noticeIds.push(messageId);
				}
				const noticed = yield* stampMessage(noticeIds, ctx);
				if (event.type === "evidence.tasks_snapshot")
					handOver(event.sessionId, view, {
						tasks: event.data.tasks,
						at: event.createdAt,
					});
				else if (!handedOver.has(event.sessionId))
					handOver(
						event.sessionId,
						view,
						yield* storedSnapshot(event.sessionId, view.tasks, event.sequence),
					);
				else if (activityOf(view) !== activityOf(before))
					handOver(event.sessionId, view, undefined);
				cache.set(event.sessionId, {
					provider: ledger.provider,
					state,
					entrySeq: ledger.entrySeq + decision.events.length,
					stamp,
					eventSequence: event.sequence,
					row,
				});
				// 3.1: during replay nothing is issued; the fold alone is rebuilt.
				if (!ctx.replaying) {
					let inserted = false;
					for (const issued of decision.effects) {
						const effect =
							issued.tag === "Tokened"
								? ledgerEffect(issued.effect)
								: undefined;
						if (!effect || issued.tag !== "Tokened") continue;
						const runId =
							effect.kind === "stop_task"
								? (effect.key.runId ?? null)
								: effect.runId;
						const payload = {
							type: effect.kind,
							sessionId: event.sessionId,
							token: issued.token,
							effect,
							// 3.7: probe transmission 1's retry deadline, issue + max(probeMs, backoff(1)).
							...(effect.kind === "probe"
								? { deadlineAt: event.createdAt + RUN_LEDGER_POLICY.probeMs }
								: {}),
						};
						const written = yield* sql<{ command_id: string }>`
							INSERT OR IGNORE INTO provider_command_outbox (
								request_sequence, command_id, project_key, session_id, provider_id,
								effect_type, payload_json, run_id, provider_process_id, status, attempt_count,
								requested_at, updated_at)
							SELECT COALESCE(MAX(request_sequence), 0) + 1,
								${`ledger:${runId ?? "session"}:${effect.kind}:${issued.token}`},
								${event.projectId}, ${event.sessionId},
								(SELECT provider FROM sessions WHERE id = ${event.sessionId}),
								${effect.kind}, ${JSON.stringify(payload)}, ${runId}, NULL, 'pending', 0,
								${event.createdAt}, ${event.createdAt}
							FROM provider_command_outbox
							RETURNING command_id`;
						inserted ||= written.length > 0;
					}
					if (inserted) wakeAfterCommit(sql, wakeKey, ledgerEffectWakes);
					// 2.1 row 202 (CONTRACT.md 215, 714-717): a start waits on the fence with no clock, so the
					// commit that releases it, for a held start's own claim too, wakes the held starts (gap,
					// reported).
					if (fenceHolds(ledger.state)) {
						const held = yield* sql<{ run_id: string | null }>`
							SELECT run_id FROM provider_command_outbox
							WHERE project_key = ${event.projectId} AND session_id = ${event.sessionId}
								AND effect_type = 'send_turn' AND status = 'pending'`;
						if (
							[undefined, ...held.map((row) => row.run_id ?? undefined)].some(
								(claim) =>
									fenceHolds(ledger.state, claim) && !fenceHolds(state, claim),
							)
						)
							wakeAfterCommit(sql, fenceWakeKey, ledgerFenceWakes);
					}
				}
				// A folded fact advances the read model (A.21): its session row takes the version.
				const stamped = yield* sql<{ id: string }>`
					UPDATE sessions SET version = ${ctx.version} WHERE id = ${event.sessionId}
					RETURNING id`;
				return {
					stamped: [...noticed.stamped, ...stamped.map(({ id }) => id)],
					removed: noticed.removed,
					collections: [
						...new Set([
							...noticed.collections,
							...(stamped.length > 0 ? (["sessions"] as const) : []),
						]),
					],
					...(noticed.sidebar ? { sidebar: noticed.sidebar } : {}),
				};
			}),
	};
}
