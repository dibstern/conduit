import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { SqlClient } from "@effect/sql";
import { Data, Deferred, Effect, Schema } from "effect";
import { ProviderRuntimeEventSchema } from "../../contracts/providers/provider-runtime-event.js";
import { CanonicalEventSchema } from "../../persistence/events.js";
import { ProviderPermissionUpdateSchema } from "../../shared-types.js";
import { ClaudeRuntimeError } from "../event-sink-errors.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "../provider-runtime-event-to-domain.js";
import type { TurnResult } from "../types.js";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import {
	type ClaudeRunnerMessage,
	type ClaudeRunnerSocket,
	claudeRunnerSinkId,
} from "./claude-runner-protocol.js";
import {
	currentClaudeRunnerOutput,
	type makeClaudeRunnerReceiptStore,
	replayingStoppedClaudeRunner,
} from "./claude-runner-receipts.js";
import {
	type ClaudeRunnerRegistration,
	quarantineClaudeRunnerJournal,
	removeClaudeRunner,
} from "./claude-runner-registry.js";
import { failClaudeRunnerTurn } from "./claude-runner-turn-failure.js";
import type {
	ClaudeSessionFailure,
	ClaudeSessionOutput,
	ClaudeSessionOutputReply,
	ClaudeSessionTurn,
} from "./claude-session-runner.js";

class ClaudeRunnerJournalError extends Data.TaggedError(
	"ClaudeRunnerJournalError",
)<{
	readonly message: string;
}> {}

const strings = Schema.Array(Schema.String);
const record = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const outputSequence = Schema.Number.pipe(Schema.int(), Schema.positive());
const sessionOutputSchema = Schema.Union(
	Schema.Struct({
		type: Schema.Literal("event"),
		sinkId: Schema.String,
		event: ProviderRuntimeEventSchema,
	}),
	Schema.Struct({
		type: Schema.Literal("background-task"),
		transition: Schema.Union(
			Schema.Struct({
				sessionId: Schema.String,
				kind: Schema.Literal("session-ended"),
			}),
			Schema.Struct({
				sessionId: Schema.String,
				kind: Schema.Literal("snapshot"),
				taskTypes: strings,
			}),
		),
	}),
	Schema.Struct({
		type: Schema.Literal("permission-request"),
		sinkId: Schema.String,
		request: Schema.Struct({
			requestId: Schema.String,
			sessionId: Schema.String,
			turnId: Schema.String,
			providerItemId: Schema.String,
			toolName: Schema.String,
			toolInput: record,
			always: Schema.optional(strings),
			permissionSuggestions: Schema.optional(
				Schema.Array(ProviderPermissionUpdateSchema),
			),
			permissionTitle: Schema.optional(Schema.String),
			permissionDisplayName: Schema.optional(Schema.String),
			permissionDescription: Schema.optional(Schema.String),
			permissionReason: Schema.optional(Schema.String),
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("question-request"),
		sinkId: Schema.String,
		request: Schema.Struct({
			requestId: Schema.String,
			toolUseId: Schema.optional(Schema.String),
			questions: Schema.Array(
				Schema.Struct({
					question: Schema.String,
					header: Schema.String,
					multiSelect: Schema.optional(Schema.Boolean),
					custom: Schema.optional(Schema.Boolean),
					options: Schema.Array(
						Schema.Struct({ label: Schema.String, description: Schema.String }),
					),
				}),
			),
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("release-sink", "read-turn-history"),
		sinkId: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("cancel-interaction"),
		sinkId: Schema.String,
		requestId: Schema.String,
	}),
	Schema.Struct({
		type: Schema.Literal("resolve-permission"),
		sinkId: Schema.String,
		requestId: Schema.String,
		response: Schema.Struct({
			decision: Schema.Literal("once", "always", "reject"),
			permissionUpdates: Schema.optional(
				Schema.Array(ProviderPermissionUpdateSchema),
			),
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("resolve-question"),
		sinkId: Schema.String,
		requestId: Schema.String,
		answers: record,
	}),
	Schema.Struct({
		type: Schema.Literal("cancel-interactions"),
		sinkId: Schema.String,
		reason: Schema.String,
		recoverQuestions: Schema.Boolean,
	}),
	Schema.Struct({
		type: Schema.Literal("materialize-subagents"),
		sinkId: Schema.String,
		input: Schema.Struct({
			parentConduitSessionId: Schema.String,
			parentClaudeSessionId: Schema.String,
			workspaceRoot: Schema.String,
			knownTasks: Schema.Array(
				Schema.Tuple(
					Schema.String,
					Schema.Struct({
						toolUseId: Schema.String,
						description: Schema.optional(Schema.String),
						subagentType: Schema.optional(Schema.String),
					}),
				),
			),
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("ensure-subagent-session"),
		sinkId: Schema.String,
		input: Schema.Struct({
			childSessionId: Schema.String,
			parentSessionId: Schema.String,
			providerSessionId: Schema.String,
			title: Schema.String,
		}),
	}),
);
const journalMessageSchema = Schema.Union(
	Schema.Struct({
		type: Schema.Literal("output"),
		outputId: Schema.String,
		sequence: outputSequence,
		output: sessionOutputSchema,
	}),
	Schema.Struct({
		type: Schema.Literal("hello"),
		protocolVersion: Schema.Number,
		buildId: Schema.String,
		bindings: Schema.optional(
			Schema.Array(
				Schema.Struct({ sinkId: Schema.String, sessionId: Schema.String }),
			),
		),
		pendingOutputs: Schema.optional(
			Schema.Array(
				Schema.Struct({
					sequence: outputSequence,
					output: sessionOutputSchema,
				}),
			),
		),
		completedCommands: Schema.optional(
			Schema.Array(
				Schema.Struct({
					commandId: Schema.String,
					result: Schema.optional(
						Schema.Struct({
							status: Schema.Literal(
								"completed",
								"interrupted",
								"error",
								"cancelled",
							),
							providerStateUpdates: Schema.Array(
								Schema.Struct({ key: Schema.String, value: Schema.Unknown }),
							),
							error: Schema.optional(
								Schema.Struct({
									code: Schema.String,
									message: Schema.String,
									retryable: Schema.optional(Schema.Boolean),
								}),
							),
						}),
					),
					failure: Schema.optional(
						Schema.Struct({
							operation: Schema.String,
							message: Schema.String,
							name: Schema.optional(Schema.String),
							code: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
							retryable: Schema.optional(Schema.Boolean),
						}),
					),
				}),
			),
		),
	}),
);
const validateJournalMessage = Schema.decodeUnknownSync(journalMessageSchema);
const validateCanonicalEvent = Schema.decodeUnknownSync(CanonicalEventSchema);

/** Commit a full-stop journal after its original runner and relay scope are gone. */
export const recoverStoppedClaudeRunner = (
	sql: SqlClient.SqlClient,
	receipts: Effect.Effect.Success<
		ReturnType<typeof makeClaudeRunnerReceiptStore>
	>,
	registration: ClaudeRunnerRegistration,
	emit: (
		output: ClaudeSessionOutput,
	) => Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure>,
	settleUnclaimedTurns = false,
) =>
	Effect.gen(function* () {
		const journal = `${registration.socketPath}.recovery`;
		const contents = yield* Effect.try({
			try: () => readFileSync(journal, "utf8"),
			catch: (cause) => new ClaudeRuntimeError({ message: String(cause) }),
		});
		let truncated = false;
		const messages = yield* Effect.try({
			try: () => {
				const lines = contents.split("\n").slice(1);
				if (contents.endsWith("\n")) lines.pop();
				const parsed: ClaudeRunnerMessage[] = [];
				for (const [index, line] of lines.entries()) {
					let value: unknown;
					try {
						value = JSON.parse(line);
					} catch (cause) {
						// Only an unterminated final JSON record can be a torn append.
						if (
							cause instanceof SyntaxError &&
							index === lines.length - 1 &&
							!contents.endsWith("\n")
						) {
							truncated = true;
							break;
						}
						throw cause;
					}
					validateJournalMessage(value);
					parsed.push(value as ClaudeRunnerMessage);
				}
				if (parsed[0]?.type !== "hello")
					throw new ClaudeRunnerJournalError({
						message: "Missing retained Claude runner hello",
					});
				return parsed;
			},
			// Pure journal decoding/validation is corruption; store failures stay retryable.
			catch: (cause) =>
				new ClaudeRunnerJournalError({ message: String(cause) }),
		});
		const attachmentId = randomUUID();
		let { sequence: acknowledged } = yield* receipts.attach(
			registration.runnerId,
			attachmentId,
		);
		const sinkIds = new Set<string>();
		const restoredRequests = new Set<string>();
		const restored = {
			runnerId: registration.runnerId,
			sequence: acknowledged,
			attachmentId,
			committed: yield* Deferred.make<void>(),
			consumed: true,
		};
		const restoreAsk = (output: ClaudeSessionOutput) =>
			Effect.suspend(() => {
				if (
					output.type !== "permission-request" &&
					output.type !== "question-request"
				)
					return Effect.void;
				if (restoredRequests.has(output.request.requestId)) return Effect.void;
				restoredRequests.add(output.request.requestId);
				return emit(output).pipe(
					Effect.locally(currentClaudeRunnerOutput, restored),
				);
			});
		const completed = new Map<
			string,
			NonNullable<
				Extract<ClaudeRunnerMessage, { type: "hello" }>["completedCommands"]
			>[number]
		>();
		let mapperState = emptyProviderRuntimeDomainMapperState;
		for (const message of messages) {
			if (message.type === "hello") {
				for (const binding of message.bindings ?? [])
					sinkIds.add(binding.sinkId);
				for (const command of message.completedCommands ?? [])
					completed.set(command.commandId, command);
				for (const pending of message.pendingOutputs ?? [])
					if (pending.sequence <= acknowledged)
						yield* restoreAsk(pending.output);
				continue;
			}
			if (message.type !== "output") continue;
			if ("sinkId" in message.output) sinkIds.add(message.output.sinkId);
			const sequence = message.sequence;
			if (
				sequence === undefined ||
				!Number.isSafeInteger(sequence) ||
				sequence < 1
			)
				return yield* new ClaudeRunnerJournalError({
					message: "Invalid retained Claude output sequence",
				});
			if (sequence <= acknowledged) {
				yield* restoreAsk(message.output);
				continue;
			}
			if (sequence !== acknowledged + 1)
				return yield* new ClaudeRunnerJournalError({
					message: "Non-contiguous retained Claude output",
				});
			if (message.output.type === "event") {
				const event = message.output.event;
				mapperState = yield* Effect.try({
					try: () => {
						const mapped = translateProviderRuntimeEventToDomain(
							event,
							mapperState,
						);
						for (const domainEvent of mapped.events)
							validateCanonicalEvent(domainEvent);
						return mapped.state;
					},
					catch: (cause) =>
						new ClaudeRunnerJournalError({ message: String(cause) }),
				});
			}
			const committed = yield* Deferred.make<void>();
			const receipt = {
				runnerId: registration.runnerId,
				sequence,
				attachmentId,
				committed,
				consumed: false,
			};
			const result = yield* emit(message.output).pipe(
				Effect.locally(currentClaudeRunnerOutput, receipt),
			);
			if (
				message.output.type === "permission-request" ||
				message.output.type === "question-request"
			) {
				yield* Deferred.await(committed);
				restoredRequests.add(message.output.request.requestId);
			} else if (
				!receipt.consumed ||
				result.history !== undefined ||
				result.children !== undefined
			)
				yield* receipts.acknowledge(
					registration.runnerId,
					sequence,
					result,
					attachmentId,
				);
			acknowledged = sequence;
		}
		yield* settleStoppedClaudeRunnerTurns(
			sql,
			registration.sessionId,
			emit,
			sinkIds,
			completed,
			settleUnclaimedTurns,
		);
		// Only committed frames and settled command attempts permit deletion.
		yield* Effect.sync(() => {
			if (truncated)
				quarantineClaudeRunnerJournal(
					registration,
					"Truncated final journal record",
				);
			else {
				removeClaudeRunner(registration.socketPath);
				rmSync(journal);
			}
		});
		return truncated;
	}).pipe(
		Effect.catchTag("ClaudeRunnerJournalError", (cause) =>
			Effect.try({
				try: () => {
					quarantineClaudeRunnerJournal(registration, cause);
					return true;
				},
				catch: (error) => new ClaudeRuntimeError({ message: String(error) }),
			}),
		),
		Effect.locally(replayingStoppedClaudeRunner, true),
	);

/** A quarantined journal can only retry settlement, never its damaged contents. */
export const settleQuarantinedClaudeRunner = (
	sql: SqlClient.SqlClient,
	registration: ClaudeRunnerRegistration,
	emit: (
		output: ClaudeSessionOutput,
		sessionId: string,
	) => Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure>,
	liveSessions: readonly string[],
) =>
	Effect.gen(function* () {
		yield* settleStoppedClaudeRunnerTurns(
			sql,
			registration.sessionId,
			emit,
			new Set(),
			new Map(),
			true,
			liveSessions,
			true,
		);
		yield* Effect.try({
			try: () =>
				writeFileSync(
					`${registration.socketPath}.recovery.failed.settled`,
					"",
					{ mode: 0o600 },
				),
			catch: (cause) => new ClaudeRuntimeError({ message: String(cause) }),
		});
	}).pipe(Effect.locally(replayingStoppedClaudeRunner, true));

const settleStoppedClaudeRunnerTurns = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	emit: (
		output: ClaudeSessionOutput,
		sessionId: string,
	) => Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure>,
	sinkIds: ReadonlySet<string>,
	completed: ReadonlyMap<
		string,
		NonNullable<
			Extract<ClaudeRunnerMessage, { type: "hello" }>["completedCommands"]
		>[number]
	>,
	settleUnclaimedTurns: boolean,
	liveSessions: readonly string[] = [],
	quarantined = false,
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{
			session_id: string;
			command_id: string;
			payload_json: string;
			attempt_count: number;
			assistant_message_id: string | null;
			state: string | null;
		}>`SELECT outbox.session_id, outbox.command_id, outbox.payload_json, outbox.attempt_count, turns.assistant_message_id, turns.state
		FROM provider_command_outbox outbox LEFT JOIN turns ON turns.session_id = outbox.session_id
			AND turns.user_message_id = json_extract(outbox.payload_json, '$.userMessageId')
		WHERE (${sessionId} = '' OR outbox.session_id = ${sessionId}) AND outbox.provider_id = 'claude'
			AND outbox.status = 'running' AND outbox.effect_type = 'send_turn'`;
		for (const row of rows) {
			if (liveSessions.includes(row.session_id)) continue;
			const sinkId = claudeRunnerSinkId(row.command_id, row.attempt_count);
			// A retired owner must never settle a replacement's newer command attempt.
			// With every owner gone and all journals replayed, unseen admission must settle too.
			if (!sinkIds.has(sinkId) && !settleUnclaimedTurns) continue;
			const input = JSON.parse(row.payload_json) as ClaudeSessionTurn;
			const terminal =
				row.state !== null &&
				row.state !== "pending" &&
				row.state !== "running";
			const outcome = completed.get(row.command_id);
			const failure = quarantined
				? {
						operation: "recover stopped runner",
						message: "Claude runner recovery journal was quarantined",
						retryable: false,
					}
				: (outcome?.failure ??
					(row.state === "completed"
						? undefined
						: {
								operation: "recover stopped runner",
								message: "Claude runner stopped before completing the turn",
								retryable: false,
							}));
			let persistenceFailure: ClaudeSessionFailure | undefined;
			yield* failClaudeRunnerTurn(
				(output) =>
					emit(output, row.session_id).pipe(
						Effect.tapError((error) =>
							Effect.sync(() => {
								persistenceFailure = error;
							}),
						),
					),
				sinkId,
				{
					sessionId: row.session_id,
					...(input.userMessageId
						? { userMessageId: input.userMessageId }
						: {}),
					messageId: row.assistant_message_id ?? "",
					terminal,
				},
				failure ?? {
					operation: "recover stopped runner",
					message: "Claude runner stopped",
				},
			);
			if (persistenceFailure) return yield* Effect.fail(persistenceFailure);
			const unsettled =
				yield* sql`SELECT 1 FROM turns WHERE session_id = ${row.session_id} AND user_message_id = ${input.userMessageId ?? ""} AND state IN ('pending', 'running')`;
			if (unsettled.length > 0)
				return yield* new ClaudeRunnerJournalError({
					message: "Retained Claude turn did not settle",
				});
			yield* settleClaudeRunnerCommand(
				sql,
				row.session_id,
				row.command_id,
				row.attempt_count,
				outcome?.result ??
					(row.state === "completed"
						? { status: "completed", providerStateUpdates: [] }
						: undefined),
				failure,
			);
		}
	});

/** Reattach the outbox waiter to its original command, never start a second turn. */
export const recoverClaudeRunnerCommands = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	connection: ClaudeRunnerSocket,
	failTurn: (
		sinkId: string,
		failure: ClaudeSessionFailure,
	) => Effect.Effect<void>,
	preserving: () => boolean,
	deps: ClaudeSessionRunnerDeps,
) =>
	Effect.gen(function* () {
		const rows = yield* sql<{
			command_id: string;
			payload_json: string;
			attempt_count: number;
			assistant_message_id: string | null;
			state: string | null;
		}>`SELECT outbox.command_id, outbox.payload_json, outbox.attempt_count, turns.assistant_message_id, turns.state
			FROM provider_command_outbox outbox
			LEFT JOIN turns ON turns.session_id = outbox.session_id
				AND turns.user_message_id = json_extract(outbox.payload_json, '$.userMessageId')
			WHERE outbox.session_id = ${sessionId} AND outbox.status = 'running' AND outbox.effect_type = 'send_turn'
			ORDER BY outbox.request_sequence`;
		return rows.map((row) => {
			const sinkId = claudeRunnerSinkId(row.command_id, row.attempt_count);
			const input = {
				...(JSON.parse(row.payload_json) as ClaudeSessionTurn),
				commandId: row.command_id,
				commandAttempt: row.attempt_count,
			};
			return {
				sinkId,
				input,
				messageId: row.assistant_message_id ?? "",
				terminal:
					row.state !== null &&
					row.state !== "pending" &&
					row.state !== "running",
				wait: connection
					.commandEffect(
						row.command_id,
						{
							type: "send-turn",
							sinkId,
							aborted: false,
							historyOnDemand: true,
							shellEnv: deps.shellEnv?.(input.workspaceRoot) ?? {
								...process.env,
							},
							claudeSettingsOverrides: deps.claudeSettingsOverrides?.(),
							input: { ...input, history: [] },
						},
						row.attempt_count,
					)
					.pipe(
						Effect.matchEffect({
							onSuccess: (result) =>
								preserving()
									? Effect.void
									: settleClaudeRunnerCommand(
											sql,
											sessionId,
											row.command_id,
											row.attempt_count,
											result,
										),
							onFailure: (failure) =>
								preserving()
									? Effect.void
									: failTurn(sinkId, failure).pipe(
											Effect.andThen(
												settleClaudeRunnerCommand(
													sql,
													sessionId,
													row.command_id,
													row.attempt_count,
													undefined,
													failure,
												),
											),
										),
						}),
					),
			};
		});
	});

const settleClaudeRunnerCommand = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	commandId: string,
	attempt: number,
	result?: Pick<TurnResult, "status" | "providerStateUpdates" | "error">,
	failure?: ClaudeSessionFailure,
) =>
	sql
		.withTransaction(
			Effect.gen(function* () {
				const rows = yield* sql<{
					attempt_count: number;
				}>`SELECT attempt_count FROM provider_command_outbox WHERE command_id = ${commandId} AND session_id = ${sessionId} AND status = 'running' AND attempt_count = ${attempt}`;
				const row = rows[0];
				if (!row) return;
				const succeeded = !failure && result?.status === "completed";
				const retryable =
					failure?.retryable === true || result?.error?.retryable === true;
				const errorCode = succeeded
					? null
					: String(
							failure?.code ??
								result?.error?.code ??
								result?.status ??
								"provider_failure",
						);
				const now = Date.now();
				const retryAt = retryable
					? now + Math.min(1000 * 2 ** row.attempt_count, 30_000)
					: null;
				for (const update of result?.providerStateUpdates ?? [])
					yield* sql`INSERT INTO provider_state (session_id, key, value) VALUES (${sessionId}, ${update.key}, ${String(update.value)}) ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value`;
				yield* sql`UPDATE provider_command_outbox SET status = ${succeeded ? "completed" : retryable ? "retryable_failed" : "failed"}, error_code = ${errorCode}, next_attempt_at = ${retryAt}, updated_at = ${now} WHERE command_id = ${commandId} AND session_id = ${sessionId} AND status = 'running' AND attempt_count = ${attempt}`;
				yield* sql`UPDATE command_receipts SET status = ${succeeded ? "side_effect_completed" : "side_effect_failed"}, error_code = ${errorCode}, updated_at = ${now} WHERE command_id = ${commandId}`;
			}),
		)
		.pipe(Effect.asVoid);
