import { SqlClient } from "@effect/sql";
import { Effect, Either } from "effect";
import type { Account } from "../../../contracts/account.js";
import { PROVIDER_DRIVERS } from "../../../contracts/provider-instance.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import type { SessionRow } from "../../../persistence/read-model-types.js";
import {
	type Harness,
	harnessDefaultPick,
	harnessForModelProvider,
	ModelNotInCatalog,
	type PickRejection,
	PickRequired,
	resolveTurnSettings,
	type TurnPick,
	type TurnSettings,
} from "../../../provider/turn-settings.js";
import type { ModelInfo } from "../../../provider/types.js";
import { loadRelaySettings } from "../../../relay/relay-settings.js";
import { AccountDirectory } from "../../daemon/Services/account-directory.js";
import { loadModelCatalog } from "./model-catalog.js";
import { ConfigTag, OpenCodeModelServiceTag } from "./services.js";

/** Creation and validation use the same provider instance, never the model namespace. */
export const resolveSessionCreationInstance = (options?: {
	readonly account?: Account;
}) =>
	Effect.gen(function* () {
		const account =
			options?.account ??
			(yield* (yield* AccountDirectory).resolve({
				_tag: "DriverDefault",
				driver: "claude",
			}));
		return { account, instanceId: account.id, harness: account.driver };
	});

export const storedSessionPick = (
	row:
		| Pick<
				SessionRow,
				"model_id" | "model_provider" | "variant" | "context_window"
		  >
		| undefined,
	harness: Harness,
): TurnPick | undefined =>
	row?.model_id?.trim() &&
	row.model_provider?.trim() &&
	row.variant != null &&
	row.context_window != null
		? {
				harness,
				model: { modelId: row.model_id, providerId: row.model_provider },
				effort: row.variant,
				contextWindow: row.context_window,
			}
		: undefined;

/** Every server creator chooses its source pick before its harness default. */
export const resolveServerSessionPick = (
	harness: Harness,
	source?: TurnPick,
	defaultPick?: TurnPick,
	catalog?: readonly ModelInfo[],
): Either.Either<TurnSettings, PickRejection> => {
	const pick = source ?? defaultPick;
	if (!pick) return Either.left(new PickRequired());
	if (
		pick.harness !== harness ||
		harnessForModelProvider(pick.model.providerId) !== harness
	)
		return Either.left(new ModelNotInCatalog({ harness, ...pick.model }));
	return catalog === undefined
		? Either.right(pick)
		: resolveTurnSettings(pick, catalog);
};

/** Discovery is needed for fresh defaults; persistence can inherit an existing pick. */
export const loadServerSessionPick = (
	harness: Harness,
	instanceId?: string,
	source?: SessionRow,
	options: { readonly startIfStopped?: boolean } = { startIfStopped: true },
) =>
	Effect.gen(function* () {
		const sourcePick = storedSessionPick(source, harness);
		if (source && !sourcePick) return yield* new PickRequired();
		const account = yield* (yield* AccountDirectory).resolve(
			instanceId === undefined
				? { _tag: "DriverDefault", driver: harness }
				: { _tag: "Id", id: instanceId },
		);
		const config = yield* ConfigTag;
		const catalog = yield* loadModelCatalog(harness, account.id, options);
		const models = yield* Effect.serviceOption(OpenCodeModelServiceTag);
		const cached =
			models._tag === "Some"
				? yield* models.value.cachedProviders(account.id)
				: undefined;
		const resolved = resolveServerSessionPick(
			harness,
			sourcePick,
			harnessDefaultPick(
				harness,
				loadRelaySettings(config.configDir),
				cached?._tag === "Some" ? cached.value.nativeDefaultModel : undefined,
			),
			catalog,
		);
		if (Either.isLeft(resolved)) return yield* resolved.left;
		return resolved.right;
	});

/** These join session.created in the creator's transaction. */
export const sessionPickEvents = (sessionId: string, pick: TurnSettings) => [
	canonicalEvent(
		"session.model_changed",
		sessionId,
		{
			sessionId,
			modelId: pick.model.modelId,
			providerId: pick.model.providerId,
		},
		{ metadata: { source: "relay" } },
	),
	canonicalEvent(
		"session.variant_changed",
		sessionId,
		{
			sessionId,
			variant: pick.effort,
		},
		{ metadata: { source: "relay" } },
	),
	canonicalEvent(
		"session.context_window_changed",
		sessionId,
		{
			sessionId,
			contextWindow: pick.contextWindow,
		},
		{ metadata: { source: "relay" } },
	),
];

/** Consume the migration's legacy repairs; only recoverable rows remain queued. */
export const backfillSessionPicks = () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const store = yield* EventStoreEffectTag;
		const [repairState] = yield* sql<{ initialized: number }>`
			SELECT initialized FROM session_pick_backfill_state WHERE singleton = 1`;
		if (repairState?.initialized === 0) {
			const projectionRunner = yield* ProjectionRunnerEffectTag;
			if (!(yield* projectionRunner.isRecovered()))
				yield* projectionRunner.recover();
			yield* sql.withTransaction(
				Effect.gen(function* () {
					const [current] = yield* sql<{ initialized: number }>`
					SELECT initialized FROM session_pick_backfill_state WHERE singleton = 1`;
					if (current?.initialized === 1) return;
					// The flag is daemon-wide, so queue every project's sessions:
					// each relay drains only its own rows below.
					yield* sql`INSERT OR IGNORE INTO session_pick_backfill (session_id)
					SELECT id FROM sessions WHERE model_id IS NULL OR model_provider IS NULL
						OR variant IS NULL OR context_window IS NULL`;
					yield* sql`UPDATE session_pick_backfill_state SET initialized = 1 WHERE singleton = 1`;
				}),
			);
		}
		const missing = yield* sql<{
			id: string;
			provider: string;
			retry_reason: string;
		}>`
			SELECT s.id, s.provider, b.retry_reason FROM session_pick_backfill b
			JOIN sessions s ON s.id = b.session_id
			WHERE s.project_id = ${store.projectId}`;
		if (missing.length === 0) return 0;
		const read = yield* ReadQueryEffectTag;
		const commit = yield* makeCommitAndSignal;
		const accounts = yield* AccountDirectory;
		let filled = 0;
		for (const { id, provider, retry_reason } of missing) {
			const resolved = yield* Effect.either(
				accounts.resolve({ _tag: "Id", id: provider }),
			);
			if (Either.isLeft(resolved)) {
				if (retry_reason !== "driver_unresolved")
					yield* sql`UPDATE session_pick_backfill SET retry_reason = 'driver_unresolved' WHERE session_id = ${id}`;
				continue;
			}
			const driver = resolved.right.driver;
			const row = yield* read.getSession(id);
			if (!row) continue;
			if (storedSessionPick(row, driver)) {
				yield* sql`DELETE FROM session_pick_backfill WHERE session_id = ${id}`;
				continue;
			}
			const [turn] = yield* sql<{
				model_id: string | null;
				model_provider: string | null;
				requested_model: string | null;
				actual_model: string | null;
				expected_model: string | null;
				variant: string | null;
				context_window: string | null;
			}>`
			SELECT COALESCE(json_extract(o.payload_json, '$.model.modelId'),
				json_extract(u.rest_payload, '$.model.modelID'), json_extract(a.rest_payload, '$.modelID')) AS model_id,
				COALESCE(json_extract(o.payload_json, '$.model.providerId'),
					json_extract(u.rest_payload, '$.model.providerID'), json_extract(a.rest_payload, '$.providerID')) AS model_provider,
				t.requested_model, t.actual_model, t.expected_model,
				COALESCE(json_extract(o.payload_json, '$.variant'),
					json_extract(u.rest_payload, '$.model.variant'), json_extract(a.rest_payload, '$.variant')) AS variant,
				json_extract(o.payload_json, '$.contextWindow') AS context_window
			FROM turns t
			LEFT JOIN messages u ON u.id = t.user_message_id
			LEFT JOIN messages a ON a.id = t.assistant_message_id
			LEFT JOIN command_receipts r ON r.command_id = COALESCE(u.input_id, t.id) AND r.command_type = 'send_turn' AND r.project_key = ${store.projectId}
			LEFT JOIN provider_command_outbox o ON o.request_sequence = COALESCE(r.side_effect_sequence, (
				SELECT old.request_sequence FROM provider_command_outbox old
				WHERE old.project_key = ${store.projectId} AND u.input_id IS NULL AND old.session_id = t.session_id AND old.effect_type = 'send_turn'
					AND old.status IN ('running', 'completed', 'failed', 'retryable_failed') AND old.error_code IS NOT 'orphaned'
					AND json_extract(old.payload_json, '$.prompt') = u.text
					AND old.requested_at <= COALESCE(t.started_at, t.requested_at)
				ORDER BY old.request_sequence DESC LIMIT 1
			)) AND o.project_key = ${store.projectId} AND o.effect_type = 'send_turn' AND json_valid(o.payload_json)
			WHERE t.session_id = ${id}
				AND (t.started_at IS NOT NULL OR t.assistant_message_id IS NOT NULL OR o.status IN ('running', 'completed'))
			ORDER BY t.requested_at DESC, t.rowid DESC LIMIT 1`;
			const historicalModel =
				turn?.model_id ||
				turn?.requested_model ||
				turn?.actual_model ||
				turn?.expected_model;
			const separator = historicalModel?.indexOf("/") ?? -1;
			const modelId =
				row.model_id ??
				(turn?.model_id ||
					(PROVIDER_DRIVERS[driver].modelIdFormat === "provider-qualified" &&
					separator > 0
						? historicalModel?.slice(separator + 1)
						: historicalModel));
			let pick: TurnPick | undefined;
			// Stored models need no discovery; the next turn validates the completed pick.
			if ((row.model_id != null || turn) && modelId?.trim()) {
				const providerId =
					row.model_provider ??
					(turn?.model_provider ||
						(PROVIDER_DRIVERS[driver].modelIdFormat === "context-window-suffix"
							? driver
							: separator > 0
								? historicalModel?.slice(0, separator)
								: undefined));
				if (providerId)
					pick = {
						harness: driver,
						model: {
							providerId,
							modelId,
						},
						effort: row.variant ?? turn?.variant ?? "",
						contextWindow: row.context_window ?? turn?.context_window ?? "",
					};
			}
			if (!pick) {
				// No stored/history pick can be recovered. The picker handles these.
				yield* sql`DELETE FROM session_pick_backfill WHERE session_id = ${id}`;
				continue;
			}
			const selectedPick = pick;
			filled += yield* commit.write((project) =>
				Effect.gen(function* () {
					const current = yield* read.getSession(id);
					if (!current) {
						yield* sql`DELETE FROM session_pick_backfill WHERE session_id = ${id}`;
						return 0;
					}
					const events = sessionPickEvents(id, {
						...selectedPick,
						model: {
							modelId: current.model_id ?? selectedPick.model.modelId,
							providerId:
								current.model_provider ?? selectedPick.model.providerId,
						},
						effort: current.variant ?? selectedPick.effort,
						contextWindow: current.context_window ?? selectedPick.contextWindow,
					}).filter((event) =>
						event.type === "session.model_changed"
							? current.model_id === null || current.model_provider === null
							: event.type === "session.variant_changed"
								? current.variant === null
								: current.context_window === null,
					);
					if (events.length === 0) {
						yield* sql`DELETE FROM session_pick_backfill WHERE session_id = ${id}`;
						return 0;
					}
					yield* project(yield* store.appendBatch(events));
					yield* sql`DELETE FROM session_pick_backfill WHERE session_id = ${id}`;
					return 1;
				}),
			);
		}
		return filled;
	});
