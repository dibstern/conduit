import { Context, type Effect } from "effect";
import type { OrchestrationEngine } from "../../../provider/orchestration-engine.js";
import type { ProviderAdapterRecoveryError } from "./provider-adapters.js";

/** The daemon owns the engine and drain; relays borrow only the engine. */
export class DaemonOrchestration extends Context.Service<
	DaemonOrchestration,
	{
		readonly engine: OrchestrationEngine;
		readonly start: Effect.Effect<void, ProviderAdapterRecoveryError>;
	}
>()("DaemonOrchestration") {}
