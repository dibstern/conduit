import { Context, type Effect } from "effect";
import type { OrchestrationEngine } from "../../../provider/orchestration-engine.js";
import type { DraftPreWarmTag } from "../../relay/Services/draft-prewarm.js";
import type { ProviderAdapterRecoveryError } from "./provider-adapters.js";

/** The daemon owns the engine, draft reservations and drain; relays borrow them. */
export class DaemonOrchestration extends Context.Service<
	DaemonOrchestration,
	{
		readonly engine: OrchestrationEngine;
		readonly drafts: DraftPreWarmTag["Service"];
		readonly start: Effect.Effect<void, ProviderAdapterRecoveryError>;
	}
>()("DaemonOrchestration") {}
