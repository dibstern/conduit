import { Context, type Effect, type Queue } from "effect";
import type { OrchestrationEngine } from "../../../provider/orchestration-engine.js";
import type { DraftPreWarmTag } from "../../project-services/Services/draft-prewarm.js";
import type { ProviderAdapterRecoveryError } from "./provider-adapters.js";

/** The daemon owns the engine, draft reservations and drain; projects borrow them. */
export class DaemonOrchestration extends Context.Service<
	DaemonOrchestration,
	{
		readonly engine: OrchestrationEngine;
		readonly drafts: DraftPreWarmTag["Service"];
		readonly start: Effect.Effect<void, ProviderAdapterRecoveryError>;
		/** Registered projects the gate found with no services and their folder present (H4). */
		readonly unserved: Queue.Dequeue<string>;
	}
>()("DaemonOrchestration") {}
