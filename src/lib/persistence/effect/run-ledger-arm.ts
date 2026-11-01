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
import type { InputRequest } from "../../contracts/stored-event.js";
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
import { canonicalEvent, type StoredEvent } from "../events.js";
import { queuePendingWrite } from "./pending-writes.js";
import type {
	EffectProjector,
	ProjectionContext,
	ProjectionTouch,
} from "./projectors-effect.js";
import { runTerminalStatus } from "./projectors-effect.js";

/**
 * settleMs is 3.7's settle window. probeMs and nativeCommandMs: the contract names no value
 * (CONTRACT.md 3.7 "issue + max(probeMs, backoff(n))"); probeMs at the 30 s backoff cap makes a
 * probe's deadline its issue + probeMs (gap, reported).
 */
export const RUN_LEDGER_POLICY: DecideContext["policy"] = {
	settleMs: 7000,
	probeMs: 30_000,
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
			case "evidence.turn_ended":
				return {
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						label: event.data.label,
						eventId: event.eventId,
						kind: "turn_ended",
					},
				};
			case "permission.asked":
			case "question.asked":
			case "permission.resolved":
			case "question.resolved": {
				// 2.1 row 205, 3.10 (CONTRACT.md 216, 999-1006): an OpenCode interaction belongs to the
				// label its session's process reported last; the arm folds its request and its native
				// resolution there (gap, reported). Claude's come from its runner.
				if (getProviderDriver(provider)?.runsOpenCodeServer !== true)
					return undefined;
				const [started] = yield* sql<{ label: string }>`
					SELECT json_extract(data, '$.label') AS label FROM events
					WHERE session_id = ${event.sessionId} AND type = 'evidence.process_started'
						AND sequence < ${event.sequence}
					ORDER BY sequence DESC LIMIT 1`;
				if (!started) return undefined;
				const at = {
					tag: "Unsolicited",
					label: started.label,
					eventId: event.eventId,
					interactionId: event.data.id,
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
	"input.sent",
	"run.requested",
	"run.started",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"session.status",
	"run.dispatched",
	"run.released",
	"interrupt.requested",
	"session.end_requested",
	"evidence.process_started",
	"evidence.process_lost",
	"evidence.alarm_fired",
	"evidence.effect_outcome",
	"evidence.turn_started",
	"evidence.turn_ended",
	"evidence.delivery_indeterminate",
	"evidence.hold_exhausted",
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
				if (!warmed) {
					// 3.12 Load: rebuild only sessions with open work; others load on first touch.
					warmed = true;
					for (const { session_id } of yield* sql<{
						session_id: string;
					}>`SELECT session_id FROM run_ledger_sessions WHERE state = 'Open'`)
						yield* current(session_id);
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
				if (decision.tag === "Rejected" || decision.events.length === 0)
					return untouched;
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
				return stamped.length > 0
					? {
							stamped: stamped.map(({ id }) => id),
							removed: [],
							collections: ["sessions"],
						}
					: untouched;
			}),
	};
}
