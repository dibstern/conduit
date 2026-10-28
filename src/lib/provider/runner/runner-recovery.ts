import { Clock, Context, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { AccountSchema } from "../../contracts/account.js";
import { AttachmentRefSchema } from "../../contracts/attachment-ref.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import type { InputDrafts } from "../../domain/relay/Services/input-drafts.js";
import * as Failure from "../../effect/failure-classification.js";
import {
	type ClaudeEventPersistEffect,
	ClaudeEventPersistEffectTag,
} from "../../persistence/effect/claude-event-persist-effect.js";
import {
	type CommitAndSignalProject,
	currentRunnerWriteOrigin,
	flushPendingWrites,
	makeUnboundCommitAndSignal,
} from "../../persistence/effect/commit-and-signal.js";
import {
	makeEventStoreEffect,
	makeUnboundEventStoreEffect,
	UnboundEventStoreEffectTag,
} from "../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../persistence/effect/projection-runner-effect.js";
import { runTerminalStatus } from "../../persistence/effect/projectors-effect.js";
import { makeProviderStateEffect } from "../../persistence/effect/provider-state-effect.js";
import { isRecord } from "../../utils.js";
import {
	ClaudeConfigDirSchema,
	configuredClaudeConfigDir,
} from "../claude/claude-sdk-env.js";
import { ProviderInstanceFailure } from "../errors.js";
import type { OrchestrationEngine } from "../orchestration-engine.js";
import { translateProviderRuntimeEventToDomain } from "../provider-runtime-event-to-domain.js";
import type { TurnResult } from "../types.js";
import { runnerFailure, runnerSinkId } from "./runner-protocol.js";
import type { RunnerRecoveryDependencies } from "./runner-provider-instance.js";
import {
	retrySettlementWrite,
	type SendOutcome,
	settleSend,
} from "./send-settlement.js";
import type { DurableSessionTurn, SessionFailure } from "./session-runner.js";

/** Same-daemon recovery keeps a row while its exact reactor attempt owns it. */
export const currentPendingSendOwner = Context.Reference<
	OrchestrationEngine["ownsPendingSend"] | undefined
>("conduit/provider/currentPendingSendOwner", {
	defaultValue: () => undefined,
});

/** One predicate for legacy provenance, also usable in correlated ledger reads. */
export const legacyRunnerRunPredicate = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	runId: string | import("effect/sql/Statement").Fragment,
) => sql`EXISTS (
	SELECT 1 FROM provider_runs legacy_run
	WHERE legacy_run.id = ${runId} AND legacy_run.session_id = ${sessionId}
	AND NOT EXISTS (SELECT 1 FROM events WHERE session_id = legacy_run.session_id
		AND type = 'run.released' AND json_extract(data, '$.runId') = legacy_run.id)
	AND NOT EXISTS (SELECT 1 FROM events WHERE session_id = legacy_run.session_id
		AND type = 'run.dispatched' AND json_extract(data, '$.runId') = legacy_run.id
		AND json_extract(data, '$.commandId') IS NOT NULL)
	AND (EXISTS (
		SELECT 1 FROM claude_runner_cursors legacy_cursor
		JOIN json_each(CASE WHEN json_valid(legacy_cursor.owned_run_ids)
			THEN CASE json_type(legacy_cursor.owned_run_ids) WHEN 'array' THEN legacy_cursor.owned_run_ids ELSE '[]' END
			ELSE '[]' END) cohort
		JOIN provider_runs legacy_owned ON legacy_owned.id = cohort.value AND legacy_owned.session_id = legacy_cursor.session_id
		WHERE legacy_cursor.session_id = legacy_run.session_id AND cohort.type = 'text'
			AND COALESCE(legacy_owned.joined_into, legacy_owned.id) = legacy_run.id
	) OR EXISTS (SELECT 1 FROM events WHERE session_id = legacy_run.session_id AND type = 'run.dispatched'
		AND json_extract(data, '$.runId') = legacy_run.id AND json_extract(data, '$.commandId') IS NULL)
		OR (legacy_run.started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM events
			WHERE session_id = legacy_run.session_id AND type = 'run.dispatched' AND json_extract(data, '$.runId') = legacy_run.id)))
)`;

export const legacyRunnerRunQuery = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	runId: string,
) =>
	sql<{
		legacy: number;
	}>`SELECT ${legacyRunnerRunPredicate(sql, sessionId, runId)} AS legacy`.pipe(
		Effect.map(([row]) => row?.legacy === 1),
	);

/** Adoption checks durable completion before admitting a retained runner send. */
export const runnerCommandEnded = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	commandId: string,
	attempt?: number,
) =>
	sql<{
		status: string;
		attempt_count: number;
		run_state: string | null;
		run_id: string | null;
		turn_state: string | null;
	}>`
	SELECT outbox.status, outbox.attempt_count, owner.status AS run_state, outbox.run_id, turns.state AS turn_state
	FROM provider_command_outbox outbox
	LEFT JOIN provider_runs reservation ON reservation.id = outbox.run_id AND reservation.session_id = outbox.session_id
	LEFT JOIN provider_runs owner ON owner.id = COALESCE(reservation.joined_into, reservation.id) AND owner.session_id = outbox.session_id
	LEFT JOIN turns ON turns.session_id = outbox.session_id
		AND turns.user_message_id = COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId'))
	WHERE outbox.project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId})
		AND outbox.session_id = ${sessionId} AND outbox.command_id = ${commandId}
	ORDER BY outbox.request_sequence DESC LIMIT 1`.pipe(
		Effect.map(([row]) =>
			row
				? (attempt !== undefined && row.attempt_count !== attempt) ||
					(row.status !== "running" && row.status !== "completed") ||
					// Modern commands acknowledge intake before the send ends. Their
					// resolved run owns completion, not an older retry/continuation turn.
					(row.run_state !== null
						? row.run_state !== "pending" && row.run_state !== "running"
						: row.status !== "running" ||
							(row.run_id === null &&
								row.turn_state !== null &&
								row.turn_state !== "pending" &&
								row.turn_state !== "running"))
				: attempt !== undefined,
		),
		Effect.mapError((cause) => runnerFailure("check recovered command", cause)),
	);

export const runningRunnerCommands = (
	sql: SqlClient.SqlClient,
	driverKind: string,
	driverForAccount: (accountId: string) => string | undefined,
	sessionId?: string,
	includeInactive = false,
	ownerSend?: { readonly runId: string; readonly commandId: string },
	includeHeld = false,
) =>
	Effect.gen(function* () {
		const project = yield* Effect.serviceOption(PersistenceProjectTag);
		const projectId = project._tag === "Some" ? project.value.projectId : null;
		const scope =
			sessionId === undefined
				? sql`(${projectId} IS NULL OR outbox.project_key = ${projectId})`
				: sql`outbox.session_id = ${sessionId} AND outbox.project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId})`;
		const owner = ownerSend
			? sql`outbox.command_id = ${ownerSend.commandId} AND COALESCE(run.joined_into, run.id) = ${ownerSend.runId}`
			: sql`1`;
		const rows = yield* sql<{
			request_sequence: number;
			project_key: string;
			session_id: string;
			provider_id: string;
			command_id: string;
			payload_json: string;
			run_id: string | null;
			error_code: string | null;
			status: string;
			user_message_id: string | null;
			attempt_count: number;
			assistant_message_id: string | null;
		}>`SELECT outbox.request_sequence, outbox.project_key, outbox.session_id, outbox.provider_id, outbox.command_id, outbox.payload_json,
		COALESCE(run.joined_into, run.id) AS run_id,
		COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId')) AS user_message_id,
		outbox.error_code, outbox.status, outbox.attempt_count, turns.assistant_message_id
		FROM provider_command_outbox outbox
		LEFT JOIN provider_runs run ON run.id = outbox.run_id AND run.session_id = outbox.session_id
		LEFT JOIN turns ON turns.session_id = outbox.session_id
			AND turns.user_message_id = COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId'))
		WHERE ${scope} AND ${owner}
			AND (outbox.status = 'running' OR (${includeHeld}
				AND run.status IN ('pending', 'running') AND run.runner_id IS NOT NULL
				AND run.held_transmission IS NOT NULL) OR (${includeInactive}
				AND outbox.status = 'cancelled' AND outbox.error_code = 'project_inactive'
				AND run.status IN ('pending', 'running')))
			AND outbox.effect_type = 'send_turn'
		ORDER BY outbox.request_sequence`;
		const commands = rows.filter(
			(row) => driverForAccount(row.provider_id) === driverKind,
		);
		if (driverKind === "claude")
			for (const row of commands) {
				const payload = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
				)(row.payload_json).pipe(
					Effect.mapError(
						(cause) =>
							new ProviderInstanceFailure({
								providerId: "claude",
								operation: "validate stored folders",
								cause,
							}),
					),
				);
				const nativeThread = payload["nativeThread"];
				for (const folder of [
					payload["configDir"],
					...(isRecord(nativeThread) ? [nativeThread["configDir"]] : []),
				])
					if (folder !== undefined)
						yield* Schema.decodeUnknownEffect(ClaudeConfigDirSchema)(
							typeof folder === "string"
								? configuredClaudeConfigDir(folder)
								: folder,
						).pipe(
							Effect.mapError(
								(cause) =>
									new ProviderInstanceFailure({
										providerId: "claude",
										operation: "validate stored folders",
										cause,
									}),
							),
						);
			}
		return commands;
	});

/** The outbox adapter appends one terminal; projection settles the command. */
export const settleRunnerCommandReply = (
	sql: SqlClient.SqlClient,
	row: Pick<
		Effect.Success<ReturnType<typeof runningRunnerCommands>>[number],
		| "request_sequence"
		| "project_key"
		| "session_id"
		| "command_id"
		| "attempt_count"
		| "provider_id"
		| "run_id"
		| "payload_json"
	>,
	result: TurnResult | undefined,
	failure: SessionFailure | undefined,
	now: number,
	outcome: SendOutcome,
	options: {
		readonly project: CommitAndSignalProject;
		readonly persistUserMessage?: ClaudeEventPersistEffect["persistUserMessage"];
		readonly userMessageIdForInput?: (
			driver: string,
			inputId: string,
		) => string | undefined;
		readonly retryAt?: number;
		readonly inputDrafts?: Pick<InputDrafts, "restoreChange">;
		readonly afterCommit?: (effect: Effect.Effect<void>) => void;
		readonly driverKind?: string;
		readonly processLost?: boolean;
		readonly covered?: boolean;
	},
) =>
	Effect.gen(function* () {
		if (!row.run_id) return;
		const completed = outcome === "succeeded";
		const retryable = outcome === "retryable";
		const interrupted = outcome === "cancelled";
		const code = completed
			? null
			: interrupted
				? "interrupted"
				: String(
						failure?.code ??
							result?.error?.code ??
							result?.status ??
							"provider_failure",
					);
		const message =
			failure?.message ?? result?.error?.message ?? code ?? "provider_failure";
		const payloadResult = !completed
			? yield* Effect.result(
					Schema.decodeUnknownEffect(
						Schema.fromJsonString(
							Schema.Struct({
								prompt: Schema.String,
								text: Schema.optionalKey(Schema.String),
								inputId: Schema.optionalKey(Schema.String),
								commandId: Schema.optionalKey(Schema.String),
								userMessageId: Schema.optionalKey(Schema.String),
								turnId: Schema.optionalKey(Schema.String),
								continuation: Schema.optionalKey(Schema.Unknown),
								account: Schema.optionalKey(AccountSchema),
								images: Schema.optionalKey(Schema.Array(AttachmentRefSchema)),
							}),
						),
					)(row.payload_json),
				)
			: undefined;
		// An undecodable payload still settles; it only skips the payload's duties.
		const payload =
			payloadResult?._tag === "Success" ? payloadResult.success : undefined;
		// Receipt and terminal stay in this caller-owned transaction.
		yield* sql`UPDATE command_receipts
			SET error = ${failure ? JSON.stringify(failure) : result?.error ? JSON.stringify(result.error) : null}
			WHERE command_id = ${row.command_id} AND project_key = ${row.project_key}
				AND status = 'side_effect_requested'
				AND ${row.request_sequence} = (SELECT MAX(request_sequence) FROM provider_command_outbox
					WHERE command_id = ${row.command_id} AND project_key = ${row.project_key})`;
		if (completed && result?.providerStateUpdates.length) {
			const state = yield* makeProviderStateEffect.pipe(
				Effect.provideService(SqlClient.SqlClient, sql),
				Effect.provideService(PersistenceProjectTag, {
					projectId: row.project_key,
				}),
			);
			yield* state.saveUpdates(
				row.session_id,
				result.providerStateUpdates.map(({ key, value }) => ({
					key,
					value: String(value),
				})),
			);
		}
		const inputId = payload
			? payload.continuation === true
				? (payload.commandId ?? row.command_id)
				: (payload.inputId ??
					payload.userMessageId ??
					payload.commandId ??
					payload.turnId ??
					row.command_id)
			: row.command_id;
		const [placement] = yield* sql<{
			placed: number;
			shown: number;
			steering: number;
		}>`SELECT
			EXISTS (SELECT 1 FROM turns WHERE session_id = ${row.session_id} AND run_id = ${row.run_id}) AS placed,
			EXISTS (SELECT 1 FROM messages WHERE session_id = ${row.session_id} AND input_id = ${inputId}) AS shown,
			EXISTS (SELECT 1 FROM pending_inputs WHERE session_id = ${row.session_id}
				AND input_id = ${row.command_id} AND state = 'steering') AS steering`;
		if (
			payload &&
			options.persistUserMessage &&
			!placement?.placed &&
			(!placement?.steering || code === "send_admission_timeout") &&
			(!interrupted || options.covered)
		) {
			const continuation = payload.continuation;
			const cutOffMessageId =
				continuation === true
					? payload.userMessageId
					: isRecord(continuation) &&
							typeof continuation["cutOffMessageId"] === "string"
						? continuation["cutOffMessageId"]
						: undefined;
			const driver = payload.account?.driver ?? row.provider_id;
			yield* options.persistUserMessage(row.session_id, payload.prompt, {
				projectId: row.project_key,
				project: options.project,
				messageId:
					cutOffMessageId ??
					options.userMessageIdForInput?.(driver, inputId) ??
					inputId,
				inputId,
				runId: row.run_id,
				provider: driver,
				...(payload.images ? { images: payload.images } : {}),
			});
		}
		// Exhaustion returns the text even when an earlier transmission placed it.
		if (
			outcome === "permanent" &&
			payload &&
			options.inputDrafts &&
			(code === "provider_send_attempts_exhausted" ||
				(!placement?.placed && !placement?.shown)) &&
			!placement?.steering
		) {
			const change = options.inputDrafts.restoreChange(
				{ session: row.session_id },
				inputId,
				payload.images ?? [],
				payload.text ?? payload.prompt,
				now,
			);
			yield* change.write.pipe(Effect.provideService(SqlClient.SqlClient, sql));
			options.afterCommit?.(change.publish);
		}
		const store = yield* makeEventStoreEffect.pipe(
			Effect.provideService(SqlClient.SqlClient, sql),
			Effect.provideService(PersistenceProjectTag, {
				projectId: row.project_key,
			}),
		);
		const { events } = translateProviderRuntimeEventToDomain({
			eventId: `provider-command-terminal:${row.request_sequence}:${row.attempt_count}`,
			type: completed
				? "turn.completed"
				: interrupted
					? "turn.interrupted"
					: "turn.error",
			providerId: options.processLost
				? "conduit"
				: (options.driverKind ?? row.provider_id),
			sessionId: row.session_id,
			runId: row.run_id,
			providerRefs: {},
			rawSource: {
				kind: options.processLost
					? "conduit.session-run-settlement"
					: "runner.command-reply",
			},
			createdAt: now,
			data: completed
				? { messageId: `provider-command:${row.command_id}` }
				: interrupted
					? { messageId: "", reason: message }
					: {
							messageId: options.processLost
								? ""
								: `provider-command:${row.command_id}`,
							error: message,
							code,
							retryable,
							...(retryable && options.retryAt !== undefined
								? { retryAt: options.retryAt }
								: {}),
						},
		});
		const idle = options.processLost
			? translateProviderRuntimeEventToDomain({
					eventId: `provider-command-idle:${row.request_sequence}:${row.attempt_count}`,
					type: "session.status",
					providerId: "conduit",
					sessionId: row.session_id,
					runId: row.run_id,
					providerRefs: {},
					rawSource: { kind: "conduit.session-run-settlement" },
					createdAt: now,
					data: { sessionId: row.session_id, status: "idle" },
				}).events
			: [];
		yield* options.project(yield* store.appendBatch([...events, ...idle]));
	});

/** Attached runners claim admissions; live retirement cleanup owns its captured runs. */
export const settleUnclaimedRunnerCommands = <E>(
	sql: SqlClient.SqlClient,
	claimedSessions: ReadonlySet<string>,
	driverKind: string,
	driverForAccount: (accountId: string) => string | undefined,
	failTurn: (
		sinkId: string,
		turn: {
			sessionId: string;
			accountId: string;
			runId?: string;
			userMessageId?: string;
			messageId: string;
		},
		failure: SessionFailure,
		beforeProject: Effect.Effect<void, SqlError>,
	) => Effect.Effect<void, E>,
	recoveryForSession?: (
		sessionId: string,
	) => Effect.Effect<RunnerRecoveryDependencies | undefined>,
	sessionIds?: ReadonlySet<string>,
	ownsPendingSend?: OrchestrationEngine["ownsPendingSend"],
	ownsRetirementCleanup?: (
		sessionId: string,
		runId: string,
	) => Effect.Effect<boolean, SqlError>,
) =>
	Effect.gen(function* () {
		for (const row of yield* runningRunnerCommands(
			sql,
			driverKind,
			driverForAccount,
			undefined,
			// Removal ends the command without inventing a turn terminal. Once
			// the project returns, confirmed runner loss must still settle its run.
			true,
		)) {
			if (sessionIds && !sessionIds.has(row.session_id)) continue;
			if (claimedSessions.has(row.session_id)) continue;
			const unclaimed = Effect.suspend(() =>
				row.run_id && ownsRetirementCleanup
					? ownsRetirementCleanup(row.session_id, row.run_id).pipe(
							Effect.flatMap((owned) =>
								owned ? Effect.interrupt : Effect.void,
							),
						)
					: Effect.void,
			);
			if (
				row.run_id &&
				ownsRetirementCleanup &&
				(yield* ownsRetirementCleanup(row.session_id, row.run_id))
			)
				continue;
			const recovery = yield* recoveryForSession?.(row.session_id) ??
				Effect.succeed(undefined);
			if (recoveryForSession && !recovery) continue;
			const failure: SessionFailure = {
				operation: "recover stopped runner",
				message: `${driverKind.charAt(0).toUpperCase()}${driverKind.slice(1)} runner stopped before completing the turn`,
				code: "runner_stopped",
				retryable: false,
			};
			const [requested] = yield* sql<{
				joined_into: string | null;
			}>`SELECT run.joined_into
				FROM provider_command_outbox command JOIN provider_runs run
					ON run.id = command.run_id AND run.session_id = command.session_id
				WHERE command.request_sequence = ${row.request_sequence} AND command.project_key = ${row.project_key}`;
			if (
				row.run_id &&
				requested?.joined_into === null &&
				!(yield* legacyRunnerRunQuery(sql, row.session_id, row.run_id))
			) {
				const projector = yield* Effect.serviceOption(
					ProjectionRunnerEffectTag,
				);
				if (projector._tag === "None") continue;
				const eventStore = yield* makeUnboundEventStoreEffect.pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
				);
				const commit = yield* makeUnboundCommitAndSignal.pipe(
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.provideService(UnboundEventStoreEffectTag, eventStore),
					Effect.provideService(ProjectionRunnerEffectTag, projector.value),
				);
				const evidence = {
					_tag: "failed" as const,
					send: {
						sessionId: row.session_id,
						runId: row.run_id,
						commandId: row.command_id,
						requestSequence: row.request_sequence,
						attempt: row.attempt_count,
					},
					failure,
					observedAt: yield* Clock.currentTimeMillis,
				};
				const followUps: Effect.Effect<void>[] = [];
				yield* retrySettlementWrite(
					commit.write(
						(project, stamp) =>
							Effect.gen(function* () {
								followUps.length = 0;
								if (
									ownsPendingSend?.(
										row.session_id,
										row.command_id,
										row.request_sequence,
										row.attempt_count,
									)
								)
									return;
								if (
									ownsRetirementCleanup &&
									(yield* ownsRetirementCleanup(
										row.session_id,
										evidence.send.runId,
									))
								)
									return;
								if (
									yield* legacyRunnerRunQuery(
										sql,
										row.session_id,
										evidence.send.runId,
									)
								)
									return;
								yield* settleSend(
									{
										sql,
										project,
										stamp,
										driverKind,
										...(recovery
											? {
													persistUserMessage:
														recovery.persist.persistUserMessage,
												}
											: {}),
										...(recovery?.inputDrafts
											? { inputDrafts: recovery.inputDrafts }
											: {}),
										afterCommit: (effect) => followUps.push(effect),
									},
									evidence,
								);
							}),
						{
							projectId: row.project_key,
							afterCommit: Effect.suspend(() =>
								Effect.forEach(followUps, (effect) => effect, {
									discard: true,
								}),
							),
						},
					),
				);
				yield* recovery?.wakeReactor ?? Effect.void;
				continue;
			}
			const settled = yield* failTurn(
				runnerSinkId(
					row.command_id,
					row.attempt_count,
					(JSON.parse(row.payload_json) as DurableSessionTurn)
						.nativeResumeFallback,
				),
				{
					sessionId: row.session_id,
					accountId: row.provider_id,
					...(row.run_id ? { runId: row.run_id } : {}),
					...(row.user_message_id
						? { userMessageId: row.user_message_id }
						: {}),
					messageId: row.assistant_message_id ?? "",
				},
				failure,
				Effect.gen(function* () {
					yield* unclaimed;
					// Acquire the write lock and compare the snapshot in the same
					// ingestion transaction that would append the orphan terminal.
					const [current] =
						yield* sql`UPDATE provider_command_outbox SET status = status
						WHERE request_sequence = ${row.request_sequence}
							AND project_key = ${row.project_key} AND command_id = ${row.command_id}
							AND session_id = ${row.session_id} AND status = ${row.status}
							AND attempt_count = ${row.attempt_count} RETURNING command_id`;
					if (
						!current ||
						ownsPendingSend?.(
							row.session_id,
							row.command_id,
							row.request_sequence,
							row.attempt_count,
						)
					)
						return yield* Effect.interrupt;
				}),
			).pipe(
				Effect.as(true),
				Effect.catchCause((cause) =>
					Failure.isInterruptedOnly(cause)
						? Effect.succeed(false)
						: Effect.failCause(cause),
				),
			);
			if (!settled) continue;
			const settle = settleRunnerCommand(
				sql,
				row.project_key,
				row.session_id,
				row.command_id,
				row.attempt_count,
				undefined,
				failure,
				driverKind,
			);
			yield* recovery
				? settle.pipe(
						Effect.provideService(
							ClaudeEventPersistEffectTag,
							recovery.persist,
						),
					)
				: settle;
		}
	});

export const settleRunnerCommand = (
	sql: SqlClient.SqlClient,
	projectId: string,
	sessionId: string,
	commandId: string,
	attempt: number,
	result: TurnResult | undefined,
	failure: SessionFailure | undefined,
	driverKind: string,
	runnerId?: string,
) =>
	Effect.gen(function* () {
		const succeeded =
			!failure &&
			result !== undefined &&
			runTerminalStatus(
				{
					type: `turn.${result.status === "joined" ? "completed" : result.status}`,
					data: {},
				},
				driverKind,
			) === "completed";
		const saveState = Effect.gen(function* () {
			if (!succeeded || !result?.providerStateUpdates.length) return;
			const [current] = yield* sql`SELECT 1 FROM provider_command_outbox
				WHERE project_key = ${projectId} AND command_id = ${commandId}
					AND session_id = ${sessionId} AND attempt_count = ${attempt}`;
			if (!current) return;
			const providerState = yield* makeProviderStateEffect.pipe(
				Effect.provideService(SqlClient.SqlClient, sql),
				Effect.provideService(PersistenceProjectTag, { projectId }),
			);
			yield* providerState.saveUpdates(
				sessionId,
				result.providerStateUpdates.map(({ key, value }) => ({
					key,
					value: String(value),
				})),
			);
		});
		const origin = runnerId ?? (yield* currentRunnerWriteOrigin);
		const projector = yield* Effect.serviceOption(ProjectionRunnerEffectTag);
		// Minimal state-only runners have no projection capability. Their terminal
		// ingestion already owns any input reconciliation through the seam.
		if (projector._tag === "None")
			return yield* flushPendingWrites(
				sql,
				saveState,
				origin ? { runnerId: origin } : {},
			);
		const eventStore = yield* makeUnboundEventStoreEffect.pipe(
			Effect.provideService(SqlClient.SqlClient, sql),
		);
		const commit = yield* makeUnboundCommitAndSignal.pipe(
			Effect.provideService(SqlClient.SqlClient, sql),
			Effect.provideService(UnboundEventStoreEffectTag, eventStore),
			Effect.provideService(ProjectionRunnerEffectTag, projector.value),
		);
		yield* commit.write(() => saveState, {
			projectId,
			...(origin ? { runnerId: origin } : {}),
		});
	});
