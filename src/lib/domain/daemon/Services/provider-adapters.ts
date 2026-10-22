import { Context, Data, type Effect, type Option, type Scope } from "effect";
import type { SqlClient } from "effect/sql";
import type { ClaudeEventPersistEffectTag } from "../../../persistence/effect/claude-event-persist-effect.js";
import type { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import type { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import type { ProviderStateEffectTag } from "../../../persistence/effect/provider-state-effect.js";
import type { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import type { OrchestrationEngine } from "../../../provider/orchestration-engine.js";
import type { ProviderRegistry } from "../../../provider/provider-registry.js";
import type { PersistenceProjectTag } from "../../persistence/Services/persistence-service.js";
import type { PendingInteractionServiceTag } from "../../relay/Services/pending-interaction-service.js";
import type { ProviderRuntimeIngestionTag } from "../../relay/Services/provider-runtime-ingestion-service.js";
import type { OrchestrationEngineTag } from "../../relay/Services/services.js";
import type { OverridesStateTag } from "../../relay/Services/session-overrides-state.js";
import type { SessionWorkspaceTag } from "../../relay/Services/session-workspace.js";

/** Project-owned services borrowed only while that project's relay is alive. */
export type ProviderAdapterProjectContext =
	| SqlClient.SqlClient
	| PersistenceProjectTag
	| ClaudeEventPersistEffectTag
	| EventStoreEffectTag
	| ProjectionRunnerEffectTag
	| ProviderStateEffectTag
	| ReadQueryEffectTag
	| ProviderRuntimeIngestionTag
	| OrchestrationEngineTag
	| PendingInteractionServiceTag
	| OverridesStateTag
	| SessionWorkspaceTag;

export class ProviderAdapterRecoveryError extends Data.TaggedError(
	"ProviderAdapterRecoveryError",
)<{ readonly operation: string; readonly cause: unknown }> {}

/** One adapter per driver; project sinks are scoped borrows. */
export class ProviderAdapters extends Context.Service<
	ProviderAdapters,
	{
		readonly registry: ProviderRegistry;
		readonly projectContext: (
			projectId: string,
		) => Option.Option<Context.Context<ProviderAdapterProjectContext>>;
		/** Startup relays that must lend their services before recovery can run. */
		readonly recoveryProjects: readonly string[];
		readonly registerProject: (
			projectId: string,
			context: Context.Context<ProviderAdapterProjectContext>,
			onBackgroundWorkChanged?: (sessionId: string) => void,
			ownsPendingSend?: OrchestrationEngine["ownsPendingSend"],
		) => Effect.Effect<void, never, Scope.Scope>;
		readonly projectFailed: (projectId: string) => Effect.Effect<void>;
		readonly recoverDetachedSession: (sessionId: string) => Effect.Effect<void>;
		/** All callers share one daemon-owned recovery fiber and its result. */
		readonly recover: Effect.Effect<void, ProviderAdapterRecoveryError>;
	}
>()("ProviderAdapters") {}
