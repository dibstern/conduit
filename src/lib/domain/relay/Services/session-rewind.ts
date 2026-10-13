import { SqlClient } from "@effect/sql";
import { Data, Effect } from "effect";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import { ClaudeEventPersistEffectTag } from "../../../persistence/effect/claude-event-persist-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { ConfigTag, LoggerTag } from "./services.js";
import { SessionInboxTag } from "./session-inbox.js";
import { hasActiveProcessingTimeout } from "./session-overrides-state.js";

export class RewindTargetNotFound extends Data.TaggedError(
	"RewindTargetNotFound",
)<{
	readonly sessionId: string;
	readonly messageId: string;
	readonly message: string;
}> {}

export class RewindUnavailable extends Data.TaggedError("RewindUnavailable")<{
	readonly sessionId: string;
	readonly message: string;
}> {}

const readRewindSession = (sessionId: string) =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const row = yield* readQuery.getSession(sessionId);
		if (!row)
			return yield* new RewindUnavailable({
				sessionId,
				message: "Session not found",
			});
		const sql = yield* SqlClient.SqlClient;
		const [busy] = yield* sql<{ busy: number }>`SELECT
		EXISTS (SELECT 1 FROM pending_inputs WHERE session_id = ${sessionId} AND state IN ('queued', 'steering'))
		OR EXISTS (SELECT 1 FROM provider_command_outbox WHERE session_id = ${sessionId}
			AND effect_type = 'send_turn' AND status IN ('pending', 'running', 'retryable_failed'))
		OR EXISTS (SELECT 1 FROM pending_approvals WHERE session_id = ${sessionId} AND status = 'pending')
		OR EXISTS (SELECT 1 FROM sessions WHERE id = ${sessionId}
			AND pending_rewind_message_id IS NULL
			AND (json_extract(limit_recovery, '$.cutOffMessageId') IS NOT NULL
				OR json_extract(limit_recovery, '$.scheduledAt') IS NOT NULL)) AS busy`;
		if (
			row.status === "busy" ||
			row.status === "retry" ||
			busy?.busy === 1 ||
			(yield* hasActiveProcessingTimeout(sessionId))
		)
			return yield* new RewindUnavailable({
				sessionId,
				message:
					"Stop the current turn and clear queued inputs or pending continuations before rewinding",
			});
		const config = yield* ConfigTag;
		const driver = resolveProviderRoutingDriver(
			loadDaemonConfig(config.configDir),
			row.provider,
		);
		if (driver !== "opencode" && driver !== "claude")
			return yield* new RewindUnavailable({
				sessionId,
				message: "This provider does not support rewind",
			});
		return { row, driver };
	});

export const rewindSessionToMessage = ({
	clientId,
	sessionId,
	messageId,
}: {
	clientId: string;
	sessionId: string;
	messageId: string;
}) =>
	Effect.gen(function* () {
		const inbox = yield* SessionInboxTag;
		yield* inbox.withSession(
			sessionId,
			Effect.gen(function* () {
				const { row, driver } = yield* readRewindSession(sessionId);
				const sql = yield* SqlClient.SqlClient;
				const [target] = yield* sql<{ id: string }>`SELECT id FROM messages
				WHERE session_id = ${sessionId} AND id = ${messageId}`;
				if (!target)
					return yield* new RewindTargetNotFound({
						sessionId,
						messageId,
						message: `Rewind target ${messageId} not found in session ${sessionId}`,
					});
				if (row.pending_rewind_message_id === messageId) return;
				if (driver === "opencode") {
					yield* Effect.scoped(
						Effect.gen(function* () {
							const instances =
								yield* Effect.serviceOption(OpenCodeInstancesTag);
							const client =
								instances._tag === "Some"
									? yield* instances.value.use(row.provider)
									: yield* OpenCodeAPITag;
							yield* Effect.tryPromise(() =>
								client.session.revert(sessionId, { messageID: messageId }),
							);
						}),
					);
				}
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* persist.persistEvent(
					canonicalEvent(
						"session.rewound",
						sessionId,
						{
							messageId,
							previousMessageId: row.pending_rewind_message_id ?? null,
						},
						{ provider: row.provider },
					),
				);
				const log = yield* LoggerTag;
				log.info(
					`client=${clientId} session=${sessionId} Rewound to message: ${messageId}`,
				);
			}),
		);
	});

export const undoSessionRewind = ({
	clientId,
	sessionId,
}: {
	clientId: string;
	sessionId: string;
}) =>
	Effect.gen(function* () {
		const inbox = yield* SessionInboxTag;
		yield* inbox.withSession(
			sessionId,
			Effect.gen(function* () {
				const { row, driver } = yield* readRewindSession(sessionId);
				if (!row.pending_rewind_message_id)
					return yield* new RewindUnavailable({
						sessionId,
						message: "There is no pending rewind to undo",
					});
				if (driver === "opencode") {
					yield* Effect.scoped(
						Effect.gen(function* () {
							const instances =
								yield* Effect.serviceOption(OpenCodeInstancesTag);
							const client =
								instances._tag === "Some"
									? yield* instances.value.use(row.provider)
									: yield* OpenCodeAPITag;
							yield* Effect.tryPromise(() =>
								client.session.unrevert(sessionId),
							);
						}),
					);
				}
				const persist = yield* ClaudeEventPersistEffectTag;
				yield* persist.persistEvent(
					canonicalEvent(
						"session.rewind_undone",
						sessionId,
						{ previousMessageId: row.pending_rewind_message_id },
						{ provider: row.provider },
					),
				);
				const log = yield* LoggerTag;
				log.info(`client=${clientId} session=${sessionId} Undid rewind`);
			}),
		);
	});
