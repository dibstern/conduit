import { SqlClient } from "@effect/sql";
import { Effect, Either, Ref } from "effect";
import {
	defaultInstanceIdForDriver,
	type ProviderInstanceId,
} from "../../../contracts/provider-instance.js";
import {
	loadDaemonConfig,
	resolveProviderRoutingDriver,
} from "../../../daemon/config-persistence.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
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
import { loadModelCatalog } from "./model-catalog.js";
import { ConfigTag, OpenCodeModelServiceTag } from "./services.js";
import { SessionManagerError } from "./session-manager-error.js";
import { OverridesStateTag } from "./session-overrides-state.js";

/** Creation and validation use the same provider instance, never the model namespace. */
export const resolveSessionCreationInstance = (options?: {
	readonly instanceId?: ProviderInstanceId;
	readonly providerId?: string;
	readonly sessionId?: string;
}) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const defaults = yield* Ref.get(yield* OverridesStateTag);
		const requested = options?.providerId?.trim();
		const harness = harnessForModelProvider(
			requested === "claude-sdk"
				? "claude"
				: requested || defaults.defaultModel?.providerID || "claude",
		);
		const instanceId =
			options?.instanceId ?? defaultInstanceIdForDriver(harness);
		const driver = resolveProviderRoutingDriver(
			loadDaemonConfig(config.configDir),
			instanceId,
		);
		if (driver !== "claude" && driver !== "opencode")
			return yield* new SessionManagerError({
				operation: "createSession.resolveInstanceDriver",
				cause: `Cannot resolve provider instance: ${instanceId}`,
			});
		return { instanceId, harness: driver } as const;
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
	instanceId: string = harness,
	source?: SessionRow,
	options: { readonly startIfStopped?: boolean } = { startIfStopped: true },
) =>
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const catalog = yield* loadModelCatalog(harness, instanceId, options);
		const models = yield* Effect.serviceOption(OpenCodeModelServiceTag);
		const cached =
			models._tag === "Some"
				? yield* models.value.cachedProviders()
				: undefined;
		const resolved = resolveServerSessionPick(
			harness,
			storedSessionPick(source, harness),
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

/** Fill only NULL pick fields, then let every restart read the session row. */
export const backfillSessionPicks = () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const config = yield* ConfigTag;
		const read = yield* ReadQueryEffectTag;
		const store = yield* EventStoreEffectTag;
		const commit = yield* makeCommitAndSignal;
		const daemonConfig = loadDaemonConfig(config.configDir);
		const missing = yield* sql<{ id: string }>`
		SELECT id FROM sessions WHERE model_id IS NULL OR model_provider IS NULL
			OR variant IS NULL OR context_window IS NULL`;
		let filled = 0;
		for (const { id } of missing) {
			const row = yield* read.getSession(id);
			if (!row) continue;
			const driver = resolveProviderRoutingDriver(daemonConfig, row.provider);
			if (driver !== "claude" && driver !== "opencode") continue;
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
			LEFT JOIN command_receipts r ON r.command_id = COALESCE(u.input_id, t.id) AND r.command_type = 'send_turn'
			LEFT JOIN provider_command_outbox o ON o.request_sequence = COALESCE(r.side_effect_sequence, (
				SELECT old.request_sequence FROM provider_command_outbox old
				WHERE u.input_id IS NULL AND old.session_id = t.session_id AND old.effect_type = 'send_turn'
					AND old.status IN ('running', 'completed', 'failed', 'retryable_failed') AND old.error_code IS NOT 'orphaned'
					AND json_extract(old.payload_json, '$.prompt') = u.text
					AND old.requested_at <= COALESCE(t.started_at, t.requested_at)
				ORDER BY old.request_sequence DESC LIMIT 1
			)) AND o.effect_type = 'send_turn' AND json_valid(o.payload_json)
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
					(driver === "opencode" && separator > 0
						? historicalModel?.slice(separator + 1)
						: historicalModel));
			let pick: TurnPick | undefined;
			// Stored models need no discovery; the next turn validates the completed pick.
			if ((row.model_id != null || turn) && modelId?.trim()) {
				const providerId =
					row.model_provider ??
					(turn?.model_provider ||
						(driver === "claude"
							? "claude"
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
			} else if (!turn && row.model_id == null) {
				const resolved = yield* Effect.either(
					loadServerSessionPick(driver, row.provider, row, {
						startIfStopped: false,
					}),
				);
				if (Either.isLeft(resolved)) continue;
				pick = resolved.right;
			}
			if (!pick) continue;
			const selectedPick = pick;
			filled += yield* commit.write((project) =>
				Effect.gen(function* () {
					const current = yield* read.getSession(id);
					if (!current) return 0;
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
					if (events.length === 0) return 0;
					yield* project(yield* store.appendBatch(events));
					return 1;
				}),
			);
		}
		return filled;
	});
